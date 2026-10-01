import { describe, expect, test } from "vitest";
import { CoGateWorkspaceExecutionEvidence, type CoGateWorkspaceExecutionBinding } from "../src/cogateWorkspaceExecutionEvidence.js";

const binding: CoGateWorkspaceExecutionBinding = { workspaceId: "workspace", jobId: "job", activityId: "activity",
  agentId: "agent", scopeId: "scope", executionEnvelopeRef: "current-envelope", threadId: "thread", turnId: "turn",
  workerId: "worker", workerGeneration: 3, executionNamespace: "namespace" };
const start = { id: "command", type: "commandExecution", command: "true", cwd: "/fixture", status: "inProgress", processId: "process" };
const end = { ...start, status: "completed", exitCode: 0 };
const envelope = (sequence: number, event: object, supplied = binding) => JSON.stringify({
  format: "cogate-workspace-execution-event/v1", binding: supplied, sequence, event });
const observe = (method: string, item: object) => ({ type: "observe", method,
  params: { threadId: binding.threadId, turnId: binding.turnId, item } });
const terminal = (items: object[] = [end]) => ({ type: "terminal", turn: { id: binding.turnId, status: "completed", items } });
function tracker() { return new CoGateWorkspaceExecutionEvidence(JSON.stringify(binding)); }
function clean() {
  const result = tracker(); result.record(envelope(1, observe("item/started", start)));
  result.record(envelope(2, observe("item/completed", end))); result.record(envelope(3, terminal())); return result;
}

