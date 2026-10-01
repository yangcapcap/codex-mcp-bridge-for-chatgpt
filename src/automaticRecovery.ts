import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { BackgroundWorkSlice, RECOVERY_WORK_LIMITS } from "./backgroundWorkBudget.js";
import { shutdownResult, type ShutdownResult } from "./shutdown.js";

export type AutomaticRecoveryKind = "recheck" | "retry-stop" | "release";
export type AutomaticRecoveryState = "retrying" | "resolved" | "blocked";
export type AutomaticRecoveryRecord = {
  key: string; scopeId: string; agentId: string; jobId?: string;
  kind: AutomaticRecoveryKind; state: AutomaticRecoveryState;
  attempts: number; createdAt: number; updatedAt: number; nextAttemptAt: number;
  reason: string; evidence?: string;
};
export type AutomaticRecoveryCandidate = Pick<AutomaticRecoveryRecord, "key" | "scopeId" | "agentId" | "jobId" | "kind">;
export type AutomaticRecoveryResult = { resolved: boolean; reason: string; evidence?: string; retryable?: boolean };
export const AUTOMATIC_RECOVERY_ATTEMPTS = 3;
const RETRY_DELAYS = [5_000, 30_000, 120_000];

/** Upgrade-only schema introduced at v17. Current databases use stateSchema.ts. */
export const V17_AUTOMATIC_RECOVERY_MIGRATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS automatic_recovery (
    recovery_key TEXT PRIMARY KEY, scope_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    job_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('recheck','retry-stop','release')),
    state TEXT NOT NULL CHECK(state IN ('retrying','resolved','blocked')),
    attempts INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, reason TEXT NOT NULL, evidence TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS automatic_recovery_scope ON automatic_recovery(scope_id,updated_at);
  CREATE INDEX IF NOT EXISTS automatic_recovery_job ON automatic_recovery(job_id);
  CREATE TABLE IF NOT EXISTS automatic_recovery_incidents (
    identity_key TEXT PRIMARY KEY, recovery_key TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), updated_at INTEGER NOT NULL
  ) STRICT;
