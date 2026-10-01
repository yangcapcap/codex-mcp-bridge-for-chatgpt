import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  TRANSPORT_OBSERVATION_KINDS,
  type TransportObservationKind,
  type TransportObservationRecord
} from "./stateStore.js";

import {OwnedProcessShutdown,beginOrdinaryOwnedProcessStop,isOwnedProcessNonforcing} from "./ownedProcessShutdown.js";
import {ExecutionShutdownOwner} from "./executionShutdownOwner.js";
import {snapshotExecutionShutdownRequest} from "./executionShutdownProtocol.js";
import {snapshotShutdownPolicy,shutdownResult,type ShutdownPolicy,type ShutdownResult} from "./shutdown.js";

const CHILD_FLAG = "--bridge-telemetry-child";
const FREEZE_PAGE_COUNT_FLAG = "--test-freeze-page-count";
const RETENTION_LIMIT = 1_000;
const MEASUREMENT_RETENTION_LIMIT = 5_000;
const DIAGNOSTIC_RETENTION_LIMIT = 2_000;
const QUEUE_CAPACITY = 4_096;
const QUEUE_BYTE_CAPACITY = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;
const STARTUP_TIMEOUT_MS = 10_000;
const CLOSE_FLUSH_MS = 1_000;
const FORCE_CLOSE_MS = 2_000;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;

export type TransportObservationInput = {
  kind: TransportObservationKind;
  scopeId?: string;
  jobId?: string;
  activityId?: string;
  toolName?: string;
  callerRequestDigest?: string;
  reasonCode: string;
  now?: number;
};

export type TelemetryServiceStatus = {
  connected: boolean;
  queued: number;
  inFlight: number;
  retained: number;
  dropped: number;
  failed: number;
  lastPersistedAt?: number;
};

export type RuntimeMeasurementInput = {
  component: "state" | "execution" | "read" | "telemetry" | "ingress";
  metric: string;
  durationMs: number;
  count?: number;
  now?: number;
};

export type DiagnosticEventInput = {
  severity: "info" | "warning" | "error";
  component: "state" | "execution" | "read" | "telemetry" | "ingress";
  code: string;
  now?: number;
};

type RuntimeMeasurementRecord = {
  measurementId: number;
  component: RuntimeMeasurementInput["component"];
  metric: string;
  count: number;
  minMs: number;
  maxMs: number;
  sumMs: number;
  createdAt: number;
};

type DiagnosticEventRecord = {
  eventId: number;
  severity: DiagnosticEventInput["severity"];
  component: DiagnosticEventInput["component"];
  code: string;
  createdAt: number;
};

type DropCounterRecord = {
  kind: string;
  droppedCount: number;
  firstAt: number;
  lastAt: number;
};

type QueuedTelemetryRecord = ({ deliveryId: string } & (
  | { recordType: "transport"; id: number; record: TransportObservationRecord }
  | { recordType: "measurement"; id: number; record: RuntimeMeasurementRecord }
  | { recordType: "diagnostic"; id: number; record: DiagnosticEventRecord }
));

type QueuedEntry = { value: QueuedTelemetryRecord; bytes: number };

export interface BridgeTelemetryService {
  recordTransportObservation(
    input: TransportObservationInput,
    bridgeInstanceId: string
  ): TransportObservationRecord | undefined;
  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[];
  recordRuntimeMeasurement(input: RuntimeMeasurementInput): boolean;
  recordDiagnosticEvent(input: DiagnosticEventInput): boolean;
  status(): TelemetryServiceStatus;
  close(): Promise<void>;
}

/** Fail-open diagnostic fallback: bounded memory only, never operational DB. */
export class InMemoryTelemetryService implements BridgeTelemetryService {
  private readonly records: TransportObservationRecord[] = [];
  private nextObservationId = 1;
  private failed = 0;
  private retainedDiagnostics = 0;

  recordTransportObservation(
    input: TransportObservationInput,
    bridgeInstanceId: string
  ): TransportObservationRecord | undefined {
    let record: TransportObservationRecord;
    try {
      record = normalizeRecord(input, bridgeInstanceId, this.nextObservationId++);
    } catch {
      this.failed += 1;
      return undefined;
    }
    this.records.push(record);
    trimRecords(this.records);
    return { ...record };
  }

  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[] {
    return this.records
      .filter(record => kind === undefined || record.kind === kind)
      .map(record => ({ ...record }));
  }

  recordRuntimeMeasurement(input: RuntimeMeasurementInput): boolean {
    try { normalizeMeasurement(input, 1); this.retainedDiagnostics += 1; return true; }
    catch { this.failed += 1; return false; }
  }

  recordDiagnosticEvent(input: DiagnosticEventInput): boolean {
    try { normalizeDiagnosticEvent(input, 1); this.retainedDiagnostics += 1; return true; }
    catch { this.failed += 1; return false; }
  }

  status(): TelemetryServiceStatus {
    return {
      connected: false,
      queued: 0,
      inFlight: 0,
      retained: this.records.length + this.retainedDiagnostics,
      dropped: 0,
      failed: this.failed
    };
  }

  async close(): Promise<void> {}
}

type RecordMessage = { type: "record"; entry: QueuedTelemetryRecord };
type DropMessage = { type: "drops"; counters: DropCounterRecord[] };
type CloseMessage = { type: "close" };
type ParentMessage = RecordMessage | DropMessage | CloseMessage;
type ReadyMessage = {
  type: "ready";
  generation:string;
  records: TransportObservationRecord[];
  nextRecordId: number;
  dropCounters: DropCounterRecord[];
};
type AckMessage = {
  type: "ack";
  recordType: QueuedTelemetryRecord["recordType"];
  deliveryId: string;
  recordId: number;
  ok: boolean;
  persistedAt?: number;
};
type DropAckMessage = { type: "drop-ack"; ok: boolean; persistedAt?: number };
type FatalMessage = { type: "fatal"; message: string };
type ChildMessage = ReadyMessage | AckMessage | DropAckMessage | FatalMessage;

