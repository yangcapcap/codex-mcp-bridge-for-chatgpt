import { createHash } from "node:crypto";
import type { BridgeStateStore } from "./stateStore.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

export const JOB_TERMINAL_EVENT = "codex.job.terminal";
const PREFIX = "mcp_events_v1/";
export const MAX_EVENT_SUBSCRIPTIONS = 256;
export const MAX_JOB_EVENT_SUBSCRIPTIONS = 8;
export const EVENT_RESULT_RECOVERY_MS = 24 * 60 * 60 * 1_000;

export type EventJob = {
  jobId: string;
  scopeId: string;
  activityId?: string;
  agentId?: string;
  projectId?: string;
  mcpPrincipal?: string;
  status: string;
  terminalVersion?: number;
  version?: number;
  updatedAt: number;
};

export type JobTerminalEvent = {
  eventId: string;
  name: typeof JOB_TERMINAL_EVENT;
  timestamp: string;
  data: {
    jobId: string;
    activityId: string | null;
    agentId: string | null;
    state: string;
    terminalVersion: number;
    result: { tool: "codex_status"; query: { kind: "job"; id: string } };
  };
  cursor: null;
};

export type EventSubscription = {
  id: string;
  jobId: string;
  scopeId: string;
  principal: string;
  /** AES-GCM protected callback URL and signing keys; never a tool result. */
  destination: string;
  revision: number;
  expiresAt: number;
  verifiedAt: number;
  disabled?: "unsubscribed" | "revoked" | "gone";
  event?: JobTerminalEvent;
  delivery: "waiting" | "pending" | "acknowledged" | "failed";
  attempts: number;
  nextAttemptAt: number;
  acknowledgedAt?: number;
  lastStatus?: number;
  /** Receipt is not review: keep the result through this recovery boundary. */
  recoverUntil?: number;
};

/** Small bounded subscription journal owned by the existing State UoW. It is
 * independent of diagnostic events, native notifications and card ACKs. No new
 * SQLite connection, writer, schema inference or execution loop is involved. */
export class McpEventStore {
  constructor(private readonly state: BridgeStateStore) {}

  list(jobId?: string): EventSubscription[] {
    return this.state.listMeta(PREFIX + (jobId ? `${jobId}/` : ""), MAX_EVENT_SUBSCRIPTIONS + 1)
      .map(({ value }) => parseJsonTextStrict(value, "MCP event subscription") as EventSubscription);
  }

  get(jobId: string, id: string): EventSubscription | undefined {
    const raw = this.state.getMeta(this.key(jobId, id));
    return raw === undefined ? undefined : parseJsonTextStrict(raw, "MCP event subscription") as EventSubscription;
  }

  save(record: EventSubscription): void {
    const existing = this.get(record.jobId, record.id);
    if (!existing && (this.list().length >= MAX_EVENT_SUBSCRIPTIONS ||
        this.list(record.jobId).length >= MAX_JOB_EVENT_SUBSCRIPTIONS)) {
      throw new Error("EVENT_SUBSCRIPTION_CAPACITY: Subscription capacity is full.");
    }
    this.state.setMeta(this.key(record.jobId, record.id), JSON.stringify(record));
  }

  /** Called inside the exact Job terminal transaction, and during late subscribe.
   * A process failure cannot commit a result without its active delivery intent. */
  enqueue(job: EventJob): void {
    if (!job.terminalVersion || !["completed", "failed", "interrupted", "cancelled"].includes(job.status)) return;
    for (const record of this.list(job.jobId)) {
      if (record.disabled || record.expiresAt <= Date.now() || record.event) continue;
      record.event = {
        eventId: "evt_" + createHash("sha256").update(`${JOB_TERMINAL_EVENT}\0${job.scopeId}\0${job.jobId}\0${job.terminalVersion}`).digest("hex"),
        name: JOB_TERMINAL_EVENT,
        timestamp: new Date(job.updatedAt).toISOString(),
        data: {
          jobId: job.jobId,
          activityId: job.activityId || null,
          agentId: job.agentId || null,
          state: job.status,
          terminalVersion: job.terminalVersion,
          result: { tool: "codex_status", query: { kind: "job", id: job.jobId } }
        },
        cursor: null
      };
      record.delivery = "pending";
      record.nextAttemptAt = 0;
      record.recoverUntil = Math.max(record.expiresAt, Date.now() + EVENT_RESULT_RECOVERY_MS);
      this.save(record);
    }
  }

  protectsResult(jobId: string, now: number): boolean {
    return this.list(jobId).some(record => (record.recoverUntil || 0) > now ||
      !record.disabled && record.expiresAt > now);
  }

  /** No ACK releases a result. Finite recovery and subscription lifetimes bound
   * retention; unsubscribe/revocation never cancels or deletes the original Job. */
  maintain(now = Date.now()): void {
    for (const record of this.list()) {
      if (record.expiresAt <= now && (record.recoverUntil || 0) <= now) {
        this.state.deleteMeta(this.key(record.jobId, record.id));
      }
    }
  }

  private key(jobId: string, id: string): string { return `${PREFIX}${jobId}/${id}`; }
}