`;

export function automaticRecoveryKey(kind: AutomaticRecoveryKind, identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(["automatic-recovery-v1", kind, identity])).digest("hex");
}

/** Attempts are committed before dispatch, so restarting cannot reset a limit
 * or interpret an interrupted dispatch as evidence of successful cleanup. */
export class AutomaticRecoveryStore {
  constructor(private readonly db: Database.Database) {}

  blockedKeys(): Set<string> {
    return new Set((this.db.prepare(
      "SELECT recovery_key FROM automatic_recovery WHERE state='blocked'"
    ).all() as Array<{ recovery_key: string }>).map(row => row.recovery_key));
  }

  isBlocked(key: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM automatic_recovery WHERE recovery_key=? AND state='blocked'").get(key));
  }

  isBlockedRecheckIdentity(identityKey: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM automatic_recovery_incidents incident
      JOIN automatic_recovery recovery ON recovery.recovery_key=incident.recovery_key
      WHERE incident.identity_key=? AND incident.active=1 AND recovery.state='blocked'`).get(identityKey));
  }

  pendingForAgent(agentId: string, afterKey = "", limit = 32): AutomaticRecoveryRecord[] {
    return this.db.prepare(`SELECT * FROM automatic_recovery WHERE agent_id=? AND state='retrying'
      AND recovery_key>? ORDER BY recovery_key LIMIT ?`)
      .all(agentId,afterKey,Math.max(1,Math.min(32,Math.floor(limit))))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  dueAgentIds(now: number, limit = 4): string[] {
    const rows = this.db.prepare(`SELECT agent_id FROM automatic_recovery
      WHERE state='retrying' AND next_attempt_at<=? AND attempts<?
      ORDER BY next_attempt_at,recovery_key LIMIT ?`).all(
        now,AUTOMATIC_RECOVERY_ATTEMPTS,Math.max(1,Math.min(4,Math.floor(limit)))) as Array<{agent_id:string}>;
    return [...new Set(rows.map(row => row.agent_id))];
  }

  blockedRecheckIdentityKeys(): Set<string> {
    return new Set((this.db.prepare(`SELECT incident.identity_key FROM automatic_recovery_incidents incident
      JOIN automatic_recovery recovery ON recovery.recovery_key=incident.recovery_key
      WHERE incident.active=1 AND recovery.state='blocked'`)
      .all() as Array<{ identity_key: string }>).map(row => row.identity_key));
  }

  get(key: string): AutomaticRecoveryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM automatic_recovery WHERE recovery_key=?").get(key);
    return row ? this.decode(row as Record<string, unknown>) : undefined;
  }

  list(scopeId?: string): AutomaticRecoveryRecord[] {
    return this.db.prepare(`SELECT * FROM automatic_recovery ${scopeId ? "WHERE scope_id=?" : ""}
      ORDER BY updated_at DESC,recovery_key`).all(...(scopeId ? [scopeId] : []))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  /** Dashboard projection excludes references whose retained Job history has
   * expired, so the selected page can hydrate exact Job IDs after pagination. */
  listForDashboard(scopeId?: string): AutomaticRecoveryRecord[] {
    return this.db.prepare(`SELECT recovery.* FROM automatic_recovery recovery
      WHERE ${scopeId ? "recovery.scope_id=? AND" : ""}
        (recovery.job_id IS NULL OR EXISTS (
          SELECT 1 FROM jobs job WHERE job.job_id=recovery.job_id
            AND NOT EXISTS (
              SELECT 1 FROM work_history_state history
               WHERE history.job_id=job.job_id AND history.expired_at IS NOT NULL
            )
        ))
      ORDER BY recovery.updated_at DESC,recovery.recovery_key`)
      .all(...(scopeId ? [scopeId] : []))
      .map(row => this.decode(row as Record<string, unknown>));
  }

  /** Fresh inspection transitions define incidents; retries and cached reads
   * do not. Keep each incident's journal and retry budget across restarts. */
  observeRecheck(candidate: AutomaticRecoveryCandidate, problem: boolean, now: number, evidence?: string): void {
    if (candidate.kind !== "recheck") throw new Error("Only runtime rechecks have inspection incidents.");
    if (!problem && !evidence) throw new Error("A confirmed runtime observation requires evidence.");
    this.db.transaction(() => {
      const incident = this.incident(candidate.key);
      const previous = this.get(incident?.recovery_key || candidate.key);
      if (!problem && !incident && !previous) return;
      const active = incident ? Boolean(incident.active) : previous?.state !== "resolved";
      const key = problem && !active
        ? automaticRecoveryKey("recheck",[candidate.key,previous?.key || incident!.recovery_key,randomUUID()])
        : incident?.recovery_key || candidate.key;
      this.db.prepare(`INSERT INTO automatic_recovery_incidents(identity_key,recovery_key,agent_id,active,updated_at)
        VALUES (?,?,?,?,?) ON CONFLICT(identity_key) DO UPDATE SET recovery_key=excluded.recovery_key,
          active=excluded.active,updated_at=excluded.updated_at`)
        .run(candidate.key,key,candidate.agentId,problem ? 1 : 0,now);
      if (!problem && previous && previous.state !== "resolved") this.confirm(previous.key,"runtime-confirmed",evidence!,now);
    })();
  }

  recheckCandidate(candidate: AutomaticRecoveryCandidate, discover = false): AutomaticRecoveryCandidate | undefined {
    const incident = this.incident(candidate.key);
    if (incident) return incident.active ? {...candidate,key:incident.recovery_key} : undefined;
    // Version 16 journals used the work identity itself as the incident key.
    const legacy = this.get(candidate.key);
    if (legacy) return legacy.state !== "resolved" ? candidate : undefined;
    if (!discover) return;
    this.observeRecheck(candidate,true,Date.now());
    return candidate;
  }

  private incident(identityKey: string): {recovery_key:string;active:number} | undefined {
    return this.db.prepare("SELECT recovery_key,active FROM automatic_recovery_incidents WHERE identity_key=?")
      .get(identityKey) as {recovery_key:string;active:number} | undefined;
  }

  begin(candidate: AutomaticRecoveryCandidate, now: number): AutomaticRecoveryRecord | undefined {
    const previous = this.get(candidate.key);
    if (previous && (previous.state !== "retrying" || previous.attempts >= AUTOMATIC_RECOVERY_ATTEMPTS || previous.nextAttemptAt > now)) return;
    const attempts = (previous?.attempts || 0) + 1;
    this.db.prepare(`INSERT INTO automatic_recovery
      (recovery_key,scope_id,agent_id,job_id,kind,state,attempts,created_at,updated_at,next_attempt_at,reason)
      VALUES (?,?,?,?,?,'retrying',?,?,?,?, 'inspection-pending')
      ON CONFLICT(recovery_key) DO UPDATE SET state='retrying',attempts=excluded.attempts,
        updated_at=excluded.updated_at,next_attempt_at=excluded.next_attempt_at,reason=excluded.reason,evidence=NULL`)
      .run(candidate.key,candidate.scopeId,candidate.agentId,candidate.jobId || null,candidate.kind,
        attempts,previous?.createdAt || now,now,now + RETRY_DELAYS[attempts - 1]!);
    return this.get(candidate.key);
  }

  canBegin(candidate: AutomaticRecoveryCandidate, now: number): boolean {
    const previous = this.get(candidate.key);
    return !previous || previous.state === "retrying" &&
      previous.attempts < AUTOMATIC_RECOVERY_ATTEMPTS && previous.nextAttemptAt <= now;
  }

  finish(key: string, attempt: number, result: AutomaticRecoveryResult, now: number): void {
    this.db.transaction(() => {
      const confirmed = result.resolved && Boolean(result.evidence);
      const updated = this.db.prepare(`UPDATE automatic_recovery SET state=?,updated_at=?,reason=?,evidence=?
        WHERE recovery_key=? AND attempts=? AND state='retrying'`).run(
        confirmed ? "resolved" : result.retryable === false || attempt >= AUTOMATIC_RECOVERY_ATTEMPTS ? "blocked" : "retrying",
        now,result.resolved && !confirmed ? "recovery-unconfirmed" : result.reason,confirmed ? result.evidence! : null,key,attempt);
      if (confirmed && updated.changes) this.closeIncident(key,now);
    })();
  }

  reconcileInterrupted(now: number, limit = 32): number {
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    return this.db.prepare(`UPDATE automatic_recovery SET state='blocked',updated_at=?,reason='recovery-interrupted',evidence=NULL
      WHERE recovery_key IN (SELECT recovery_key FROM automatic_recovery
        WHERE state='retrying' AND attempts>=? ORDER BY recovery_key LIMIT ?)`)
      .run(now,AUTOMATIC_RECOVERY_ATTEMPTS,boundedLimit).changes;
  }

  confirm(key: string, reason: string, evidence: string, now: number): void {
    if (!evidence) throw new Error("Recovery confirmation requires observed evidence.");
    this.db.transaction(() => {
      this.db.prepare("UPDATE automatic_recovery SET state='resolved',reason=?,evidence=?,updated_at=? WHERE recovery_key=?")
        .run(reason,evidence,now,key);
      this.closeIncident(key,now);
    })();
  }

  private closeIncident(key: string, now: number): void {
    this.db.prepare("UPDATE automatic_recovery_incidents SET active=0,updated_at=? WHERE recovery_key=?").run(now,key);
  }

  prune(retentionDays: number, now = Date.now(), limit = 64): { recordsRemoved: number; incidentsRemoved: number } {
    if (retentionDays === 0) return { recordsRemoved: 0, incidentsRemoved: 0 };
    const boundedLimit = Math.max(1, Math.min(64, Math.floor(limit)));
    // Keep every unresolved attempt budget while its original work still exists.
    const recordsRemoved = this.db.prepare(`DELETE FROM automatic_recovery WHERE recovery_key IN (
      SELECT recovery_key FROM automatic_recovery WHERE updated_at<? AND
        (state='resolved' OR NOT EXISTS (SELECT 1 FROM agents WHERE agent_id=automatic_recovery.agent_id)
         OR job_id IS NOT NULL AND EXISTS (SELECT 1 FROM work_history_state WHERE job_id=automatic_recovery.job_id AND expired_at IS NOT NULL))
      ORDER BY updated_at,recovery_key LIMIT ?
    )`).run(now - retentionDays * 86_400_000, boundedLimit).changes;
    const incidentsRemoved = this.db.prepare(`DELETE FROM automatic_recovery_incidents WHERE identity_key IN (
      SELECT identity_key FROM automatic_recovery_incidents WHERE updated_at<? AND (
        NOT EXISTS (SELECT 1 FROM agents WHERE agent_id=automatic_recovery_incidents.agent_id)
        OR NOT EXISTS (SELECT 1 FROM automatic_recovery WHERE recovery_key=automatic_recovery_incidents.recovery_key))
      ORDER BY updated_at,identity_key LIMIT ?
    )`).run(now - retentionDays * 86_400_000, boundedLimit).changes;
    return { recordsRemoved, incidentsRemoved };
  }

  private decode(row: Record<string, unknown>): AutomaticRecoveryRecord {
    return {key:String(row.recovery_key),scopeId:String(row.scope_id),agentId:String(row.agent_id),
      ...(row.job_id ? {jobId:String(row.job_id)} : {}),kind:row.kind as AutomaticRecoveryKind,state:row.state as AutomaticRecoveryState,
      attempts:Number(row.attempts),createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),nextAttemptAt:Number(row.next_attempt_at),
      reason:String(row.reason),...(row.evidence ? {evidence:String(row.evidence)} : {})};
  }
}