/**
 * Best-effort diagnostic persistence. The caller updates a bounded in-memory
 * view synchronously, while SQLite work is serialized in a separate process.
 * Queue overflow or telemetry storage failure is observable but can never
 * block or change an operational command.
 */
export class ChildProcessTelemetryService implements BridgeTelemetryService {
  private child?: ChildProcess;
  private generation?:string;
  private shutdown?:OwnedProcessShutdown;
  private nonforcingClose?:Promise<ShutdownResult>;
  private startupTimer?:NodeJS.Timeout;
  private closeWait?:()=>void;
  private readonly records: TransportObservationRecord[] = [];
  private readonly queue: QueuedEntry[] = [];
  private queueBytes = 0;
  private inFlight?: QueuedEntry | { drops: true };
  private nextRecordId = 1;
  private readonly dropCounters = new Map<string, DropCounterRecord>();
  private dropsDirty = false;
  private dropped = 0;
  private failed = 0;
  private lastPersistedAt?: number;
  private closed = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;
  private dropRetryTimer?: NodeJS.Timeout;
  private dropRetryAttempts = 0;
  private initialized = false;
  private ready = false;

  private constructor(
    private readonly file: string,
    private readonly freezePageCountAfterStartup: boolean,
    private readonly sourceStateDatabaseId: string | undefined,
    private readonly queueCapacity: number,
    private readonly queueByteCapacity: number
  ) {}

  static async start(
    file: string,
    options: {
      /** Deterministic disk-capacity fault injection for tests. */
      freezePageCountAfterStartup?: boolean;
      sourceStateDatabaseId?: string;
      /** Test-only bounded queue overrides for deterministic recovery coverage. */
      queueCapacity?: number;
      queueByteCapacity?: number;
    } = {}
  ): Promise<ChildProcessTelemetryService> {
    if (options.sourceStateDatabaseId !== undefined && !isUuid(options.sourceStateDatabaseId)) {
      throw new Error("TELEMETRY_SOURCE_ID_INVALID: State database identity must be a UUID.");
    }
    const queueCapacity = options.queueCapacity ?? QUEUE_CAPACITY;
    const queueByteCapacity = options.queueByteCapacity ?? QUEUE_BYTE_CAPACITY;
    if (!Number.isSafeInteger(queueCapacity) || queueCapacity < 1 ||
        !Number.isSafeInteger(queueByteCapacity) || queueByteCapacity < MAX_MESSAGE_BYTES) {
      throw new Error("TELEMETRY_QUEUE_CAPACITY_INVALID: Telemetry queue bounds are invalid.");
    }
    const create = () => new ChildProcessTelemetryService(
      file,
      options.freezePageCountAfterStartup === true,
      options.sourceStateDatabaseId,
      queueCapacity,
      queueByteCapacity
    );
    let service = create();
    try {
      await service.spawnAndWait();
      return service;
    } catch (error) {
      if (!existsSync(file) || !shouldRebuildTelemetryDatabase(error)) {
        // The failed child exit already scheduled bounded restart. Telemetry is
        // fail-open, so startup may continue in an explicitly disconnected
        // state and recover after a transient lock or filesystem condition.
        service.failed += 1;
        return service;
      }
      await service.close().catch(() => undefined);
      try {
        quarantineTelemetryDatabase(file);
        service = create();
        try {
          await service.spawnAndWait();
        } catch {
          service.failed += 1;
          return service;
        }
        service.recordDiagnosticEvent({
          severity: "warning",
          component: "telemetry",
          code: "database.rebuilt"
        });
        return service;
      } catch {
        await service.close().catch(() => undefined);
        throw error;
      }
    }
  }

  recordTransportObservation(
    input: TransportObservationInput,
    bridgeInstanceId: string
  ): TransportObservationRecord | undefined {
    if (this.closed || this.closing) return undefined;
    let record: TransportObservationRecord;
    try {
      record = normalizeRecord(input, bridgeInstanceId, this.nextRecordId++);
    } catch {
      this.failed += 1;
      return undefined;
    }
    if(this.closed || this.closing)return undefined;
    this.records.push(record);
    trimRecords(this.records);
    this.enqueue({
      deliveryId: randomUUID(),
      recordType: "transport",
      id: record.observationId,
      record
    });
    return { ...record };
  }

  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[] {
    return this.records
      .filter(record => kind === undefined || record.kind === kind)
      .map(record => ({ ...record }));
  }

  recordRuntimeMeasurement(input: RuntimeMeasurementInput): boolean {
    if (this.closed || this.closing) return false;
    try {
      const record = normalizeMeasurement(input, this.nextRecordId++);
      return this.enqueue({
        deliveryId: randomUUID(),
        recordType: "measurement",
        id: record.measurementId,
        record
      });
    } catch {
      this.failed += 1;
      return false;
    }
  }

  recordDiagnosticEvent(input: DiagnosticEventInput): boolean {
    if (this.closed || this.closing) return false;
    try {
      const record = normalizeDiagnosticEvent(input, this.nextRecordId++);
      return this.enqueue({
        deliveryId: randomUUID(),
        recordType: "diagnostic",
        id: record.eventId,
        record
      });
    } catch {
      this.failed += 1;
      return false;
    }
  }

  status(): TelemetryServiceStatus {
    return {
      connected: Boolean(!this.closed && !this.closing && this.ready && this.child?.connected && this.child.exitCode === null),
      queued: this.queue.length,
      inFlight: this.inFlight ? 1 : 0,
      retained: this.records.length,
      dropped: this.dropped,
      failed: this.failed,
      ...(this.lastPersistedAt !== undefined ? { lastPersistedAt: this.lastPersistedAt } : {})
    };
  }

