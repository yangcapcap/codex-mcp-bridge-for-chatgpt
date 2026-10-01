import type Database from "better-sqlite3";
import type { CodexUpstream } from "./upstream.js";
import { BackgroundWorkSlice, CONNECTION_WORK_LIMITS } from "./backgroundWorkBudget.js";
import { shutdownResult, type ShutdownResult } from "./shutdown.js";

export type ThreadPersistence = "persistent" | "ephemeral" | "unknown";
export type ThreadConnectionPhase = "connected" | "waiting" | "releasing" | "unsubscribed" | "released" | "blocked";
export type ThreadReleaseEvidence = "thread-unloaded" | "worker-exited";
export type ThreadConnectionRecord = {
  threadId: string;
  agentId?: string;
  scopeId: string;
  persistence: ThreadPersistence;
  phase: ThreadConnectionPhase;
  handoffRequested: boolean;
  lastFinishedAt?: number;
  lastJobId?: string;
  workerPid?: number;
  revision: number;
  updatedAt: number;
  reason?: string;
  evidence?: ThreadReleaseEvidence;
};

export type ThreadReleaseResult = {
  phase: "blocked" | "unsubscribed" | "released";
  reason?: string;
  evidence?: ThreadReleaseEvidence;
  releasedThreadIds?: string[];
};

export type ThreadReleaseOptions = {
  /** Rechecked against authoritative state immediately before each unsubscribe or process close. */
  canRelease: (threadId: string) => boolean | Promise<boolean>;
  eligibleThreadIds: readonly string[];
  previousWorkerPid?: number;
};

