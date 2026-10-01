import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { CodexService, type CodexSessionAuthBoundaryEvidence } from "./codexService.js";
import { ScopeResolver } from "./scopeResolver.js";
import { createBridgeMcpServer } from "./server.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  CodexJobRegistry,
  TaskProjectAvailabilityProjection,
  type BridgeApplicationService,
  type BridgeDashboardEnrichment,
  type BridgeDashboardHistoryDetailOptions,
  type BridgeDashboardRuntimePlan,
  type BridgeDashboardSnapshotOptions,
  type BridgeReadProjectionService,
  type BridgeSettingsSnapshotOptions,
  type DashboardHistoryDetail,
  type DashboardView,
  type SettingsView
} from "./tools.js";
import type { CodexUpstream, ToolResult } from "./upstream.js";
import { UserSettingsStore } from "./userSettings.js";
import {OwnedProcessShutdown,beginOrdinaryOwnedProcessStop,isOwnedProcessNonforcing} from "./ownedProcessShutdown.js";
import {ExecutionShutdownOwner} from "./executionShutdownOwner.js";
import {snapshotExecutionShutdownRequest} from "./executionShutdownProtocol.js";
import {snapshotShutdownPolicy,shutdownResult,type ShutdownPolicy,type ShutdownResult} from "./shutdown.js";

const CHILD_FLAG = "--bridge-state-read-child";
const PROTOCOL_VERSION = 3;
const HEARTBEAT_MS = 250;
const STALE_MS = 2_000;
const STARTUP_TIMEOUT_MS = 10_000;
const REQUEST_DEADLINE_MS = 10_000;
const CAPACITY = 16;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const FORCE_CLOSE_MS = 2_000;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;

const READ_METHODS = [
  "dashboardSnapshot",
  "dashboardHistoryDetail",
  "settingsSnapshot",
  "dashboardRuntimePlan",
  "dashboardSnapshotWithEnrichment"
] as const;
type ReadMethod = (typeof READ_METHODS)[number];
type PublicReadMethod = "dashboardSnapshot" | "dashboardHistoryDetail" | "settingsSnapshot";

type ReadyMessage = {
  type: "ready";
  version: number;
  generation: string;
  heartbeatAt: number;
};
type HeartbeatMessage = {
  type: "heartbeat";
  generation: string;
  heartbeatAt: number;
  inFlight: number;
};
type OperationMessage = {
  type: "operation";
  generation: string;
  requestId: string;
  method: PublicReadMethod;
  phase: "queue-wait" | "read-snapshot" | "serializing" | "responding";
  startedAt: number;
  observedAt: number;
};
type ResponseMessage = {
  type: "response";
  generation: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};
type FatalMessage = { type: "fatal"; message: string };
type ChildMessage = ReadyMessage | HeartbeatMessage | OperationMessage | ResponseMessage | FatalMessage;

type RequestMessage = {
  type: "request";
  generation: string;
  requestId: string;
  method: ReadMethod;
  args: unknown[];
  authBoundary: CodexSessionAuthBoundaryEvidence | null;
};
type CloseMessage = { type: "close" };
type ParentMessage = RequestMessage | CloseMessage;

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  /** Caller deadline elapsed, but the child request still occupies capacity. */
  abandoned: boolean;
};

export type StateReadServiceHealth = {
  ready: boolean;
  reason: "ready" | "read-starting" | "read-stale" | "read-recovering" | "read-capacity";
  generation?: string;
  heartbeatAgeMs?: number;
  inFlight: number;
  capacity: number;
  lastSnapshotAt?: number;
  activeOperation?: {
    method: PublicReadMethod;
    phase: "queue-wait" | "read-snapshot" | "serializing" | "responding";
    startedAt: number;
    observedAt: number;
  };
};

export class ChildProcessStateReadService implements BridgeReadProjectionService {
  private child?: ChildProcess;
  private generation?: string;
  private lastHeartbeatAt?: number;
  private lastSnapshotAt?: number;
  private activeOperation?: StateReadServiceHealth["activeOperation"];
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private closePromise?: Promise<void>;
  private restartTimer?: NodeJS.Timeout;
  private restartAttempts = 0;
  private shutdown?:OwnedProcessShutdown;
  private startupTimer?:NodeJS.Timeout;
  private closeWait?:()=>void;
  private nonforcingClose?:Promise<ShutdownResult>;