  closeNonforcing(policy:ShutdownPolicy):Promise<ShutdownResult>{
    const snapshot=snapshotShutdownPolicy(policy);
    if(snapshot.allowSigkillEscalation!==false)throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    if(this.nonforcingClose)return this.nonforcingClose;
    if(this.shutdown)return this.nonforcingClose=this.shutdown.closeNonforcing(snapshot);
    this.closed=true;this.closing=true;this.ready=false;
    if(this.restartTimer)clearTimeout(this.restartTimer);
    if(this.dropRetryTimer)clearTimeout(this.dropRetryTimer);
    return this.nonforcingClose=Promise.resolve(shutdownResult("uncertain"));
  }
  observeNonforcingExit():Promise<ShutdownResult>{
    return this.shutdown?.observeNonforcingExit() ?? Promise.resolve(shutdownResult("uncertain"));
  }
  close(): Promise<void> {
    if(this.nonforcingClose)return this.shutdown ? this.shutdown.closeAfterPin() : Promise.reject(new Error("NONFORCING_SHUTDOWN_UNCONFIRMED"));
    if (!this.closePromise) this.closePromise = this.closeChild();
    return this.closePromise;
  }

  /** Test/supervisor visibility only; never exposed through diagnostics records. */
  get processId(): number | undefined {
    return this.child?.pid;
  }