/** Upgrade-only schema introduced at v14. Current databases use stateSchema.ts. */
export const V14_THREAD_CONNECTION_MIGRATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS thread_connections (
    thread_id TEXT PRIMARY KEY, agent_id TEXT, scope_id TEXT NOT NULL,
    persistence TEXT NOT NULL CHECK(persistence IN ('persistent','ephemeral','unknown')),
    phase TEXT NOT NULL, handoff_requested INTEGER NOT NULL DEFAULT 0,
    last_finished_at INTEGER, last_job_id TEXT, worker_pid INTEGER,
    revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
    reason TEXT, evidence TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS thread_connections_idle ON thread_connections(phase, last_finished_at);
  CREATE INDEX IF NOT EXISTS thread_connections_agent ON thread_connections(agent_id);
`;

/** Durable connection intent is independent of Agent/Job outcome and UI reads. */
export class ThreadConnectionStore {
  constructor(private readonly db: Database.Database) {}

  get(threadId: string): ThreadConnectionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM thread_connections WHERE thread_id = ?").get(threadId);
    return row ? this.decode(row as Record<string, unknown>) : undefined;
  }

  list(): ThreadConnectionRecord[] {
    return this.db.prepare("SELECT * FROM thread_connections ORDER BY updated_at, thread_id").all()
      .map(row => this.decode(row as Record<string, unknown>));
  }

  listForAgent(agentId: string): ThreadConnectionRecord[] {
    return this.db.prepare("SELECT * FROM thread_connections WHERE agent_id=? ORDER BY thread_id")
      .all(agentId).map(row => this.decode(row as Record<string, unknown>));
  }

  /** Worker peers are considered only during a verified release, never in an
   * ordinary candidate survey. The caller must revalidate each peer. */
  listForWorker(workerPid: number, limit = 32, excludingThreadId = ""): ThreadConnectionRecord[] {
    return this.db.prepare(`SELECT * FROM thread_connections WHERE worker_pid=?
      AND persistence='persistent' AND phase NOT IN ('released','releasing') AND thread_id!=?
      ORDER BY thread_id LIMIT ?`).all(workerPid, excludingThreadId, Math.max(1, Math.min(32, Math.floor(limit))))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  *protectedThreadIds(): IterableIterator<string> {
    // This safety pass must finish before admitting turns, but only projected
    // IDs are visited and no all-record array is retained at startup.
    const rows = this.db.prepare(`SELECT thread_id FROM thread_connections INDEXED BY thread_connections_protected
      WHERE handoff_requested=1 OR phase!='connected'`).iterate() as IterableIterator<{thread_id:string}>;
    for (const row of rows) yield row.thread_id;
  }

  handoffCandidates(afterThreadId: string, limit = 16): ThreadConnectionRecord[] {
    return this.db.prepare(`SELECT * FROM thread_connections
      WHERE handoff_requested=1 AND phase!='released' AND thread_id>?
      ORDER BY thread_id LIMIT ?`).all(afterThreadId, Math.max(1, Math.min(16, Math.floor(limit))))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  idleCandidates(after: {finishedAt:number;threadId:string}, dueAt: number, limit = 16): ThreadConnectionRecord[] {
    return this.db.prepare(`SELECT * FROM thread_connections INDEXED BY thread_connections_release_due
      WHERE persistence='persistent' AND phase!='released' AND last_finished_at<=?
        AND (last_finished_at>? OR (last_finished_at=? AND thread_id>?))
      ORDER BY last_finished_at,thread_id LIMIT ?`).all(
        dueAt,after.finishedAt,after.finishedAt,after.threadId,Math.max(1, Math.min(16, Math.floor(limit))))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  register(input: { threadId: string; agentId?: string; scopeId: string; persistence?: ThreadPersistence; workerPid?: number }, now = Date.now()): void {
    const previous = this.get(input.threadId);
    const persistence = input.persistence === "unknown" || !input.persistence
      ? previous?.persistence || "unknown" : input.persistence;
    if (previous && previous.persistence !== "unknown" && persistence !== previous.persistence) {
      throw new Error("THREAD_PERSISTENCE_CONFLICT: Existing conversation storage cannot be changed in place.");
    }
    this.db.prepare(`INSERT INTO thread_connections(thread_id,agent_id,scope_id,persistence,phase,worker_pid,updated_at)
      VALUES (?,?,?,?,'connected',?,?) ON CONFLICT(thread_id) DO UPDATE SET
      agent_id=COALESCE(excluded.agent_id,thread_connections.agent_id),scope_id=excluded.scope_id,
      persistence=excluded.persistence,worker_pid=COALESCE(excluded.worker_pid,thread_connections.worker_pid)`).run(
      input.threadId, input.agentId || null, input.scopeId, persistence, input.workerPid || null, now);
  }

  assertAdmission(agentId?: string, threadId?: string): void {
    const blocked = this.db.prepare(`SELECT 1 FROM thread_connections
      WHERE (thread_id = ? OR agent_id = ?) AND (phase = 'releasing' OR (handoff_requested = 1 AND phase != 'released')) LIMIT 1`)
      .get(threadId || null, agentId || null);
    if (blocked) throw new Error("AGENT_HANDOFF_PENDING: Conversation release is pending. Wait for it or cancel the handoff before starting another turn.");
  }

  supersedeHandoffs(agentId: string, currentThreadId: string, now: number): void {
    this.db.prepare(`UPDATE thread_connections SET handoff_requested=0,phase='blocked',reason='target-changed',evidence=NULL,
      revision=revision+1,updated_at=? WHERE agent_id=? AND thread_id!=? AND handoff_requested=1 AND phase!='releasing'`)
      .run(now,agentId,currentThreadId);
  }

  /** Called in the same transaction that commits the actual Job transition. */
  recordJob(job: {
    jobId: string; agentId?: string; scopeId: string; backendKind?: string; threadId?: string;
    sessionDecision?: { threadId?: string }; status: string; updatedAt: number;
    workerPid?: number; upstreamRequestId?: string; threadPersistence?: ThreadPersistence;
    terminalOrigin?: string;
    error?: string;
  }, previousStatus?: string): void {
    const threadId = job.threadId || job.sessionDecision?.threadId;
    if (!threadId || job.backendKind !== "app-server") return;
    this.register({ threadId, agentId: job.agentId, scopeId: job.scopeId,
      persistence: job.threadPersistence, workerPid: job.workerPid }, job.updatedAt);
    if (job.status === "failed" && job.error?.startsWith("THREAD_EXTERNALLY_OWNED")) {
      this.update(threadId, {phase:"blocked",reason:"external-owner"}, job.updatedAt);
    }
    if (job.status === "running" && previousStatus === undefined) {
      this.db.prepare(`UPDATE thread_connections SET phase='connected',handoff_requested=0,reason=NULL,evidence=NULL,
        revision=revision+1,updated_at=? WHERE thread_id=?`).run(job.updatedAt, threadId);
    }
    if (["completed", "failed", "interrupted", "cancelled"].includes(job.status) &&
      previousStatus !== undefined && !["completed", "failed", "interrupted", "cancelled"].includes(previousStatus) && job.upstreamRequestId && job.terminalOrigin !== "bridge-restart") {
      this.db.prepare(`UPDATE thread_connections SET last_finished_at=?,last_job_id=?,revision=revision+1,updated_at=?
        WHERE thread_id=?`).run(job.updatedAt, job.jobId, job.updatedAt, threadId);
    }
  }

  hasUnfinishedWork(threadId: string): boolean {
    return Boolean(this.db.prepare(THREAD_UNFINISHED_WORK_SQL).get(threadId, threadId, threadId));
  }

  update(threadId: string, patch: Pick<ThreadConnectionRecord, "phase"> & Partial<Pick<ThreadConnectionRecord, "handoffRequested" | "reason" | "evidence">>, now = Date.now(), expectedRevision?: number): ThreadConnectionRecord | undefined {
    const previous = this.get(threadId);
    if (!previous || expectedRevision !== undefined && previous.revision !== expectedRevision) return undefined;
    this.db.prepare(`UPDATE thread_connections SET phase=?,handoff_requested=?,reason=?,evidence=?,revision=revision+1,updated_at=?
      WHERE thread_id=? AND revision=?`).run(patch.phase, Number(patch.handoffRequested ?? previous.handoffRequested),
      patch.reason || null, patch.evidence || null, now, threadId, previous.revision);
    return this.get(threadId);
  }

  requestHandoff(threadId: string, now = Date.now()): ThreadConnectionRecord {
    const current = this.get(threadId);
    if (!current) throw new Error("THREAD_CONNECTION_UNKNOWN: This conversation has no retained connection evidence.");
    if (current.handoffRequested) return current;
    return this.update(threadId, { phase: current.phase === "released" ? "released" : "waiting", handoffRequested: true,
      evidence: current.evidence }, now)!;
  }

  cancelHandoff(threadId: string, now = Date.now()): ThreadConnectionRecord {
    const current = this.get(threadId);
    if (!current) throw new Error("THREAD_CONNECTION_UNKNOWN");
    if (current.phase === "releasing") throw new Error("THREAD_RELEASE_IN_PROGRESS: Release is already being checked; retry shortly.");
    return this.update(threadId, { phase: ["unsubscribed", "released"].includes(current.phase) ? current.phase : "connected",
      handoffRequested: false, evidence: current.evidence }, now)!;
  }

  private decode(row: Record<string, unknown>): ThreadConnectionRecord {
    return { threadId: String(row.thread_id), scopeId: String(row.scope_id),
      ...(row.agent_id ? { agentId: String(row.agent_id) } : {}),
      persistence: row.persistence as ThreadPersistence, phase: row.phase as ThreadConnectionPhase,
      handoffRequested: row.handoff_requested === 1, revision: Number(row.revision), updatedAt: Number(row.updated_at),
      ...(row.last_finished_at !== null ? { lastFinishedAt: Number(row.last_finished_at) } : {}),
      ...(row.last_job_id ? { lastJobId: String(row.last_job_id) } : {}),
      ...(row.worker_pid ? { workerPid: Number(row.worker_pid) } : {}),
      ...(row.reason ? { reason: String(row.reason) } : {}),
      ...(row.evidence ? { evidence: row.evidence as ThreadReleaseEvidence } : {}) };
  }
}

export const DEFAULT_THREAD_IDLE_MS = 6 * 60 * 60_000;

export const THREAD_UNFINISHED_WORK_SQL = `WITH candidate_jobs AS (
  SELECT job_id,activity_id,status FROM jobs
   WHERE thread_id=? AND archived_at IS NULL
  UNION ALL
  SELECT job_id,activity_id,status FROM jobs
   WHERE source_thread_id=? AND archived_at IS NULL
  UNION ALL
  -- The history index includes archived Jobs; release eligibility only reads active Jobs.
  SELECT job_id,activity_id,status FROM jobs INDEXED BY jobs_agent_active
   WHERE agent_id=(SELECT agent_id FROM thread_connections WHERE thread_id=?)
     AND archived_at IS NULL
)
SELECT 1 FROM candidate_jobs j
 WHERE j.status IN ('running','terminating','termination-failed')
    OR EXISTS (SELECT 1 FROM job_interactions interaction
      WHERE interaction.job_id=j.job_id AND interaction.is_blocking=1)
    OR EXISTS (SELECT 1 FROM cancellation_intents cancellation
      WHERE (cancellation.target_job_id=j.job_id OR
        (cancellation.target_kind='activity' AND cancellation.target_activity_id=j.activity_id))
      AND cancellation.status IN ('recorded','dispatched'))
 LIMIT 1`;

export class ThreadConnectionController {
  lastError?: string;
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private sweepCursor = "";
  private idleCursor = {finishedAt:0,threadId:""};
  private idleFirst = false;
  private closed = false;
  private nonforcingPinned = false;
  private nonforcingUnknown = false;
  private readonly now: () => number;

  constructor(private readonly store: ThreadConnectionStore, private readonly upstream: CodexUpstream,
    private readonly options: { idleMs?: number; intervalMs?: number; now?: () => number; changed?: () => void } = {}) {
    this.now = options.now || Date.now;
  }

  start(): void {
    if (this.timer || this.closed) return;
    const intervalMs = this.options.intervalMs ?? 30_000;
    if (this.closed) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647)
      throw new Error("STATE_BACKGROUND_INTERVAL_INVALID");
    for (const threadId of this.store.protectedThreadIds()) {
      if (this.nonforcingPinned) return;
      const protect = this.upstream.protectThreadFromImplicitResume;
      if (this.nonforcingPinned) return;
      if (protect && Reflect.apply(protect, this.upstream, [threadId]) !== undefined) this.nonforcingUnknown = true;
    }
    if (this.nonforcingPinned) return;
    this.timer = setInterval(() => { void this.sweep(); }, intervalMs);
    this.timer.unref();
    void this.sweep();
  }

  request(threadId: string): ThreadConnectionRecord {
    if (this.nonforcingPinned) throw new Error("NONFORCING_SHUTDOWN_PINNED");
    const observedAt = this.now();
    if (this.nonforcingPinned) throw new Error("NONFORCING_SHUTDOWN_PINNED");
    const current = this.store.requestHandoff(threadId, observedAt);
    this.publishChanges();
    void this.sweep();
    return current;
  }

  cancel(threadId: string): ThreadConnectionRecord {
    if (this.nonforcingPinned) throw new Error("NONFORCING_SHUTDOWN_PINNED");
    const observedAt = this.now();
    if (this.nonforcingPinned) throw new Error("NONFORCING_SHUTDOWN_PINNED");
    const current = this.store.cancelHandoff(threadId, observedAt);
    this.publishChanges();
    return current;
  }

  sweep(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    let resolve!: () => void;
    const pending = new Promise<void>(done => {resolve = done;});
    this.pending = pending;
    // Publish the original work handle before callbacks can reenter the fence.
    void this.runSweep().catch(error => {
      if (this.nonforcingPinned) this.nonforcingUnknown = true;
      this.lastError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
      resolve();
    });
    return pending;
  }

  private eligible(record: ThreadConnectionRecord): boolean {
    const idleMs = this.options.idleMs ?? DEFAULT_THREAD_IDLE_MS;
    return record.persistence === "persistent" && !this.store.hasUnfinishedWork(record.threadId) &&
      (record.handoffRequested || idleMs > 0 && record.lastFinishedAt !== undefined && this.now() - record.lastFinishedAt >= idleMs);
  }

  private async runSweep(): Promise<void> {
    const budget = new BackgroundWorkSlice(CONNECTION_WORK_LIMITS);
    let handoffs = this.store.handoffCandidates(this.sweepCursor, 16);
    if (!handoffs.length && this.sweepCursor) {
      this.sweepCursor = "";
      handoffs = this.store.handoffCandidates("", 16);
    }
    const idleMs = this.options.idleMs ?? DEFAULT_THREAD_IDLE_MS;
    let idle = idleMs > 0
      ? this.store.idleCandidates(this.idleCursor, this.now() - idleMs, 16) : [];
    if (!idle.length && this.idleCursor.finishedAt > 0 && idleMs > 0) {
      this.idleCursor = {finishedAt:0,threadId:""};
      idle = this.store.idleCandidates(this.idleCursor, this.now() - idleMs, 16);
    }
    // Rotate lanes within and across sweeps. A repeatedly unconfirmed handoff
    // must not prevent an eligible idle connection from being attempted.
    const candidatesById = new Map<string, ThreadConnectionRecord>();
    const lanes = this.idleFirst ? [idle,handoffs] : [handoffs,idle];
    this.idleFirst = !this.idleFirst;
    for (let index = 0; index < Math.max(handoffs.length,idle.length); index++) {
      for (const lane of lanes) {
        const record = lane[index];
        if (record) candidatesById.set(record.threadId, record);
      }
    }
    const candidates = [...candidatesById.values()];
    const handoffIds = new Set(handoffs.map(record => record.threadId));
    const idleIds = new Set(idle.map(record => record.threadId));
    // A loaded peer is only ever acted on after canRelease rechecks the exact
    // durable connection. This list may contain a protected peer safely.
    const eligibleThreadIds = candidates.map(record => record.threadId);
    for (const initial of candidates) {
      if (this.closed || !budget.take(6)) return;
      if (handoffIds.has(initial.threadId)) this.sweepCursor = initial.threadId;
      if (idleIds.has(initial.threadId)) this.idleCursor = {
        finishedAt:initial.lastFinishedAt!,threadId:initial.threadId
      };
      if (budget.targets % budget.limits.yieldEvery === 0) await budget.yieldIfNeeded();
      if (this.nonforcingPinned) return;
      const current = this.store.get(initial.threadId)!;
      if (current.phase === "released") continue;
      const reason = current.persistence !== "persistent" ? current.persistence === "ephemeral" ? "ephemeral" : "persistence-unknown"
        : this.store.hasUnfinishedWork(current.threadId) ? "active-work" : !this.upstream.releaseThreadConnection ? "unsupported" : undefined;
      if (this.nonforcingPinned) return;
      if (reason) {
        if (current.phase !== "blocked" || current.reason !== reason) {
          const updatedAt = this.now();
          if (this.nonforcingPinned) return;
          this.store.update(current.threadId, { phase: "blocked", reason }, updatedAt);
          this.publishChanges();
        }
        continue;
      }
      if (!this.eligible(current)) continue;
      if (this.nonforcingPinned) return;
      const releaseStartedAt = this.now();
      if (this.nonforcingPinned) return;
      const releasing = this.store.update(current.threadId, { phase: "releasing" }, releaseStartedAt, current.revision);
      if (!releasing) continue;
      const canRelease = (threadId: string) => {
        if (this.closed) return false;
        const row = this.store.get(threadId);
        const eligible = Boolean(row && this.eligible(row));
        return !this.closed && eligible;
      };
      let result: ThreadReleaseResult;
      try {
        const release = this.upstream.releaseThreadConnection!;
        if (this.nonforcingPinned) return;
        result = await budget.awaitExternal(Reflect.apply(release, this.upstream, [current.threadId, { eligibleThreadIds, canRelease, previousWorkerPid: current.workerPid }]));
      } catch { result = { phase: "blocked", reason: "release-unconfirmed" }; }
      if (this.closed) return;
      const retainedResult = snapshotThreadReleaseResult(result);
      if (this.nonforcingPinned) return;
      if (!retainedResult) {this.nonforcingUnknown = true; return;}
      result = retainedResult;
      // An acknowledgement alone never becomes proof of unload or relinquished writing.
      if (result.phase === "released" && !result.evidence) result = { phase: "blocked", reason: "release-unconfirmed" };
      const releasedAt = this.now();
      if (this.nonforcingPinned) return;
      this.store.update(current.threadId, result, releasedAt, releasing.revision);
      if (result.evidence) for (const threadId of result.releasedThreadIds || []) {
        if (this.nonforcingPinned) return;
        if (threadId !== current.threadId && canRelease(threadId)) {
          const peerReleasedAt = this.now();
          if (this.nonforcingPinned) return;
          this.store.update(threadId, { phase: "released", evidence: result.evidence }, peerReleasedAt);
        }
      }
      this.publishChanges();
    }
  }

  async close(): Promise<void> {
    if (this.nonforcingPinned) { await this.pending; return; }
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }

  /** Internal writer fence; it never publishes connection-release evidence. */
  pinNonforcingShutdown(): true {
    if (this.nonforcingPinned) return true;
    this.nonforcingUnknown ||= this.closed;
    this.nonforcingPinned = true;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return true;
  }

  private publishChanges(): void {
    if (this.nonforcingPinned) return;
    const changed = this.options.changed;
    if (this.nonforcingPinned) return;
    if (changed && Reflect.apply(changed, this.options, []) !== undefined) this.nonforcingUnknown = true;
  }

  observeNonforcingExit(): ShutdownResult {
    if (!this.nonforcingPinned || this.nonforcingUnknown) return shutdownResult("uncertain");
    return this.pending ? shutdownResult("timeout", 1) : shutdownResult("exited");
  }
}

function snapshotThreadReleaseResult(value: ThreadReleaseResult): ThreadReleaseResult | undefined {
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = ["phase", "reason", "evidence", "releasedThreadIds"];
    if (!Object.hasOwn(fields,"phase") || keys.some(key => Object.hasOwn(fields,key) && !Object.hasOwn(fields[key],"value"))) return;
    const result = Object.fromEntries(keys.filter(key => Object.hasOwn(fields,key)).map(key => [key,fields[key].value]));
    if (!["blocked","unsubscribed","released"].includes(result.phase) ||
        result.reason !== undefined && typeof result.reason !== "string" ||
        result.evidence !== undefined && !["thread-unloaded","worker-exited"].includes(result.evidence)) return;
    if (result.releasedThreadIds !== undefined) {
      if (!Array.isArray(result.releasedThreadIds)) return;
      const slots = Object.getOwnPropertyDescriptors(result.releasedThreadIds) as Record<string,PropertyDescriptor>;
      const length = slots.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 128 || Reflect.ownKeys(slots).length !== length + 1) return;
      const ids: string[] = [];
      for (let index=0; index<length; index++) {
        const slot = slots[String(index)];
        if (!slot || !Object.hasOwn(slot,"value") || typeof slot.value !== "string") return;
        ids.push(slot.value);
      }
      result.releasedThreadIds = Object.freeze(ids);
    }
    return Object.freeze(result) as ThreadReleaseResult;
  } catch {return;}
}