  private constructor(
    private readonly file: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly requestDeadlineMs: number,
    private readonly authBoundary: () => CodexSessionAuthBoundaryEvidence | null
  ) {}

  static async start(
    file: string,
    environment: NodeJS.ProcessEnv = process.env,
    options: {
      /** Test/diagnostic override. */ requestDeadlineMs?: number;
      /** Read-only ownership evidence from the operational service, never an execution grant. */
      authBoundary?: () => CodexSessionAuthBoundaryEvidence | null;
    } = {}
  ): Promise<ChildProcessStateReadService> {
    const requestDeadlineMs = options.requestDeadlineMs ?? REQUEST_DEADLINE_MS;
    if (!Number.isSafeInteger(requestDeadlineMs) || requestDeadlineMs < 1) {
      throw new Error("STATE_READ_DEADLINE_INVALID: Read deadline must be a positive integer.");
    }
    const service = new ChildProcessStateReadService(file, environment, requestDeadlineMs,
      options.authBoundary || (() => null));
    try {
      await service.spawnAndWait();
      return service;
    } catch (error) {
      await service.close().catch(() => undefined);
      throw error;
    }
  }

  dashboardSnapshot(options?: BridgeDashboardSnapshotOptions): Promise<DashboardView> {
    return this.rpc("dashboardSnapshot", [options || {}]) as Promise<DashboardView>;
  }

  dashboardHistoryDetail(
    options: BridgeDashboardHistoryDetailOptions
  ): Promise<DashboardHistoryDetail> {
    return this.rpc("dashboardHistoryDetail", [options]) as Promise<DashboardHistoryDetail>;
  }

  settingsSnapshot(options?: BridgeSettingsSnapshotOptions): Promise<SettingsView> {
    return this.rpc("settingsSnapshot", [options || {}]) as Promise<SettingsView>;
  }

  dashboardRuntimePlan(
    options?: BridgeDashboardSnapshotOptions
  ): Promise<BridgeDashboardRuntimePlan> {
    return this.rpc("dashboardRuntimePlan", [options || {}]) as Promise<BridgeDashboardRuntimePlan>;
  }

  dashboardSnapshotWithEnrichment(
    options: BridgeDashboardSnapshotOptions,
    enrichment: BridgeDashboardEnrichment
  ): Promise<DashboardView> {
    return this.rpc("dashboardSnapshotWithEnrichment", [options, enrichment]) as Promise<DashboardView>;
  }

  /** Test/supervisor visibility only; never exposed through the Bridge protocol. */
  get processId(): number | undefined {
    return this.child?.pid;
  }