  private enqueue(value: QueuedTelemetryRecord): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if(this.closed || this.nonforcingClose || this.shutdown?.pinned)return false;
    if (bytes > MAX_MESSAGE_BYTES) {
      this.failed += 1;
      this.noteDrop(`${value.recordType}.record-too-large`);
      return false;
    }
    if (
      this.queue.length + (this.inFlight && !("drops" in this.inFlight) ? 1 : 0) >=
        this.queueCapacity ||
      this.queueBytes + bytes > this.queueByteCapacity
    ) {
      this.noteDrop(`${value.recordType}.queue-capacity`);
      return false;
    }
    this.queue.push({ value, bytes });
    this.queueBytes += bytes;
    this.pump();
    return true;
  }

  private noteDrop(kind: string, now = Date.now()): void {
    this.dropped += 1;
    const current = this.dropCounters.get(kind);
    this.dropCounters.set(kind, current
      ? { ...current, droppedCount: current.droppedCount + 1, lastAt: now }
      : { kind, droppedCount: 1, firstAt: now, lastAt: now });
    this.dropsDirty = true;
    this.pump();
  }

  private spawnAndWait(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("TELEMETRY_CLOSED: Telemetry service closed."));
    }
    const controllerId=randomUUID();
    const modulePath = fileURLToPath(import.meta.url);
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG, this.file, this.sourceStateDatabaseId || "-"]
      : [modulePath, CHILD_FLAG, this.file, this.sourceStateDatabaseId || "-"];
    args.push(controllerId);
    if (this.freezePageCountAfterStartup) args.push(FREEZE_PAGE_COUNT_FLAG);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: childEnvironment(),
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    this.child = child;
    this.generation=undefined;
    this.shutdown=new OwnedProcessShutdown(child,{
      generation:()=>this.generation,
      pin:()=>{
        this.closed=true;this.closing=true;this.ready=false;
        if(this.restartTimer)clearTimeout(this.restartTimer);
        if(this.dropRetryTimer)clearTimeout(this.dropRetryTimer);
        if(this.startupTimer)clearTimeout(this.startupTimer);
        this.closeWait?.();
        return true;
      }
    },controllerId);
    this.ready = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.startupTimer=undefined;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error("TELEMETRY_START_TIMEOUT: Telemetry process did not become ready.");
        finish(error);
        if(beginOrdinaryOwnedProcessStop(child))child.kill("SIGKILL");
      }, STARTUP_TIMEOUT_MS);
      this.startupTimer=timer;
      timer.unref();
      child.once("error", error => {
        finish(error);
        this.onExit(child);
      });
      child.once("exit", (code, signal) => {
        finish(new Error(`TELEMETRY_PROCESS_EXITED: code=${code}, signal=${signal}`));
        this.onExit(child);
      });
      child.stderr?.on("data", chunk => {
        if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") process.stderr.write(chunk);
      });
      child.on("message", value => {
        if (this.child !== child || isOwnedProcessNonforcing(child)) return;
        if (!isChildMessage(value)) return;
        if (value.type === "fatal") {
          finish(new Error(`TELEMETRY_START_FAILED: ${value.message}`));
          return;
        }
        if (value.type === "ready") {
          this.generation=value.generation;
          if (!this.initialized) {
            const hadLocalDrops = this.dropCounters.size > 0;
            this.rebasePendingRecordIds(value.nextRecordId);
            this.records.unshift(...value.records.map(record => ({ ...record })));
            trimRecords(this.records);
            for (const counter of value.dropCounters) {
              const local = this.dropCounters.get(counter.kind);
              this.dropCounters.set(counter.kind, local ? {
                kind: counter.kind,
                droppedCount: counter.droppedCount + local.droppedCount,
                firstAt: Math.min(counter.firstAt, local.firstAt),
                lastAt: Math.max(counter.lastAt, local.lastAt)
              } : { ...counter });
            }
            this.dropped = [...this.dropCounters.values()].reduce(
              (total, counter) => total + counter.droppedCount,
              0
            );
            if (hadLocalDrops) this.dropsDirty = true;
            this.initialized = true;
          }
          this.ready = true;
          finish();
          this.pump();
          return;
        }
        if (value.type === "drop-ack") {
          if (!this.inFlight || !("drops" in this.inFlight)) return;
          this.inFlight = undefined;
          if (value.ok) {
            this.lastPersistedAt = value.persistedAt;
            this.dropRetryAttempts = 0;
          }
          else {
            this.failed += 1;
            this.dropsDirty = true;
            this.scheduleDropRetry();
          }
          this.pump();
          return;
        }
        if (!this.inFlight || "drops" in this.inFlight ||
            this.inFlight.value.recordType !== value.recordType ||
            this.inFlight.value.deliveryId !== value.deliveryId) return;
        const completed = this.inFlight;
        this.inFlight = undefined;
        if (value.ok) {
          updateTelemetryRecordId(completed.value, value.recordId);
          this.nextRecordId = Math.max(this.nextRecordId, value.recordId + 1);
          this.lastPersistedAt = value.persistedAt;
        }
        else {
          this.failed += 1;
          this.noteDrop(`${completed.value.recordType}.write-failed`);
        }
        this.pump();
      });
    });
  }

  private rebasePendingRecordIds(firstRecordId: number): void {
    let next = Math.max(1, firstRecordId);
    const ids = new Set<number>();
    for (const record of this.records) ids.add(record.observationId);
    for (const entry of this.queue) ids.add(entry.value.id);
    if (this.inFlight && !("drops" in this.inFlight)) ids.add(this.inFlight.value.id);
    const remapped = new Map<number, number>();
    for (const id of [...ids].sort((left, right) => left - right)) {
      remapped.set(id, next++);
    }
    for (const record of this.records) {
      record.observationId = remapped.get(record.observationId) ?? record.observationId;
    }
    this.queueBytes = 0;
    for (const entry of this.queue) {
      const id = remapped.get(entry.value.id);
      if (id !== undefined) updateTelemetryRecordId(entry.value, id);
      entry.bytes = Buffer.byteLength(JSON.stringify(entry.value), "utf8");
      this.queueBytes += entry.bytes;
    }
    if (this.inFlight && !("drops" in this.inFlight)) {
      const id = remapped.get(this.inFlight.value.id);
      if (id !== undefined) updateTelemetryRecordId(this.inFlight.value, id);
    }
    this.nextRecordId = next;
  }

  private onExit(child: ChildProcess): void {
    if (this.child !== child) return;
    if(isOwnedProcessNonforcing(child)){this.ready=false;return;}
    this.child = undefined;
    this.ready = false;
    if (this.inFlight) {
      if ("drops" in this.inFlight) this.dropsDirty = true;
      else {
        this.queue.unshift(this.inFlight);
        this.queueBytes += this.inFlight.bytes;
      }
    }
    this.inFlight = undefined;
    while (this.queue.length > this.queueCapacity || this.queueBytes > this.queueByteCapacity) {
      const removed = this.queue.pop();
      if (!removed) break;
      this.queueBytes = Math.max(0, this.queueBytes - removed.bytes);
      this.noteDrop(`${removed.value.recordType}.restart-capacity`);
    }
    if (!this.closed) this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts,
      RESTART_MAX_DELAY_MS
    );
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawnAndWait().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private pump(): void {
    const child = this.child;
    if (
      this.closed || this.inFlight || !this.ready ||
      !child?.connected || child.exitCode !== null
    ) return;
    if (this.dropsDirty) {
      if (this.dropRetryTimer) return;
      const message: DropMessage = {
        type: "drops",
        counters: [...this.dropCounters.values()].map(counter => ({ ...counter }))
      };
      if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MESSAGE_BYTES) {
        this.failed += 1;
        return;
      }
      this.dropsDirty = false;
      this.inFlight = { drops: true };
      child.send(message, error => {
        if (isOwnedProcessNonforcing(child) || !error || this.child !== child || !this.inFlight ||
            !("drops" in this.inFlight)) return;
        this.inFlight = undefined;
        this.failed += 1;
        this.dropsDirty = true;
        this.scheduleDropRetry();
        this.pump();
      });
      return;
    }
    const entry = this.queue.shift();
    if (!entry) return;
    this.queueBytes = Math.max(0, this.queueBytes - entry.bytes);
    const message: RecordMessage = { type: "record", entry: entry.value };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MESSAGE_BYTES) {
      this.failed += 1;
      this.noteDrop(`${entry.value.recordType}.record-too-large`);
      queueMicrotask(() => this.pump());
      return;
    }
    this.inFlight = entry;
    child.send(message, error => {
      if (
        isOwnedProcessNonforcing(child) || !error || this.child !== child ||
        !this.inFlight || "drops" in this.inFlight ||
        this.inFlight.value.recordType !== entry.value.recordType ||
        this.inFlight.value.deliveryId !== entry.value.deliveryId
      ) return;
      this.inFlight = undefined;
      this.failed += 1;
      this.noteDrop(`${entry.value.recordType}.send-failed`);
      this.pump();
    });
  }

  private scheduleDropRetry(): void {
    if (this.closed || this.dropRetryTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** Math.min(this.dropRetryAttempts, 16),
      RESTART_MAX_DELAY_MS
    );
    this.dropRetryAttempts = Math.min(this.dropRetryAttempts + 1, 16);
    this.dropRetryTimer = setTimeout(() => {
      this.dropRetryTimer = undefined;
      this.pump();
    }, delay);
    this.dropRetryTimer.unref();
  }

  private async closeChild(): Promise<void> {
    const owned=this.child;
    if(owned && !beginOrdinaryOwnedProcessStop(owned))return this.shutdown?.closeAfterPin();
    this.closing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.dropRetryTimer) clearTimeout(this.dropRetryTimer);
    this.dropRetryTimer = undefined;
    this.pump();
    const deadline = Date.now() + CLOSE_FLUSH_MS;
    while ((this.inFlight || this.queue.length > 0 || this.dropsDirty) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if(owned && isOwnedProcessNonforcing(owned))return this.shutdown?.closeAfterPin();
      this.pump();
    }
    if(owned && isOwnedProcessNonforcing(owned))return this.shutdown?.closeAfterPin();
    for (const entry of this.queue) this.noteDrop(`${entry.value.recordType}.close-timeout`);
    if (this.inFlight && !("drops" in this.inFlight)) {
      this.noteDrop(`${this.inFlight.value.recordType}.close-timeout`);
    }
    this.queue.length = 0;
    this.queueBytes = 0;
    this.inFlight = undefined;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if(!beginOrdinaryOwnedProcessStop(child))return this.shutdown?.closeAfterPin();
    if (child.connected) child.send({ type: "close" } satisfies CloseMessage);
    if(isOwnedProcessNonforcing(child))return this.shutdown?.closeAfterPin();
    await new Promise<void>(resolve => {
      let settled = false;
      const force = setTimeout(() => {if(beginOrdinaryOwnedProcessStop(child))child.kill("SIGKILL");}, FORCE_CLOSE_MS);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        this.closeWait=undefined;
        resolve();
      };
      this.closeWait=finish;
      child.once("exit", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
    if(isOwnedProcessNonforcing(child))return this.shutdown?.closeAfterPin();
  }
}

