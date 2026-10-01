import { ManagedExecution } from "./managedExecution.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

export type CoGateWorkspaceExecutionBinding = Readonly<{
  workspaceId: string; jobId: string; activityId: string; agentId: string;
  scopeId: string; executionEnvelopeRef: string;
  threadId: string; turnId: string; workerId: string;
  workerGeneration: number; executionNamespace: string;
}>;
const bindingKeys = ["workspaceId", "jobId", "activityId", "agentId", "scopeId",
  "executionEnvelopeRef", "threadId", "turnId", "workerId", "workerGeneration", "executionNamespace"] as const;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 4096;
const methods = new Set(["item/started", "item/completed", "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction", "error", "warning"]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function binding(value: unknown): CoGateWorkspaceExecutionBinding {
  if (!exact(value, bindingKeys) || !Number.isSafeInteger(value.workerGeneration) ||
      Number(value.workerGeneration) < 1 || bindingKeys.filter(key => key !== "workerGeneration").some(key =>
        typeof value[key] !== "string" || !(value[key] as string).length ||
        (value[key] as string).length > 4096 || /[\u0000-\u001f\u007f]/.test(value[key] as string))) {
    throw new Error("WORKSPACE_EXECUTION_BINDING_INVALID");
  }
  return Object.freeze(Object.fromEntries(bindingKeys.map(key => [key, value[key]]))) as CoGateWorkspaceExecutionBinding;
}

/** In-memory execution-owner component for the upcoming typed Workspace IPC.
 * Serialized events are data, not authenticated commands. A current owner must
 * independently establish the binding from its admitted Job/assignment before
 * using this component. This class cannot write SQL, release a writer, certify
 * worker/descendant closure, authorize cleanup or enable a runtime. */
export class CoGateWorkspaceExecutionEvidence {
  readonly #binding: CoGateWorkspaceExecutionBinding;
  readonly #managed = new ManagedExecution();
  readonly #reasons = new Set<string>();
  #sequence = 0;
  #bytes = 0;
  #terminal = false;

  constructor(bindingText: string) {
    if (typeof bindingText !== "string" || Buffer.byteLength(bindingText) > MAX_EVENT_BYTES) {
      throw new Error("WORKSPACE_EXECUTION_BINDING_INVALID");
    }
    this.#binding = binding(parseEventJson(bindingText));
  }

  /** A rejected event permanently retains uncertainty. Sequence gaps, retries,
   * mismatched generations and events after terminal are never replayed clean. */
  record(eventText: string): boolean {
    try {
      if (typeof eventText !== "string") throw new Error("WORKSPACE_EVENT_INVALID");
      const bytes = Buffer.byteLength(eventText);
      if (bytes > MAX_EVENT_BYTES || this.#bytes + bytes > MAX_JOURNAL_BYTES || this.#sequence >= MAX_EVENTS) {
        return this.#reject("EVENT_CAPACITY");
      }
      const envelope = parseEventJson(eventText);
      if (!exact(envelope, ["format", "binding", "sequence", "event"]) ||
          envelope.format !== "cogate-workspace-execution-event/v1" ||
          envelope.sequence !== this.#sequence + 1) return this.#reject("EVENT_SEQUENCE_OR_FORMAT");
      const supplied = binding(envelope.binding);
      if (bindingKeys.some(key => supplied[key] !== this.#binding[key])) return this.#reject("EVENT_LINEAGE");
      if (this.#terminal) return this.#reject("LATE_EVENT");
      const event = envelope.event;
      if (!record(event)) return this.#reject("EVENT_INVALID");
      if (event.type === "observe") {
        if (!exact(event, ["type", "method", "params"]) || typeof event.method !== "string" ||
            !methods.has(event.method) || !record(event.params) ||
            event.params.threadId !== this.#binding.threadId || event.params.turnId !== this.#binding.turnId) {
          return this.#reject("EVENT_PAYLOAD");
        }
        this.#managed.observe(event.method, event.params);
      } else if (event.type === "approval-declined") {
        if (!exact(event, ["type", "itemId"]) || typeof event.itemId !== "string" || !event.itemId || event.itemId.length > 4096) {
          return this.#reject("EVENT_PAYLOAD");
        }
        this.#managed.approval(event.itemId); this.#managed.denyApproval(event.itemId);
      } else if (event.type === "terminal") {
        if (!exact(event, ["type", "turn"]) || !record(event.turn) || event.turn.id !== this.#binding.turnId) {
          return this.#reject("EVENT_PAYLOAD");
        }
        this.#terminal = true;
        if (!this.#managed.finish(event.turn)) this.#reasons.add("PROTOCOL_UNVERIFIED");
      } else return this.#reject("EVENT_UNSUPPORTED");
      this.#sequence++; this.#bytes += bytes;
      if (this.#managed.snapshot().invalid) this.#reasons.add("PROTOCOL_UNVERIFIED");
      return this.#reasons.size === 0;
    } catch { return this.#reject("EVENT_INVALID"); }
  }

  snapshot() {
    const managed = this.#managed.snapshot();
    return { format: "cogate-workspace-execution-evidence/v1" as const,
      binding: { ...this.#binding }, sequence: this.#sequence,
      terminal: this.#terminal,
      protocol: this.#reasons.size === 0 && ManagedExecution.verifies(managed) ? "matched-ledger" as const : "unverified" as const,
      managed, uncertaintyReasons: [...this.#reasons],
      // Even a clean terminal ledger says nothing about OS descendants or a
      // generation-bound worker closure. That separate owner proof is pending.
      workerClosureVerification: "not-performed" as const,
      cleanupAuthorized: false as const, authority: "none" as const };
  }

  #reject(reason: string): false {
    this.#reasons.add(reason); this.#managed.block(); return false;
  }
}

function parseEventJson(raw: string): unknown {
  const value = parseJsonTextStrict(raw, "Workspace execution evidence");
  // Grammar and Unicode are checked first. Scan every original object before
  // accepting last-member-wins decoding; escaped spellings share the same key.
  const stack: Array<{ object: boolean; expectsKey: boolean; keys: Set<string> }> = [];
  for (let index = 0; index < raw.length; index++) {
    const token = raw[index];
    if (token === '"') {
      let end = index + 1;
      while (end < raw.length && raw[end] !== '"') end += raw[end] === "\\" ? 2 : 1;
      const current = stack.at(-1);
      if (current?.object && current.expectsKey) {
        const key = JSON.parse(raw.slice(index, end + 1)) as string;
        if (current.keys.has(key)) throw new Error("WORKSPACE_EVENT_DUPLICATE_MEMBER");
        current.keys.add(key); current.expectsKey = false;
      }
      index = end;
    } else if (token === "{" || token === "[") {
      stack.push({ object: token === "{", expectsKey: token === "{", keys: new Set() });
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && stack.at(-1)?.object) stack.at(-1)!.expectsKey = true;
  }
  return value;
}