  health(now = Date.now()): StateReadServiceHealth {
    const processConnected = Boolean(this.child?.connected && this.child.exitCode === null);
    const heartbeatAgeMs = this.lastHeartbeatAt === undefined
      ? undefined
      : Math.max(0, now - this.lastHeartbeatAt);
    const fresh = !this.closed && processConnected && Boolean(this.generation) &&
      heartbeatAgeMs !== undefined && heartbeatAgeMs <= STALE_MS;
    const reason = !processConnected
      ? "read-recovering"
      : !this.generation || heartbeatAgeMs === undefined
        ? "read-starting"
        : !fresh
          ? "read-stale"
          : this.pending.size >= CAPACITY
            ? "read-capacity"
            : "ready";
    return {
      ready: reason === "ready",
      reason,
      ...(this.generation ? { generation: this.generation } : {}),
      ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}),
      inFlight: this.pending.size,
      capacity: CAPACITY,
      ...(this.lastSnapshotAt !== undefined ? { lastSnapshotAt: this.lastSnapshotAt } : {}),
      ...(this.activeOperation ? { activeOperation: { ...this.activeOperation } } : {})
    };
  }

  close(): Promise<void> {
    if(this.shutdown?.pinned)return this.shutdown.closeAfterPin();
    if(this.nonforcingClose)return this.nonforcingClose.then(result=>{if(!result.exited)throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");});
    if (!this.closePromise) this.closePromise = this.closeChild();
    return this.closePromise;
  }

  closeNonforcing(policy:ShutdownPolicy):Promise<ShutdownResult>{
    const snapshot=snapshotShutdownPolicy(policy);
    if(snapshot.allowSigkillEscalation!==false)throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    if(this.nonforcingClose)return this.nonforcingClose;
    if(this.shutdown)return this.nonforcingClose=this.shutdown.closeNonforcing(snapshot);
    this.closed=true;
    if(this.restartTimer)clearTimeout(this.restartTimer);
    return this.nonforcingClose=Promise.resolve(shutdownResult("uncertain"));
  }

  observeNonforcingExit():Promise<ShutdownResult>{
    return this.shutdown?.observeNonforcingExit() ?? Promise.resolve(shutdownResult("uncertain"));
  }

  private rpc(method: ReadMethod, args: unknown[]): Promise<unknown> {
    const child = this.child;
    if (this.closed || !child?.connected || !this.generation) {
      return Promise.reject(new Error("STATE_READ_UNAVAILABLE: Read projection is recovering."));
    }
    if (this.pending.size >= CAPACITY) {
      return Promise.reject(new Error("STATE_READ_CAPACITY: Read projection capacity is exhausted."));
    }
    const requestId = randomUUID();
    let authBoundary: CodexSessionAuthBoundaryEvidence | null;
    try { authBoundary = this.authBoundary(); }
    catch { return Promise.reject(new Error("STATE_READ_AUTH_BOUNDARY_UNAVAILABLE: Ownership evidence could not be read.")); }
    const message: RequestMessage = {
      type: "request",
      generation: this.generation,
      requestId,
      method,
      args,
      authBoundary
    };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_MESSAGE_BYTES) {
      return Promise.reject(new Error("STATE_READ_REQUEST_TOO_LARGE: Read request exceeds its IPC limit."));
    }
    if(this.closed || this.child!==child)return Promise.reject(new Error("STATE_READ_OUTCOME_UNKNOWN"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending || pending.abandoned) return;
        pending.abandoned = true;
        reject(new Error(
          "STATE_READ_STALE: The read projection missed its observation deadline; retain the last confirmed view."
        ));
      }, this.requestDeadlineMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer, abandoned: false });
      child.send(message, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        if(isOwnedProcessNonforcing(child))return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        if (!pending.abandoned) {
          pending.reject(new Error(`STATE_READ_SEND_FAILED: ${error.message}`));
        }
      });
    });
  }

  private spawnAndWait(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("STATE_READ_CLOSED: Read projection closed."));
    }
    const modulePath = fileURLToPath(import.meta.url);
    const controllerId=randomUUID();
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG, this.file]
      : [modulePath, CHILD_FLAG, this.file];
    args.push(controllerId);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {
        ...this.environment,
        CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: this.file
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    this.child = child;
    this.shutdown=new OwnedProcessShutdown(child,{
      generation:()=>this.generation,
      pin:()=>{
        this.closed=true;
        if(this.restartTimer)clearTimeout(this.restartTimer);
        if(this.startupTimer)clearTimeout(this.startupTimer);
        this.closeWait?.();
        for(const pending of this.pending.values()){
          clearTimeout(pending.timer);
          if(!pending.abandoned)pending.reject(new Error("STATE_READ_OUTCOME_UNKNOWN"));
        }
        return true;
      }
    },controllerId);
    this.generation = undefined;
    this.lastHeartbeatAt = undefined;
    this.activeOperation = undefined;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        const error = new Error("STATE_READ_START_TIMEOUT: Read projection did not become ready.");
        finish(error);
        if(beginOrdinaryOwnedProcessStop(child))child.kill("SIGKILL");
      }, STARTUP_TIMEOUT_MS);
      this.startupTimer=timer;
      timer.unref();
      child.stderr?.on("data", chunk => {
        if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") process.stderr.write(chunk);
      });
      child.once("error", error => {
        finish(error);
        this.onExit(child, error);
      });
      child.once("exit", (code, signal) => {
        const error = new Error(`STATE_READ_PROCESS_EXITED: code=${code}, signal=${signal}`);
        finish(error);
        this.onExit(child, error);
      });
      child.on("message", value => {
        if(isOwnedProcessNonforcing(child))return;
        if (this.child !== child || !isChildMessage(value)) return;
        if (value.type === "fatal") {
          finish(new Error(`STATE_READ_START_FAILED: ${value.message}`));
          return;
        }
        if (value.type === "ready") {
          if (value.version !== PROTOCOL_VERSION) {
            finish(new Error(`STATE_READ_INCOMPATIBLE: version ${value.version}`));
            return;
          }
          this.generation = value.generation;
          this.lastHeartbeatAt = value.heartbeatAt;
          finish();
          return;
        }
        if (value.generation !== this.generation) return;
        if (value.type === "heartbeat") {
          this.lastHeartbeatAt = value.heartbeatAt;
          return;
        }
        if (value.type === "operation") {
          this.activeOperation = {
            method: value.method,
            phase: value.phase,
            startedAt: value.startedAt,
            observedAt: value.observedAt
          };
          return;
        }
        this.activeOperation = undefined;
        const pending = this.pending.get(value.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(value.requestId);
        if (pending.abandoned) return;
        if (value.ok) {
          this.lastSnapshotAt = Date.now();
          pending.resolve(value.result);
        } else {
          pending.reject(new Error(`STATE_READ_FAILED: ${value.error || "Read projection failed."}`));
        }
      });
    });
  }

  private onExit(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    if(isOwnedProcessNonforcing(child))return;
    this.child = undefined;
    this.generation = undefined;
    this.lastHeartbeatAt = undefined;
    this.activeOperation = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.abandoned) {
        pending.reject(new Error(`STATE_READ_UNAVAILABLE: ${error.message}`));
      }
    }
    this.pending.clear();
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

  private async closeChild(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (!pending.abandoned) {
        pending.reject(new Error("STATE_READ_CLOSED: Read projection closed."));
      }
    }
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
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