async function runChild(
  file: string,
  freezePageCountAfterStartup: boolean,
  sourceStateDatabaseId: string|undefined,
  controllerId:string
): Promise<void> {
  const generation=randomUUID();
  let database: Database.Database | undefined;
  const send = (message: ChildMessage) => {
    if (!process.connected || !process.send) return;
    try { process.send(message, () => {}); } catch { /* Parent owns recovery. */ }
  };
  let resourceCloseUncertain=false;
  const closeResources=async()=>{
    try{database?.close();database=undefined;}catch{resourceCloseUncertain=true;}
    return database || resourceCloseUncertain ? shutdownResult("uncertain") : shutdownResult("exited");
  };
  const shutdownOwner=new ExecutionShutdownOwner(generation,process.pid,{
    pin(){return true;},close:closeResources,
    observe:async()=>database || resourceCloseUncertain ? shutdownResult("uncertain") : shutdownResult("exited")
  });
  const handleShutdown=async(value:unknown)=>{
    const receipt=await shutdownOwner.handle(value,controllerId);
    if(!receipt || !process.connected || !process.send)return;
    await new Promise<void>(resolve=>{
      let settled=false;
      const finish=(error?:Error|null)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(error)shutdownOwner.invalidateObservation();
        else if(receipt.operation==="finalize-nonforcing" && receipt.result.exited && shutdownOwner.finalizationAllowed && process.connected)process.disconnect();
        resolve();
      };
      const timer=setTimeout(()=>finish(new Error("TELEMETRY_SHUTDOWN_RECEIPT_TIMEOUT")),6000);
      try{process.send!(receipt,finish);}catch{finish(new Error("TELEMETRY_SHUTDOWN_RECEIPT_FAILED"));}
    });
  };
  const close = () => {
    if(shutdownOwner.pinned)return;
    shutdownOwner.markOrdinaryShutdown();
    try { database?.close(); } finally {
      database = undefined;
      if (process.connected) process.disconnect();
    }
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    database = new Database(file);
    database.pragma("busy_timeout = 1000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    database.pragma("wal_autocheckpoint = 128");
    database.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS transport_observations (
        observation_id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        scope_id TEXT,
        job_id TEXT,
        activity_id TEXT,
        tool_name TEXT,
        caller_request_digest TEXT,
        bridge_instance_id TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS transport_observations_recent
        ON transport_observations(created_at DESC, observation_id DESC);
      CREATE TABLE IF NOT EXISTS runtime_measurements (
        measurement_id INTEGER PRIMARY KEY,
        component TEXT NOT NULL,
        metric TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        min_ms REAL NOT NULL,
        max_ms REAL NOT NULL,
        sum_ms REAL NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS runtime_measurements_recent
        ON runtime_measurements(created_at DESC, measurement_id DESC);
      CREATE TABLE IF NOT EXISTS diagnostic_events (
        event_id INTEGER PRIMARY KEY,
        severity TEXT NOT NULL,
        component TEXT NOT NULL,
        code TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS diagnostic_events_recent
        ON diagnostic_events(created_at DESC, event_id DESC);
      CREATE TABLE IF NOT EXISTS telemetry_drop_counters (
        kind TEXT PRIMARY KEY,
        dropped_count INTEGER NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS telemetry_retention_state (
        kind TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL,
        last_completed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS telemetry_record_deliveries (
        delivery_id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL CHECK(record_type IN ('transport','measurement','diagnostic')),
        record_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(record_type, record_id)
      ) STRICT;
    `);
    initializeTelemetryMetadata(database, sourceStateDatabaseId);
    if (freezePageCountAfterStartup) {
      database.pragma("wal_checkpoint(TRUNCATE)");
      const pageCount = database.pragma("page_count", { simple: true }) as number;
      database.pragma(`max_page_count = ${pageCount}`);
    }
    try { chmodSync(file, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
    const records = (database.prepare(
      "SELECT * FROM transport_observations ORDER BY observation_id ASC"
    ).all() as Array<Record<string, unknown>>).map(readRow);
    const dropCounters = (database.prepare(
      "SELECT * FROM telemetry_drop_counters ORDER BY kind ASC"
    ).all() as Array<Record<string, unknown>>).map(readDropCounter);
    let nextRecordId = Number((database.prepare(`
      SELECT MAX(value) AS value FROM (
        SELECT COALESCE(MAX(observation_id), 0) AS value FROM transport_observations
        UNION ALL SELECT COALESCE(MAX(measurement_id), 0) FROM runtime_measurements
        UNION ALL SELECT COALESCE(MAX(event_id), 0) FROM diagnostic_events
      )
    `).get() as { value?: number } | undefined)?.value || 0) + 1;
    send({ type: "ready",generation, records, nextRecordId, dropCounters });
    process.on("message", value => {
      const request=snapshotExecutionShutdownRequest(value);
      if(request){void handleShutdown(request).catch(()=>shutdownOwner.invalidateObservation());return;}
      if(shutdownOwner.pinned)return;
      if (!isParentMessage(value)) return;
      if (value.type === "close") {
        close();
        return;
      }
      if (value.type === "drops") {
        let ok = false;
        try {
          if (!database) throw new Error("Telemetry database is closed.");
          persistDropCounters(database, value.counters);
          ok = true;
        } catch { ok = false; }
        send({
          type: "drop-ack",
          ok,
          ...(ok ? { persistedAt: Date.now() } : {})
        });
        return;
      }
      let ok = false;
      let persistedRecordId = value.entry.id;
      try {
        if (!database) throw new Error("Telemetry database is closed.");
        persistedRecordId = persistTelemetryRecord(database, value.entry, nextRecordId);
        nextRecordId = Math.max(nextRecordId, persistedRecordId + 1);
        ok = true;
      } catch { ok = false; }
      send({
        type: "ack",
        recordType: value.entry.recordType,
        deliveryId: value.entry.deliveryId,
        recordId: persistedRecordId,
        ok,
        ...(ok ? { persistedAt: Date.now() } : {})
      });
    });
    process.once("disconnect", close);
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  } catch (error) {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    close();
    process.exitCode = 1;
  }
}

function initializeTelemetryMetadata(
  database: Database.Database,
  sourceStateDatabaseId?: string
): void {
  database.transaction(() => {
    const read = database.prepare(
      "SELECT value FROM telemetry_meta WHERE key = ?"
    );
    const write = database.prepare(
      "INSERT INTO telemetry_meta(key, value) VALUES (?, ?)"
    );
    const update = database.prepare(
      "UPDATE telemetry_meta SET value = ? WHERE key = ?"
    );
    const schema = (read.get("schema_version") as { value?: string } | undefined)?.value;
    if (schema === undefined) write.run("schema_version", "2");
    else if (schema === "1") update.run("2", "schema_version");
    else if (schema !== "2") {
      throw new Error(`Unsupported telemetry database schema version: ${schema}.`);
    }
    const databaseId = (read.get("telemetry_database_id") as { value?: string } | undefined)?.value;
    if (databaseId === undefined) write.run("telemetry_database_id", randomUUID());
    else if (!isUuid(databaseId)) throw new Error("Telemetry database identity is invalid.");
    if (sourceStateDatabaseId) {
      const source = (read.get("source_state_database_id") as { value?: string } | undefined)?.value;
      if (source === undefined) write.run("source_state_database_id", sourceStateDatabaseId);
      else if (source !== sourceStateDatabaseId) {
        throw new Error(
          "TELEMETRY_SOURCE_MISMATCH: Telemetry belongs to a different operational database."
        );
      }
    }
  })();
}

function persistTelemetryRecord(
  database: Database.Database,
  entry: QueuedTelemetryRecord,
  nextRecordId: number
): number {
  return database.transaction(() => {
    if (!isUuid(entry.deliveryId)) throw new Error("Invalid telemetry delivery id.");
    const delivered = database.prepare(`
      SELECT record_type, record_id
        FROM telemetry_record_deliveries
       WHERE delivery_id = ?
    `).get(entry.deliveryId) as { record_type?: string; record_id?: number } | undefined;
    if (delivered) {
      if (delivered.record_type !== entry.recordType ||
          !Number.isSafeInteger(delivered.record_id) || Number(delivered.record_id) < 1) {
        throw new Error("Telemetry delivery identity was reused with different content.");
      }
      return Number(delivered.record_id);
    }
    let recordId = entry.id;
    if (telemetryRecordIdInUse(database, recordId)) {
      recordId = Math.max(nextRecordId, nextTelemetryRecordId(database));
      while (telemetryRecordIdInUse(database, recordId)) recordId += 1;
    }
    if (entry.recordType === "transport") {
      const record = normalizeRecord(
        entry.record,
        entry.record.bridgeInstanceId,
        recordId
      );
      database.prepare(`
        INSERT INTO transport_observations(
          observation_id, kind, scope_id, job_id, activity_id, tool_name,
          caller_request_digest, bridge_instance_id, reason_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.observationId,
        record.kind,
        record.scopeId || null,
        record.jobId || null,
        record.activityId || null,
        record.toolName || null,
        record.callerRequestDigest || null,
        record.bridgeInstanceId,
        record.reasonCode,
        record.createdAt
      );
      trimTable(database, "transport_observations", "observation_id", RETENTION_LIMIT);
    } else if (entry.recordType === "measurement") {
      const record = normalizeMeasurement(entry.record, recordId);
      database.prepare(`
        INSERT INTO runtime_measurements(
          measurement_id, component, metric, sample_count, min_ms, max_ms, sum_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.measurementId,
        record.component,
        record.metric,
        record.count,
        record.minMs,
        record.maxMs,
        record.sumMs,
        record.createdAt
      );
      trimTable(database, "runtime_measurements", "measurement_id", MEASUREMENT_RETENTION_LIMIT);
    } else {
      const record = normalizeDiagnosticEvent(entry.record, recordId);
      database.prepare(`
        INSERT INTO diagnostic_events(
          event_id, severity, component, code, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        record.eventId,
        record.severity,
        record.component,
        record.code,
        record.createdAt
      );
      trimTable(database, "diagnostic_events", "event_id", DIAGNOSTIC_RETENTION_LIMIT);
    }
    database.prepare(`
      INSERT INTO telemetry_record_deliveries(
        delivery_id, record_type, record_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(entry.deliveryId, entry.recordType, recordId, Date.now());
    trimTelemetryDeliveries(database, entry.recordType);
    database.prepare(`
      INSERT INTO telemetry_retention_state(kind, cursor, last_completed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET
        cursor=excluded.cursor,
        last_completed_at=excluded.last_completed_at
    `).run(entry.recordType, recordId, Date.now());
    return recordId;
  })();
}

function telemetryRecordIdInUse(database: Database.Database, recordId: number): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS found FROM (
      SELECT observation_id AS id FROM transport_observations WHERE observation_id = ?
      UNION ALL SELECT measurement_id FROM runtime_measurements WHERE measurement_id = ?
      UNION ALL SELECT event_id FROM diagnostic_events WHERE event_id = ?
    ) LIMIT 1
  `).get(recordId, recordId, recordId));
}

function nextTelemetryRecordId(database: Database.Database): number {
  return Number((database.prepare(`
    SELECT MAX(value) AS value FROM (
      SELECT COALESCE(MAX(observation_id), 0) AS value FROM transport_observations
      UNION ALL SELECT COALESCE(MAX(measurement_id), 0) FROM runtime_measurements
      UNION ALL SELECT COALESCE(MAX(event_id), 0) FROM diagnostic_events
    )
  `).get() as { value?: number } | undefined)?.value || 0) + 1;
}

function trimTelemetryDeliveries(
  database: Database.Database,
  recordType: QueuedTelemetryRecord["recordType"]
): void {
  const target = recordType === "transport"
    ? { table: "transport_observations", id: "observation_id" }
    : recordType === "measurement"
      ? { table: "runtime_measurements", id: "measurement_id" }
      : { table: "diagnostic_events", id: "event_id" };
  database.prepare(`
    DELETE FROM telemetry_record_deliveries
     WHERE record_type = ?
       AND record_id NOT IN (SELECT ${target.id} FROM ${target.table})
  `).run(recordType);
}

function trimTable(
  database: Database.Database,
  table: "transport_observations" | "runtime_measurements" | "diagnostic_events",
  id: "observation_id" | "measurement_id" | "event_id",
  limit: number
): void {
  database.prepare(`
    DELETE FROM ${table}
     WHERE ${id} NOT IN (
       SELECT ${id} FROM ${table} ORDER BY ${id} DESC LIMIT ?
     )
  `).run(limit);
}

function persistDropCounters(
  database: Database.Database,
  counters: DropCounterRecord[]
): void {
  if (counters.length > 128) throw new Error("Too many telemetry drop counter kinds.");
  database.transaction(() => {
    const statement = database.prepare(`
      INSERT INTO telemetry_drop_counters(kind, dropped_count, first_at, last_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET
        dropped_count=MAX(telemetry_drop_counters.dropped_count, excluded.dropped_count),
        first_at=MIN(telemetry_drop_counters.first_at, excluded.first_at),
        last_at=MAX(telemetry_drop_counters.last_at, excluded.last_at)
    `);
    for (const counter of counters) {
      const normalized = normalizeDropCounter(counter);
      statement.run(
        normalized.kind,
        normalized.droppedCount,
        normalized.firstAt,
        normalized.lastAt
      );
    }
  })();
}

function updateTelemetryRecordId(entry: QueuedTelemetryRecord, recordId: number): void {
  entry.id = recordId;
  if (entry.recordType === "transport") entry.record.observationId = recordId;
  else if (entry.recordType === "measurement") entry.record.measurementId = recordId;
  else entry.record.eventId = recordId;
}

function normalizeMeasurement(
  input: RuntimeMeasurementInput | RuntimeMeasurementRecord,
  measurementId: number
): RuntimeMeasurementRecord {
  if (!Number.isSafeInteger(measurementId) || measurementId < 1) {
    throw new Error("Invalid telemetry measurement id.");
  }
  if (!["state", "execution", "read", "telemetry", "ingress"].includes(input.component)) {
    throw new Error("Invalid telemetry measurement component.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(String(input.metric || ""))) {
    throw new Error("Invalid telemetry metric.");
  }
  const count = "count" in input && input.count !== undefined ? input.count : 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
    throw new Error("Invalid telemetry measurement count.");
  }
  const values = "durationMs" in input
    ? { minMs: input.durationMs, maxMs: input.durationMs, sumMs: input.durationMs * count }
    : { minMs: input.minMs, maxMs: input.maxMs, sumMs: input.sumMs };
  const { minMs, maxMs, sumMs } = values;
  if (![minMs, maxMs, sumMs].every(value =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000 * count
  ) || minMs > maxMs) {
    throw new Error("Invalid telemetry measurement value.");
  }
  const createdAt = "createdAt" in input ? input.createdAt : input.now ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("Invalid telemetry measurement timestamp.");
  }
  return {
    measurementId,
    component: input.component,
    metric: input.metric,
    count,
    minMs,
    maxMs,
    sumMs,
    createdAt
  };
}

function normalizeDiagnosticEvent(
  input: DiagnosticEventInput | DiagnosticEventRecord,
  eventId: number
): DiagnosticEventRecord {
  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    throw new Error("Invalid telemetry diagnostic event id.");
  }
  if (!["info", "warning", "error"].includes(input.severity) ||
      !["state", "execution", "read", "telemetry", "ingress"].includes(input.component) ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(String(input.code || ""))) {
    throw new Error("Invalid telemetry diagnostic event.");
  }
  const createdAt = "createdAt" in input ? input.createdAt : input.now ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("Invalid telemetry diagnostic timestamp.");
  }
  return {
    eventId,
    severity: input.severity,
    component: input.component,
    code: input.code,
    createdAt
  };
}

function normalizeDropCounter(input: DropCounterRecord): DropCounterRecord {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(String(input.kind || "")) ||
      !Number.isSafeInteger(input.droppedCount) || input.droppedCount < 1 ||
      !Number.isSafeInteger(input.firstAt) || input.firstAt < 0 ||
      !Number.isSafeInteger(input.lastAt) || input.lastAt < input.firstAt) {
    throw new Error("Invalid telemetry drop counter.");
  }
  return { ...input };
}

function readDropCounter(row: Record<string, unknown>): DropCounterRecord {
  return normalizeDropCounter({
    kind: String(row.kind),
    droppedCount: Number(row.dropped_count),
    firstAt: Number(row.first_at),
    lastAt: Number(row.last_at)
  });
}

function normalizeRecord(
  input: TransportObservationInput | TransportObservationRecord,
  bridgeInstanceId: string,
  observationId: number
): TransportObservationRecord {
  if (!Number.isSafeInteger(observationId) || observationId < 1) {
    throw new Error("Invalid telemetry observation id.");
  }
  if (!TRANSPORT_OBSERVATION_KINDS.includes(input.kind)) {
    throw new Error("Unsupported transport observation kind.");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!uuid.test(bridgeInstanceId)) throw new Error("Invalid telemetry bridge instance id.");
  const optionalId = (value: string | undefined, name: string) => {
    if (value !== undefined && !uuid.test(value)) throw new Error(`Invalid telemetry ${name}.`);
    return value;
  };
  const reasonCode = String(input.reasonCode || "");
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(reasonCode)) {
    throw new Error("Invalid telemetry reason code.");
  }
  const toolName = input.toolName === undefined ? undefined : String(input.toolName);
  if (toolName !== undefined && (toolName.length < 1 || Buffer.byteLength(toolName, "utf8") > 100)) {
    throw new Error("Invalid telemetry tool name.");
  }
  const callerRequestDigest = input.callerRequestDigest === undefined
    ? undefined
    : String(input.callerRequestDigest);
  if (callerRequestDigest !== undefined && !/^[a-f0-9]{64}$/u.test(callerRequestDigest)) {
    throw new Error("Invalid telemetry request digest.");
  }
  const createdAt = "createdAt" in input
    ? input.createdAt
    : input.now ?? Date.now();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("Invalid telemetry timestamp.");
  }
  return {
    observationId,
    kind: input.kind,
    ...((input.scopeId && { scopeId: optionalId(input.scopeId, "scope id") }) || {}),
    ...((input.jobId && { jobId: optionalId(input.jobId, "job id") }) || {}),
    ...((input.activityId && { activityId: optionalId(input.activityId, "activity id") }) || {}),
    ...(toolName ? { toolName } : {}),
    ...(callerRequestDigest ? { callerRequestDigest } : {}),
    bridgeInstanceId,
    reasonCode,
    createdAt
  };
}