export type AutomaticRecoverySweepObservation = {
  agents: number; candidates: number; dispatched: number; durationMs: number;
  plannedRoundTrips: number; full: boolean;
};

/** One recovery tick may inspect at most one small Agent page. The cursor is
 * reconstructible: after restart a new pass begins at the first Agent, while
 * the durable incident journal keeps attempt and backoff authority. */
export class AutomaticRecoveryController {
  lastError?: string;
  lastObservation?: AutomaticRecoverySweepObservation;
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private closed = false;
  private nonforcingPinned = false;
  private nonforcingUnknown = false;
  private candidateCursor = "";
  private agentCursor = "";
  private fullScanScheduled = false;
  private readonly scheduledAgents = new Set<string>();
  readonly now: () => number;
  constructor(private readonly store: AutomaticRecoveryStore, private readonly options: {
    candidates: (agentId?: string) => AutomaticRecoveryCandidate[] | Promise<AutomaticRecoveryCandidate[]>;
    pageAgents?: (afterAgentId: string, limit: number) => string[];
    agentForJob?: (jobId: string) => string | undefined;
    attempt: (candidate: AutomaticRecoveryCandidate) => Promise<AutomaticRecoveryResult>;
    changed?: () => void; enabled?: () => boolean; now?: () => number; intervalMs?: number;
  }) { this.now = options.now || (() => Date.now()); }