class ProjectionUpstream implements CodexUpstream {
  async listTools(): Promise<unknown> { return { tools: [] }; }
  async callTool(): Promise<ToolResult> {
    throw new Error("STATE_READ_UPSTREAM_UNAVAILABLE: Runtime inspection stays in the operational process.");
  }
  async close(): Promise<void> {}
}

async function runChild(file: string,controllerId:string): Promise<void> {
  const generation = randomUUID();
  const codexService = new CodexService(process.env);
  const unverifiedReadBoundary = randomUUID();
  let closing = false;
  let inFlight = 0;
  let tail: Promise<void> = Promise.resolve();
  let resourceCloseUncertain=false;
  const send = (message: ChildMessage) => {
    if (!process.connected || !process.send) return;
    try { process.send(message, () => {}); } catch { /* Parent owns recovery. */ }
  };
  const heartbeat = setInterval(() => send({
    type: "heartbeat",
    generation,
    heartbeatAt: Date.now(),
    inFlight
  }), HEARTBEAT_MS);
  heartbeat.unref();
  const resources=async()=>{
    await tail;
    return resourceCloseUncertain || inFlight!==0 ? shutdownResult("uncertain") : shutdownResult("exited");
  };
  const shutdownOwner=new ExecutionShutdownOwner(generation,process.pid,{
    pin(){closing=true;clearInterval(heartbeat);return true;},
    close:resources,observe:resources
  });
  const handleShutdown=async(value:unknown)=>{
    const receipt=await shutdownOwner.handle(value,controllerId);
    if(!receipt || !process.connected || !process.send)return;
    await new Promise<void>(resolve=>{
      let settled=false;
      const finish=(error?:Error|null)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(error)shutdownOwner.invalidateObservation();
        else if(receipt.operation==="finalize-nonforcing" && receipt.result.exited && shutdownOwner.finalizationAllowed &&
          process.connected)process.disconnect();
        resolve();
      };
      const timer=setTimeout(()=>finish(new Error("STATE_READ_SHUTDOWN_RECEIPT_TIMEOUT")),6000);
      try{process.send!(receipt,finish);}catch{finish(new Error("STATE_READ_SHUTDOWN_RECEIPT_FAILED"));}
    });
  };
  const close = async () => {
    if(shutdownOwner.pinned)return;
    shutdownOwner.markOrdinaryShutdown();
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    await tail.catch(() => undefined);
    if(shutdownOwner.pinned)return;
    if (process.connected) process.disconnect();
  };
  try {
    // Validate the query-only connection before advertising readiness.
    const validation = new BridgeStateStore({ file, readOnly: true });
    validation.close();
    send({
      type: "ready",
      version: PROTOCOL_VERSION,
      generation,
      heartbeatAt: Date.now()
    });
    process.on("message", value => {
      const request=snapshotExecutionShutdownRequest(value);
      if(request){void handleShutdown(request).catch(()=>shutdownOwner.invalidateObservation());return;}
      if(shutdownOwner.pinned)return;
      if (!isParentMessage(value) || closing) return;
      if (value.type === "close") {
        void close();
        return;
      }
      if (value.generation !== generation) return;
      inFlight += 1;
      const startedAt = Date.now();
      const observe = (phase: OperationMessage["phase"]) => send({
        type: "operation",
        generation,
        requestId: value.requestId,
        method: publicReadMethod(value.method),
        phase,
        startedAt,
        observedAt: Date.now()
      });
      observe(inFlight > 1 ? "queue-wait" : "read-snapshot");
      const run = tail.then(async () => {
        observe("read-snapshot");
        const evidence = value.authBoundary;
        // A last-confirmed Keyring owner can label historical read-only rows.
        // Admission independently checks the live account before any execution.
        const boundaryIsCurrent = evidence && evidence.ownerStatus !== "unverified" &&
          evidence.snapshotAt <= Date.now() && Date.now() - evidence.snapshotAt <= REQUEST_DEADLINE_MS;
        const result = await executeProjection(file, value.method, value.args, codexService,
          boundaryIsCurrent ? evidence.key : unverifiedReadBoundary,()=>{resourceCloseUncertain=true;});
        observe("serializing");
        const encoded = JSON.stringify(result === undefined ? null : result);
        if (Buffer.byteLength(encoded, "utf8") > MAX_MESSAGE_BYTES) {
          throw new Error("Read projection response exceeds its IPC limit.");
        }
        observe("responding");
        send({
          type: "response",
          generation,
          requestId: value.requestId,
          ok: true,
          result: result === undefined ? null : result
        });
      }).catch(error => send({
        type: "response",
        generation,
        requestId: value.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })).finally(() => { inFlight = Math.max(0, inFlight - 1); });
      tail = run;
    });
    process.once("disconnect", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
    process.once("SIGINT", () => { void close(); });
  } catch (error) {
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    await close();
    process.exitCode = 1;
  }
}