function readRow(row: Record<string, unknown>): TransportObservationRecord {
  return normalizeRecord({
    observationId: Number(row.observation_id),
    kind: row.kind as TransportObservationKind,
    ...(row.scope_id ? { scopeId: String(row.scope_id) } : {}),
    ...(row.job_id ? { jobId: String(row.job_id) } : {}),
    ...(row.activity_id ? { activityId: String(row.activity_id) } : {}),
    ...(row.tool_name ? { toolName: String(row.tool_name) } : {}),
    ...(row.caller_request_digest
      ? { callerRequestDigest: String(row.caller_request_digest) }
      : {}),
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    createdAt: Number(row.created_at)
  }, String(row.bridge_instance_id), Number(row.observation_id));
}

function trimRecords(records: TransportObservationRecord[]): void {
  if (records.length > RETENTION_LIMIT) records.splice(0, records.length - RETENTION_LIMIT);
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "fatal") return typeof message.message === "string";
  if (message.type === "ready") {
    return typeof message.generation==="string" && isUuid(message.generation) && Array.isArray(message.records) && Number.isSafeInteger(message.nextRecordId) &&
      Array.isArray(message.dropCounters);
  }
  if (message.type === "drop-ack") return typeof message.ok === "boolean";
  return message.type === "ack" &&
    ["transport", "measurement", "diagnostic"].includes(String(message.recordType)) &&
    typeof message.deliveryId === "string" && isUuid(message.deliveryId) &&
    Number.isSafeInteger(message.recordId) && typeof message.ok === "boolean";
}