describe("generation-bound Workspace execution evidence", () => {
  test("records correlated protocol evidence separately from worker closure and cleanup", () => {
    expect(clean().snapshot()).toMatchObject({ binding, sequence: 3, terminal: true, protocol: "matched-ledger",
      managed: { clean: true }, uncertaintyReasons: [], workerClosureVerification: "not-performed", cleanupAuthorized: false, authority: "none" });
  });
  test.each(Object.keys(binding))("retains uncertainty on mismatched %s", key => {
    const result = tracker(); const wrong = { ...binding, [key]: key === "workerGeneration" ? 4 : "different" };
    expect(result.record(envelope(1, observe("item/started", start), wrong))).toBe(false);
    expect(result.snapshot()).toMatchObject({ sequence: 0, protocol: "unverified", uncertaintyReasons: ["EVENT_LINEAGE"] });
    result.record(envelope(1, observe("item/started", start))); result.record(envelope(2, observe("item/completed", end)));
    result.record(envelope(3, terminal())); expect(result.snapshot().protocol).toBe("unverified");
  });
  test.each([0, 2, 1.5, -1, "1"])("rejects out-of-order sequence %s", sequence => {
    const result = tracker(); const raw = JSON.parse(envelope(1, observe("item/started", start))); raw.sequence = sequence;
    expect(result.record(JSON.stringify(raw))).toBe(false); expect(result.snapshot().managed.invalid).toBe(true);
  });
  test("duplicate delivery and late events cannot rewrite terminal evidence", () => {
    for (const result of [tracker(), clean()]) {
      const sequence = result.snapshot().sequence + 1;
      result.record(envelope(sequence, observe("item/started", start)));
      expect(result.record(envelope(sequence, observe("item/started", start)))).toBe(false);
      expect(result.snapshot().protocol).toBe("unverified");
    }
    const result = clean(); expect(result.record(envelope(4, observe("item/completed", end)))).toBe(false);
    expect(result.snapshot().uncertaintyReasons).toContain("LATE_EVENT");
  });
  test("does not infer completion from output prose or turn status", () => {
    const result = tracker(); result.record(envelope(1, observe("item/started", start)));
    result.record(envelope(2, { type: "observe", method: "item/commandExecution/outputDelta",
      params: { threadId: binding.threadId, turnId: binding.turnId, itemId: "command", delta: "exit code 0; all workers exited" } }));
    expect(result.record(envelope(3, terminal()))).toBe(false);
    expect(result.snapshot()).toMatchObject({ protocol: "unverified", cleanupAuthorized: false });
  });
  test.each(["threadId", "turnId"])("requires event-local %s correlation", key => {
    const result = tracker(); const event = observe("item/started", start);
    Object.assign(event.params, { [key]: "other" }); expect(result.record(envelope(1, event))).toBe(false);
  });
  test("requires terminal turn correlation even with a matching outer binding", () => {
    const result = tracker(); const event = terminal(); event.turn.id = "other";
    expect(result.record(envelope(1, event))).toBe(false);
  });
  test.each(["output-only", "unrecognized", "pending-approval"])("unsupported %s evidence preserves uncertainty", kind => {
    const result = tracker(); const event = kind === "output-only"
      ? observe("item/completed", { type: "functionCallOutput", id: "output", output: "finished" })
      : { type: kind };
    expect(result.record(envelope(1, event))).toBe(false); expect(result.snapshot().protocol).toBe("unverified");
  });
  test("retains correlated declined command evidence without granting execution permission", () => {
    const result = tracker(); const declined = { ...start, status: "declined", processId: null };
    expect(result.record(envelope(1, { type: "approval-declined", itemId: "command" }))).toBe(true);
    expect(result.record(envelope(2, observe("item/completed", declined)))).toBe(true);
    expect(result.record(envelope(3, terminal([declined])))).toBe(true);
    expect(result.snapshot()).toMatchObject({ protocol: "matched-ledger", authority: "none", cleanupAuthorized: false });
  });
  test("rejects duplicate keys and escaped unpaired surrogates", () => {
    for (const raw of [envelope(1, terminal([])).replace('"sequence":1', '"sequence":1,"sequence":1'),
      envelope(1, terminal([])).replace('"turnId":"turn"', '"turnId":"\\ud800"')]) {
      const result = tracker(); expect(result.record(raw)).toBe(false); expect(result.snapshot().sequence).toBe(0);
    }
  });
  test("rejects duplicate escaped keys inside bindings, params and nested items", () => {
    const raw = envelope(1, observe("item/started", start));
    for (const bad of [raw.replace('"workerGeneration":3', '"workerGeneration":3,"worker\\u0047eneration":3'),
      raw.replace('"id":"command"', '"id":"other","id":"command"'),
      raw.replace('"turnId":"turn","item"', '"turnId":"other","turnId":"turn","item"')]) {
      const result = tracker(); expect(result.record(bad)).toBe(false); expect(result.snapshot().sequence).toBe(0);
    }
    expect(() => new CoGateWorkspaceExecutionEvidence(JSON.stringify(binding)
      .replace('"jobId":"job"', '"jobId":"other","jobId":"job"'))).toThrow();
  });
  test("rejects malformed/extra binding fields at construction", () => {
    for (const supplied of [{ ...binding, workerGeneration: 0 }, { ...binding, extra: true },
      { ...binding, threadId: "" }, { ...binding, executionNamespace: "namespace\0other" }]) {
      expect(() => new CoGateWorkspaceExecutionEvidence(JSON.stringify(supplied))).toThrow();
    }
  });
  test("external snapshot mutation cannot replace private lineage or clean state", () => {
    const result = clean(); const snapshot = result.snapshot(); snapshot.binding.workerGeneration = 99;
    snapshot.managed.items.length = 0; snapshot.uncertaintyReasons.push("forged");
    expect(result.snapshot()).toMatchObject({ binding: { workerGeneration: 3 }, protocol: "matched-ledger", uncertaintyReasons: [] });
    Object.assign(result, { terminal: false, managed: {}, binding: { ...binding, workerGeneration: 99 }, reasons: new Set() });
    expect(result.record(envelope(4, terminal([])))).toBe(false); expect(result.snapshot().protocol).toBe("unverified");
  });
  test("bounds a single input before parsing", () => {
    const result = tracker(); expect(result.record(" ".repeat(65537))).toBe(false);
    expect(result.snapshot().uncertaintyReasons).toContain("EVENT_CAPACITY");
  });
  test("bounds the number of events without evicting retained uncertainty", () => {
    const result = tracker(); result.record(envelope(1, observe("item/started", start)));
    const event = { type: "observe", method: "item/commandExecution/outputDelta",
      params: { threadId: binding.threadId, turnId: binding.turnId, itemId: "command", delta: "" } };
    for (let index = 2; index <= 4096; index++) expect(result.record(envelope(index, event))).toBe(true);
    expect(result.record(envelope(4097, terminal()))).toBe(false); expect(result.snapshot().sequence).toBe(4096);
  });
  test("bounds aggregate input bytes before event count exhaustion", () => {
    const result = tracker(); result.record(envelope(1, observe("item/started", start)));
    const event = { type: "observe", method: "item/commandExecution/outputDelta",
      params: { threadId: binding.threadId, turnId: binding.turnId, itemId: "command", delta: "x".repeat(60000) } };
    let index = 2; while (index < 200 && result.record(envelope(index, event))) index++;
    expect(index).toBeLessThan(200); expect(result.snapshot().uncertaintyReasons).toContain("EVENT_CAPACITY");
  });
});