async function executeProjection(
  file: string,
  method: ReadMethod,
  args: unknown[],
  codexService: CodexService,
  authBoundaryKey: string,
  closeFailure:()=>void
): Promise<unknown> {
  const config = loadConfig({
    ...process.env,
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: file
  });
  // Settings are read in a separate process. They still need the applied CLI
  // selection for model discovery, even though no task worker runs here.
  config.codexService = codexService;
  const stateStore = new BridgeStateStore({ file, readOnly: true });
  try {
  const upstream = new ProjectionUpstream();
  const sessions = new SessionRegistry({
    stateStore,
    allowedRoots: config.allowedRoots,
    maxSessions: 1_000_000,
    projectionOnly: true,
    authBoundary: { key: authBoundaryKey, allowLegacyShared: false }
  });
  const jobs = new CodexJobRegistry({
    maxConcurrentJobs: config.maxConcurrentJobs,
    ttlMs: config.jobTtlMs,
    maxJobs: Math.max(config.maxRetainedJobs, config.maxConcurrentJobs),
    maxResultBytes: config.maxJobResultBytes,
    staleAfterMs: config.jobStaleAfterMs,
    stateStore,
    allowedRoots: config.allowedRoots,
    projectionOnly: true
  });
  const userSettings = new UserSettingsStore(config, {
    stateStore,
    projectionOnly: true
  });
  const scopeResolver = new ScopeResolver({ stateStore });
  const projectAvailability = new TaskProjectAvailabilityProjection(config);
  const server = createBridgeMcpServer(
    config,
    upstream,
    sessions,
    jobs,
    undefined,
    userSettings,
    scopeResolver,
    projectAvailability
  );
  try {
    const operation = server.applicationService[method];
    if (typeof operation !== "function") {
      throw new Error(`Unsupported read projection method: ${method}`);
    }
    return await (operation as (...values: unknown[]) => unknown).apply(
      server.applicationService,
      args
    );
  } finally {
    const failures:unknown[]=[];
    for(const close of [()=>server.close(),()=>upstream.close()]){
      try{await close();}catch(error){closeFailure();failures.push(error);}
    }
    if(failures.length)throw new Error("STATE_READ_RESOURCE_CLOSE_UNCONFIRMED");
  }
  } finally {
    try{stateStore.close();}catch{closeFailure();throw new Error("STATE_READ_DATABASE_CLOSE_UNCONFIRMED");}
  }
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "fatal") return typeof message.message === "string";
  if (message.type === "ready") {
    return Number.isSafeInteger(message.version) && typeof message.generation === "string" &&
      Number.isSafeInteger(message.heartbeatAt);
  }
  if (message.type === "heartbeat") {
    return typeof message.generation === "string" && Number.isSafeInteger(message.heartbeatAt) &&
      Number.isSafeInteger(message.inFlight);
  }
  if (message.type === "operation") {
    return typeof message.generation === "string" && typeof message.requestId === "string" &&
      READ_METHODS.includes(message.method as ReadMethod) &&
      ["queue-wait", "read-snapshot", "serializing", "responding"].includes(String(message.phase)) &&
      Number.isSafeInteger(message.startedAt) && Number.isSafeInteger(message.observedAt);
  }
  return message.type === "response" && typeof message.generation === "string" &&
    typeof message.requestId === "string" && typeof message.ok === "boolean";
}