function isParentMessage(value: unknown): value is ParentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "close") return true;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_MESSAGE_BYTES) return false;
  if (message.type === "drops") return Array.isArray(message.counters);
  return message.type === "record" && typeof message.entry === "object" &&
    message.entry !== null &&
    isUuid(String((message.entry as Record<string, unknown>).deliveryId || ""));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function shouldRebuildTelemetryDatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "TELEMETRY_SOURCE_MISMATCH",
    "Unsupported telemetry database schema version",
    "Telemetry database identity is invalid",
    "database disk image is malformed",
    "file is not a database"
  ].some(marker => message.includes(marker));
}

/**
 * Diagnostic state is disposable, but evidence of a rejected database is not
 * silently deleted. Move the database and its SQLite sidecars together so an
 * operator can inspect or recover them without ever selecting them as the
 * active telemetry owner again.
 */
function quarantineTelemetryDatabase(file: string): string {
  const rejectedDirectory = `${file}.rejected-${Date.now()}-${randomUUID()}`;
  mkdirSync(rejectedDirectory, { recursive: false, mode: 0o700 });
  let moved = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${file}${suffix}`;
    if (!existsSync(source)) continue;
    renameSync(source, path.join(rejectedDirectory, path.basename(source)));
    moved = true;
  }
  if (!moved) throw new Error("TELEMETRY_QUARANTINE_EMPTY: No telemetry database was moved.");
  return rejectedDirectory;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

const childFile = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
const childSourceStateDatabaseId = process.argv[process.argv.indexOf(CHILD_FLAG) + 2];
const childControllerId=process.argv[process.argv.indexOf(CHILD_FLAG)+3];
if (process.argv.includes(CHILD_FLAG)) {
  if (!childFile || !childControllerId || !isUuid(childControllerId)) throw new Error("Telemetry database path and private controller UUID are required.");
  await runChild(
    childFile,
    process.argv.includes(FREEZE_PAGE_COUNT_FLAG),
    childSourceStateDatabaseId && childSourceStateDatabaseId !== "-"
      ? childSourceStateDatabaseId
      : undefined,
    childControllerId
  );
}
