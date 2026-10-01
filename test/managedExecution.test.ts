import { expect, it } from "vitest";
import { ManagedExecution } from "../src/managedExecution.js";
const start = { id: "cmd", type: "commandExecution", command: "true", cwd: "/fixture", status: "inProgress", processId: "p" };
const end = { ...start, status: "completed", exitCode: 0 };
function run() {
  const state = new ManagedExecution();
  state.observe("item/started", { item: start });
  return state;
}
it("requires correlated terminal item evidence, never output prose", () => {
  const state = run();
  state.observe("item/commandExecution/outputDelta", { itemId: "cmd", delta: "exit code 0" });
  expect(state.finish({ status: "completed", items: [end] })).toBe(false);
});
it.each([
  { ...end, exitCode: undefined }, { ...end, exitCode: null }, { ...end, exitCode: 1 },
  { ...end, status: "inProgress" }, { ...end, command: "different" }, { ...end, cwd: "/other" },
  { ...end, processId: "other" }, { id: "cmd", type: "unknown" }
])("rejects incomplete/contradictory process evidence %j", value => {
  const state = run(); state.observe("item/completed", { item: value });
  expect(state.finish({ status: "completed", items: [value] })).toBe(false);
});
it("rejects completion without start, duplicate and late start", () => {
  for (const events of [[end], [start, end, start], [start, end, end]]) {
    const state = new ManagedExecution();
    for (const item of events) state.observe(item.status === "inProgress" ? "item/started" : "item/completed", { item });
    expect(state.finish({ status: "completed", items: [end] })).toBe(false);
  }
});
it.each(["notLoaded"])("rejects incomplete terminal history %s", itemsView => {
  const state = run(); state.observe("item/completed", { item: end });
  expect(state.finish({ status: "completed", itemsView, items: [end] })).toBe(false);
});
it("accepts native command output and stops accepting events at terminal boundary", () => {
  const state = run(); state.observe("item/completed", { item: end });
  expect(state.finish({ status: "completed", items: [end] })).toBe(true);
  state.observe("item/started", { item: { ...start, id: "late" } });
  expect(state.clean).toBe(false);
});
it.each(["exec", "wait", "tool_search"])("does not mistake output-only code mode/deferred %s for process completion", name => {
  const state = new ManagedExecution();
  const item = { type: "functionCallOutput", id: "output", name, namespace: "functions", output: "Script completed; exit code 0" };
  state.observe("item/completed", { item });
  expect(state.finish({ status: "completed", items: [item] })).toBe(false);
});

it("reconciles summary against the live ledger, including a known failed attempt", () => {
  const state = run(); state.observe("item/completed", { item: { ...end, status: "failed", exitCode: 127 } });
  state.observe("item/started", { item: { ...start, id: "retry" } });
  state.observe("item/completed", { item: { ...end, id: "retry" } });
  expect(state.finish({ status: "completed", itemsView: "summary", items: [{ id: "reply", type: "agentMessage", text: "done" }] })).toBe(true);
});
it("summary never substitutes for missing terminal evidence", () => {
  expect(run().finish({ status: "completed", itemsView: "summary", items: [] })).toBe(false);
});