function publicReadMethod(method: ReadMethod): PublicReadMethod {
  return method === "settingsSnapshot"
    ? "settingsSnapshot"
    : method === "dashboardHistoryDetail"
      ? "dashboardHistoryDetail"
      : "dashboardSnapshot";
}

function isParentMessage(value: unknown): value is ParentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "close") return true;
  return message.type === "request" && typeof message.generation === "string" &&
    typeof message.requestId === "string" && READ_METHODS.includes(message.method as ReadMethod) &&
    Array.isArray(message.args) && isReadBoundaryEvidence(message.authBoundary) &&
    Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_MESSAGE_BYTES;
}

function isReadBoundaryEvidence(value: unknown): value is CodexSessionAuthBoundaryEvidence | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const evidence = value as Record<string, unknown>;
  return typeof evidence.key === "string" && /^[a-f0-9]{64}$/.test(evidence.key) &&
    evidence.allowLegacyShared === false &&
    ["observed", "last-confirmed", "unverified"].includes(String(evidence.ownerStatus)) &&
    (evidence.ownerConfirmedAt === null || Number.isSafeInteger(evidence.ownerConfirmedAt)) &&
    Number.isSafeInteger(evidence.snapshotAt) &&
    (evidence.ownerStatus === "unverified" ? evidence.ownerConfirmedAt === null
      : typeof evidence.ownerConfirmedAt === "number" && evidence.ownerConfirmedAt <= (evidence.snapshotAt as number));
}

const childFile = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
const childController = process.argv[process.argv.indexOf(CHILD_FLAG) + 2];
if (process.argv.includes(CHILD_FLAG)) {
  if (!childFile) throw new Error("State read database path is required.");
  if(!childController || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(childController))
    throw new Error("State read child controller identity is required.");
  await runChild(childFile,childController);
}