  start(): void {
    if (this.closed || this.timer) return;
    const intervalMs = this.options.intervalMs ?? 5_000;
    if (this.closed) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647)
      throw new Error("STATE_BACKGROUND_INTERVAL_INVALID");
    const observedAt = this.now();
    if (this.nonforcingPinned) return;
    this.store.reconcileInterrupted(observedAt);
    this.timer = setInterval(() => { void this.sweep(); }, intervalMs);
    this.timer.unref();
    this.schedule();
  }

  schedule(agentId?: string): void {
    if (this.closed) return;
    if (agentId) {
      if (this.scheduledAgents.size < 128 || this.scheduledAgents.has(agentId)) {
        this.scheduledAgents.add(agentId);
      } else {
        // The periodic keyset pass remains authoritative after a dirty-set
        // overflow. Do not retain an unbounded queue during a progress storm.
        this.fullScanScheduled = true;
      }
    } else this.fullScanScheduled = true;
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      if (this.nonforcingPinned) return;
      this.scheduled = undefined;
      const full = this.fullScanScheduled;
      this.fullScanScheduled = false;
      const agents = [...this.scheduledAgents].slice(0, 8);
      for (const id of agents) this.scheduledAgents.delete(id);
      void (async () => {
        await this.pending;
        for (const id of agents) await this.sweep(undefined, id);
        if (full) await this.sweep();
        if (this.scheduledAgents.size || this.fullScanScheduled) this.scheduleNext();
      })();
    }, 100);
    this.scheduled.unref();
  }

  private scheduleNext(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.schedule(this.scheduledAgents.values().next().value);
    }, 100);
    this.scheduled.unref();
  }

  sweep(jobId?: string, agentId?: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    let resolve!: () => void;
    const pending = new Promise<void>(done => {resolve = done;});
    this.pending = pending;
    // Publish the original work handle before callbacks can reenter the fence.
    void this.runSweep(jobId, agentId).catch(error => {
      if (this.nonforcingPinned) this.nonforcingUnknown = true;
      this.lastError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (this.pending === pending) this.pending = undefined;
      resolve();
    });
    return pending;
  }

  async recoverJob(jobId: string): Promise<void> {
    await this.pending;
    if (this.nonforcingPinned) return;
    const agentId = this.options.agentForJob?.(jobId);
    if (this.nonforcingPinned) return;
    await this.sweep(jobId, agentId);
  }

  async close(): Promise<void> {
    if (this.nonforcingPinned) { await this.pending; return; }
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    await this.pending;
  }

  /** Retain scheduled identities and durable attempts; stop future dispatch. */
  pinNonforcingShutdown(): true {
    if (this.nonforcingPinned) return true;
    this.nonforcingUnknown ||= this.closed;
    this.nonforcingPinned = true;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduled) clearTimeout(this.scheduled);
    this.timer = undefined;
    this.scheduled = undefined;
    return true;
  }

  private publishChanges(): void {
    if (this.nonforcingPinned) return;
    const changed = this.options.changed;
    if (this.nonforcingPinned) return;
    if (changed?.call(this.options) !== undefined) this.nonforcingUnknown = true;
  }

  observeNonforcingExit(): ShutdownResult {
    if (!this.nonforcingPinned || this.nonforcingUnknown) return shutdownResult("uncertain");
    return this.pending ? shutdownResult("timeout", 1) : shutdownResult("exited");
  }

  private async runSweep(jobId?: string, agentId?: string): Promise<void> {
    const enabled = this.options.enabled;
    if (this.nonforcingPinned) return;
    if (enabled?.call(this.options) === false || this.nonforcingPinned) return;
    const observedAt = this.now();
    if (this.nonforcingPinned) return;
    this.store.reconcileInterrupted(observedAt);
    const budget = new BackgroundWorkSlice(RECOVERY_WORK_LIMITS);
    budget.roundTrips = 1; // bounded interrupted-attempt reconciliation
    let agents = 0, candidates = 0, dispatched = 0;
    const full = !agentId;
    try {
      if (!agentId && this.options.pageAgents) {
        const due = this.store.dueAgentIds(this.now());
        for (const id of due) {
          if (this.closed || dispatched >= 3 || !budget.take(12)) break;
          const result = await this.survey(id, jobId, 3 - dispatched, budget);
          agents++;
          candidates += result.candidates;
          dispatched += result.dispatched;
          if (budget.targets % budget.limits.yieldEvery === 0) await budget.yieldIfNeeded();
        }
        if (this.nonforcingPinned) return;
        let page = this.options.pageAgents(this.agentCursor, Math.max(1,budget.limits.maxTargets-budget.targets));
        if (page.length === 0 && this.agentCursor) {
          this.agentCursor = "";
          page = this.options.pageAgents("", Math.max(1,budget.limits.maxTargets-budget.targets));
        }
        for (const id of page) {
          if (this.closed || dispatched >= 4 || !budget.take(12)) break;
          if (!due.includes(id)) {
            const result = await this.survey(id, jobId, 4 - dispatched, budget);
            agents++;
            candidates += result.candidates;
            dispatched += result.dispatched;
          }
          this.agentCursor = id;
          if (budget.targets % budget.limits.yieldEvery === 0) await budget.yieldIfNeeded();
        }
        return;
      }
      budget.take(12);
      const result = await this.survey(agentId, jobId, 4, budget);
      agents = 1;
      candidates = result.candidates;
      dispatched = result.dispatched;
    } finally {
      this.lastObservation = {agents,candidates,dispatched,durationMs:budget.durationMs,
        plannedRoundTrips:budget.roundTrips,full};
    }
  }

  private async survey(agentId: string | undefined, jobId: string | undefined, dispatchLimit: number,
    budget: BackgroundWorkSlice): Promise<{candidates:number;dispatched:number}> {
    const discover = this.options.candidates;
    if (this.nonforcingPinned) return {candidates: 0, dispatched: 0};
    const available = await budget.awaitExternal(Reflect.apply(discover, this.options, [agentId]));
    if (this.nonforcingPinned) return {candidates: 0, dispatched: 0};
    const keys = new Set(available.map(candidate => candidate.key));
    // A production Agent has at most three current candidate kinds. Every
    // nonmatching retry is resolved in this pass, so repeated first pages
    // drain historical records without retaining a cursor for every Agent.
    const records = agentId ? this.store.pendingForAgent(agentId)
      : this.store.list().filter(record => record.state === "retrying");
    for (const record of records) {
      if (jobId && record.jobId !== jobId) continue;
      if (!keys.has(record.key)) {
        const observedAt = this.now();
        if (this.nonforcingPinned) return {candidates: 0, dispatched: 0};
        this.store.finish(record.key,record.attempts,{resolved:false,reason:"work-changed",retryable:false},observedAt);
        if (this.nonforcingPinned) return {candidates: 0, dispatched: 0};
        this.publishChanges();
      }
    }
    const candidates = available.filter(candidate => !jobId || candidate.jobId === jobId)
      .sort((a,b) => a.key.localeCompare(b.key));
    const after = candidates.filter(candidate => candidate.key > this.candidateCursor);
    const before = candidates.filter(candidate => candidate.key <= this.candidateCursor);
    let dispatched = 0;
    for (const candidate of [...after,...before]) {
      if (this.closed || dispatched >= dispatchLimit) break;
      if (candidate.kind === "release" && !this.store.canBegin(candidate,this.now())) {
        this.candidateCursor = candidate.key;
        continue;
      }
      // A shared-worker release can inspect 31 additional connections. Charge
      // that work before persisting an attempt, so a deferred release keeps
      // its retry budget and can run in a later Agent page.
      if (candidate.kind === "release" && !budget.reserve(180)) break;
      this.candidateCursor = candidate.key;
      const attemptStartedAt = this.now();
      if (this.nonforcingPinned) return {candidates:candidates.length,dispatched};
      const attempt = this.store.begin(candidate,attemptStartedAt);
      if (!attempt) continue;
      dispatched++;
      this.publishChanges();
      if (this.nonforcingPinned) return {candidates:candidates.length,dispatched};
      let result: AutomaticRecoveryResult;
      try {
        const attemptWork = this.options.attempt;
        if (this.nonforcingPinned) return {candidates:candidates.length,dispatched};
        result = await budget.awaitExternal(Reflect.apply(attemptWork, this.options, [candidate]));
      }
      catch { result = {resolved:false,reason:"recovery-unconfirmed"}; }
      if (this.nonforcingPinned) return {candidates:candidates.length,dispatched};
      const retainedResult = snapshotRecoveryResult(result);
      if (this.nonforcingPinned) return {candidates:candidates.length,dispatched};
      if (!retainedResult) {this.nonforcingUnknown = true; return {candidates:candidates.length,dispatched};}
      const finishedAt = this.now();
      if (this.nonforcingPinned) return {candidates:candidates.length,dispatched};
      this.store.finish(candidate.key,attempt.attempts,retainedResult,finishedAt);
      if (this.nonforcingPinned) return {candidates:candidates.length,dispatched};
      this.publishChanges();
      // A shared-worker release may resolve a peer. Its durable state is
      // checked by begin() on the next candidate; no global rediscovery here.
    }
    return {candidates:candidates.length,dispatched};
  }
}

/** Receipt fields must be own data; no callback can run inside a journal write. */
function snapshotRecoveryResult(value: AutomaticRecoveryResult): AutomaticRecoveryResult | undefined {
  try {
    const fields = Object.getOwnPropertyDescriptors(value);
    const keys = ["resolved", "reason", "evidence", "retryable"];
    if (["resolved", "reason"].some(key => !Object.hasOwn(fields,key)) ||
        keys.some(key => Object.hasOwn(fields,key) && !Object.hasOwn(fields[key],"value"))) return;
    const result = Object.fromEntries(keys.filter(key => Object.hasOwn(fields,key)).map(key => [key,fields[key].value]));
    if (typeof result.resolved !== "boolean" || typeof result.reason !== "string" ||
        result.evidence !== undefined && typeof result.evidence !== "string" ||
        result.retryable !== undefined && typeof result.retryable !== "boolean") return;
    return Object.freeze(result) as AutomaticRecoveryResult;
  } catch {return;}
}
