import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Readable, type Writable } from "node:stream";
const ownedReadableUnpipe=Readable.prototype.unpipe;
const ownedReadablePause=Readable.prototype.pause;
import type { BridgeConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { createExecutionRuntime } from "./executionRuntime.js";
import { AppServerLateResponseJournal } from "./appServerLateResponses.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  createHttpServer,
  type BridgeHttpServer,
  type BridgeReadinessReason,
  type BridgeReadinessSnapshot
} from "./server.js";
import type { OperationalStateOperationObservation } from "./stateService.js";
import { operationalStateErrorCode } from "./stateServiceProcess.js";
import { ChildProcessStateReadService } from "./stateReadProcess.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  createStdioBridgeRuntime,
  type BridgeStdioRuntime
} from "./stdioServer.js";
import {
  ChildProcessTelemetryService,
  InMemoryTelemetryService,
  type BridgeTelemetryService
} from "./telemetryService.js";
import type {
  BridgeApplicationService,
  BridgeRuntimeAdmissionSnapshot
} from "./tools.js";
import { decodeUtf8Strict } from "./textIntegrity.js";
import {OwnedProcessShutdown,beginOrdinaryOwnedProcessStop,isOwnedProcessNonforcing} from './ownedProcessShutdown.js';
import {ExecutionShutdownOwner} from './executionShutdownOwner.js';
import {snapshotExecutionShutdownRequest} from './executionShutdownProtocol.js';
import {RuntimeOperationFence} from './runtimeOperationFence.js';
import {RuntimeResourceShutdown,type RuntimeResourceHooks} from './runtimeResourceShutdown.js';
import {snapshotNonforcingData} from './nonforcingData.js';
import {boundedShutdown,combineShutdown,snapshotShutdownPolicy,shutdownResult,type ShutdownPolicy,type ShutdownResult} from './shutdown.js';

type RuntimeStateServiceStatus = NonNullable<
  BridgeRuntimeAdmissionSnapshot["stateService"]
>["status"];

const CHILD_FLAG = "--isolated-bridge-runtime-child";
const CHILD_STDIO_FLAG = "--stdio";
const STATE_OWNER_PROTOCOL = "bridge-operational-state-owner" as const;
const STATE_OWNER_PROTOCOL_VERSION = 3 as const;
const RUNTIME_CONTROLLER_ENV="CODEX_MCP_BRIDGE_PRIVATE_RUNTIME_CONTROLLER";
const RUNTIME_GENERATION_ENV="CODEX_MCP_BRIDGE_PRIVATE_RUNTIME_GENERATION";
const HEARTBEAT_INTERVAL_MS = 250;
const HEARTBEAT_STALE_MS = 2_000;
// These are observation budgets. They never limit the lifetime of a Codex Job.
const RPC_OBSERVATION_TIMEOUT_MS = 120_000;
const PROXY_IDLE_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 20_000;
const FORCE_CLOSE_MS = 5_000;
const MAX_PENDING_REQUESTS = 128;
// HTTP/MCP traffic cannot consume the final slots used by native control,
// completion delivery, cancellation, and authoritative recovery reads.
const CRITICAL_RPC_RESERVE = 16;
const MAX_PROXY_REQUESTS = MAX_PENDING_REQUESTS - CRITICAL_RPC_RESERVE;
const NATIVE_CONTROL_RESERVE = 8;
const MAX_RPC_BYTES = 8 * 1024 * 1024;
const MAX_PROXY_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
const PRIORITY_PROXY_BYTES_RESERVE = 8 * 1024 * 1024;
const MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT =
  MAX_PROXY_BYTES_IN_FLIGHT - PRIORITY_PROXY_BYTES_RESERVE;
// A saturated ingress inspects only small, complete tool calls before using
// the slots otherwise reserved for native recovery and control.
const MAX_PRIORITY_MCP_REQUEST_BYTES = 256 * 1024;
// Only request bodies admitted by the existing RPC byte limit can supply an
// error ID. Bound retained bodies across both proxied and rejected requests.
const MAX_MCP_ID_CAPTURE_BYTES_IN_FLIGHT = MAX_PROXY_BYTES_IN_FLIGHT + MAX_RPC_BYTES;
const MCP_REJECTION_BODY_WAIT_MS = 1_000;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;
const RESTART_STABLE_MS = 60_000;

const APPLICATION_RPC_METHODS = [
  "problemAction",
  "historyAction",
  "threadHandoff",
  "dashboardSnapshot",
  "dashboardHistoryDetail",
  "settingsSnapshot",
  "updateSettings",
  "runtimeSnapshot",
  "beginDrain",
  "cancelDrain",
  "claimNativeCompletionNotifications",
  "markNativeCompletionNotificationsDelivered",
  "releaseNativeCompletionNotifications",
  "skillLibrarySnapshot",
  "readBridgeSkill",
  "readBridgeSkillFile",
  "listBridgeSkillVersions",
  "createBridgeSkill",
  "createBridgeSkillFromPackage",
  "updateBridgeSkill",
  "updateBridgeSkillFromPackage",
  "restoreBridgeSkill",
  "setBridgeSkillEnabled",
  "deleteBridgeSkill",
  "beginBridgeSkillPackageUpload",
  "appendBridgeSkillPackageUpload",
  "inspectBridgeSkillPackageUpload",
  "exportBridgeSkillPackage"
] as const;

type ApplicationRpcMethod = (typeof APPLICATION_RPC_METHODS)[number];
type ApplicationRpcKind = "command" | "query" | "control";

const APPLICATION_QUERY_METHODS = new Set<ApplicationRpcMethod>([
  "dashboardSnapshot",
  "dashboardHistoryDetail",
  "settingsSnapshot",
  "runtimeSnapshot",
  "skillLibrarySnapshot",
  "readBridgeSkill",
  "readBridgeSkillFile",
  "listBridgeSkillVersions",
  "inspectBridgeSkillPackageUpload",
  "exportBridgeSkillPackage"
]);

const APPLICATION_CONTROL_METHODS = new Set<ApplicationRpcMethod>([
  "beginDrain",
  "cancelDrain",
  "claimNativeCompletionNotifications",
  "markNativeCompletionNotificationsDelivered",
  "releaseNativeCompletionNotifications"
]);

type RuntimeReadyMessage = {
  type: "ready";
  protocol: typeof STATE_OWNER_PROTOCOL;
  protocolVersion: number;
  transport: RuntimeTransport;
  controllerId:string;
  generation: string;
  port?: number;
  heartbeatAt: number;
  runtimeHealth: BridgeRuntimeAdmissionSnapshot;
  lastCommitAt?: number;
};

type RuntimeHeartbeatMessage = {
  type: "heartbeat";
  generation: string;
  heartbeatAt: number;
  runtimeHealth: BridgeRuntimeAdmissionSnapshot;
  lastCommitAt?: number;
};

type RuntimeOperationMessage = {
  type: "operation";
  generation: string;
  observation: OperationalStateOperationObservation;
};

type RuntimeOperationClearMessage = {
  type: "operation-clear";
  generation: string;
};

type RuntimeChangeMessage = {
  type: "change";
  generation: string;
  topic: "dashboard" | "settings" | "enrichment";
};

type RuntimeExecutionProcessMessage = {
  type: "execution-process";
  generation: string;
  processId: number;
};

type RuntimeRpcResponseMessage = {
  type: "rpc-response";
  generation: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

type RuntimeFatalMessage = { type: "fatal"; message: string };

type RuntimeChildMessage =
  | RuntimeReadyMessage
  | RuntimeHeartbeatMessage
  | RuntimeOperationMessage
  | RuntimeOperationClearMessage
  | RuntimeChangeMessage
  | RuntimeExecutionProcessMessage
  | RuntimeRpcResponseMessage
  | RuntimeFatalMessage;

type RuntimeRpcRequestMessage = {
  type: "rpc";
  protocol: typeof STATE_OWNER_PROTOCOL;
  protocolVersion: typeof STATE_OWNER_PROTOCOL_VERSION;
  generation: string;
  requestId: string;
  kind: ApplicationRpcKind;
  method: ApplicationRpcMethod;
  args: unknown[];
};

type RuntimeCloseMessage = { type: "close" };
type RuntimeParentMessage = RuntimeRpcRequestMessage | RuntimeCloseMessage;

type PendingRpc = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

type RuntimeTransport = "http" | "stdio";

type RuntimeStorageError = NonNullable<
  NonNullable<BridgeRuntimeAdmissionSnapshot["stateService"]>["storageError"]
>;

type ProxyRequestOutcome = "not-observed" | "unknown";
type ProxyFailureContext = {
  reason?: BridgeReadinessReason;
  limitations?: string[];
};

export type IsolatedStdioRuntime = {
  readonly applicationService: BridgeApplicationService;
  close(): Promise<void>;
  closeNonforcing(policy:ShutdownPolicy):Promise<ShutdownResult>;
  observeNonforcingExit():Promise<ShutdownResult>;
};

/**
 * Production ingress boundary. The public HTTP and native companion listeners
 * stay in this process. One supervised state-owner child holds operational
 * SQLite authority and application orchestration; it supervises a separate
 * SQLite-free Codex execution child. A synchronous database stall can make
 * readiness stale, but cannot occupy the public liveness event loop or the
 * Codex executor.
 */
export async function createIsolatedHttpServer(
  config: BridgeConfig,
  options: {
    childEnvironment?: NodeJS.ProcessEnv;
    conformanceFixtures?: boolean;
    /** Test/diagnostic hook; process identity is never exposed over MCP or HTTP. */
    onRuntimeProcessSpawn?: (processId: number) => void;
    /** Test/diagnostic hook for the independently supervised Codex executor. */
    onExecutionProcessSpawn?: (processId: number) => void;
    /** Test-only override for deterministic replacement-timeout coverage. */
    restartStartupTimeoutMs?: number;
  } = {}
): Promise<BridgeHttpServer> {
  const childEnvironment = {
    ...(options.childEnvironment || process.env),
    // Keep the child pinned to the exact durable paths selected by the parent.
    // This also makes programmatic/test configurations deterministic instead
    // of silently reopening defaults from the ambient environment.
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: config.stateDatabaseFile,
    CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: config.telemetryDatabaseFile,
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: config.modelCatalogStateFile,
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: config.bridgeSkillsDirectory
  };
  const runtime = await IsolatedRuntimeController.start(
    "http",
    childEnvironment,
    options.conformanceFixtures === true,
    undefined,
    undefined,
    options.onRuntimeProcessSpawn,
    options.onExecutionProcessSpawn,
    options.restartStartupTimeoutMs
  );
  const applicationService = runtime.applicationService();
  const server = createServer((request, response) => {
    if(runtime.nonforcingShutdownPinned){writeJson(response,503,{error:"RUNTIME_NONFORCING_PINNED"});return;}
    const pathname = new URL(request.url || "/", "http://bridge.invalid").pathname;
    if (pathname === "/healthz" && request.method === "GET") {
      writeJson(response, 200, {
        ok: true,
        name: PRODUCT_INFO.runtimeName,
        title: PRODUCT_INFO.displayName
      });
      return;
    }
    if (pathname === "/readyz" && request.method === "GET") {
      const snapshot = runtime.readiness();
      writeJson(response, snapshot.ready ? 200 : 503, {
        ok: snapshot.ready,
        name: PRODUCT_INFO.runtimeName,
        reason: snapshot.reason,
        limitations: snapshot.limitations,
        ...(snapshot.stateService ? { stateService: snapshot.stateService } : {})
      });
      return;
    }
    runtime.proxy(request, response);
  }) as BridgeHttpServer;

  Object.defineProperty(server, "applicationService", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: applicationService
  });

  const closeHttp = server.close.bind(server);
  const listenHttp=server.listen.bind(server),closeIdle=server.closeIdleConnections.bind(server);
  const sockets=new Set<import('node:net').Socket>();
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  let closePromise: Promise<void> | undefined;
  let nonforcingClose:Promise<ShutdownResult>|undefined,nonforcingPinned=false,nonforcingUnknown=false,ordinaryClosed=false;
  const localObservation=()=>!nonforcingPinned||nonforcingUnknown?shutdownResult('uncertain'):
    !server.listening && sockets.size===0?shutdownResult('exited'):shutdownResult('timeout',Math.max(1,sockets.size));
  server.listen=((...args:unknown[])=>{if(nonforcingPinned)throw new Error('RUNTIME_NONFORCING_PINNED');return Reflect.apply(listenHttp,server,args);}) as BridgeHttpServer['listen'];
  server.pinNonforcingShutdown=()=>{if(!nonforcingPinned){nonforcingPinned=true;nonforcingUnknown ||= ordinaryClosed;void runtime.closeNonforcing({allowSigkillEscalation:false});}return true;};
  server.observeNonforcingExit=async()=>combineShutdown([localObservation(),await runtime.observeNonforcingExit()]);
  server.closeNonforcing=policy=>{
    const supplied=snapshotShutdownPolicy(policy);if(supplied.allowSigkillEscalation!==false)throw new Error('NONFORCING_SHUTDOWN_POLICY_REQUIRED');
    if(nonforcingClose)return nonforcingClose;
    let finish!:(value:ShutdownResult)=>void;nonforcingClose=new Promise(resolve=>finish=resolve);
    nonforcingPinned=true;nonforcingUnknown ||= ordinaryClosed;
    const remote=runtime.closeNonforcing(supplied);
    const local=new Promise<void>((resolve,reject)=>{try{closeHttp(error=>error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve());}catch(error){reject(error);}});
    try{closeIdle();}catch{nonforcingUnknown=true;}
    const resources=Promise.allSettled([local,remote]).then(results=>{if(results.some(r=>r.status==='rejected'))nonforcingUnknown=true;});
    void boundedShutdown(async()=>{
      let timer:NodeJS.Timeout|undefined;
      try{await Promise.race([resources,new Promise<void>(resolve=>{timer=setTimeout(resolve,supplied.graceMs*2+6000);})]);}finally{if(timer)clearTimeout(timer);}
      return server.observeNonforcingExit();
    },Math.min(180000,supplied.graceMs*2+12000)).then(finish);
    return nonforcingClose;
  };
  server.close = ((callback?: (error?: Error) => void) => {
    if(nonforcingPinned){void (nonforcingClose??Promise.resolve(shutdownResult('uncertain'))).then(result=>callback?.(result.exited?undefined:new Error('NONFORCING_SHUTDOWN_UNCONFIRMED')));return server;}
    ordinaryClosed=true;
    if (!closePromise) {
      closePromise = new Promise<void>((resolve, reject) => {
        closeHttp(error => error ? reject(error) : resolve());
      }).catch(error => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ERR_SERVER_NOT_RUNNING") throw error;
      }).then(() => runtime.close());
    }
    void closePromise.then(() => callback?.(), error => callback?.(
      error instanceof Error ? error : new Error(String(error))
    ));
    return server;
  }) as BridgeHttpServer["close"];

  return server;
}

/**
 * Persistent stdio transport with the same process boundary as HTTP. The
 * parent owns the tunnel pipe and native companion sockets; the state owner
 * owns operational SQLite, while Codex execution runs in its own child.
 */
export async function createIsolatedStdioRuntime(
  config: BridgeConfig,
  options: {
    childEnvironment?: NodeJS.ProcessEnv;
    input?: Readable;
    output?: Writable;
    /** Test/diagnostic hook; process identity is never exposed to stdio clients. */
    onRuntimeProcessSpawn?: (processId: number) => void;
    /** Test/diagnostic hook for the independently supervised Codex executor. */
    onExecutionProcessSpawn?: (processId: number) => void;
    /** Test-only override for deterministic replacement-timeout coverage. */
    restartStartupTimeoutMs?: number;
  } = {}
): Promise<IsolatedStdioRuntime> {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const childEnvironment = {
    ...(options.childEnvironment || process.env),
    CODEX_MCP_BRIDGE_HOST: "127.0.0.1",
    CODEX_MCP_BRIDGE_NO_AUTH: "1",
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: config.stateDatabaseFile,
    CODEX_MCP_BRIDGE_TELEMETRY_DATABASE_FILE: config.telemetryDatabaseFile,
    CODEX_MCP_BRIDGE_MODEL_CATALOG_STATE_FILE: config.modelCatalogStateFile,
    CODEX_MCP_BRIDGE_SKILLS_DIRECTORY: config.bridgeSkillsDirectory
  };
  const runtime = await IsolatedRuntimeController.start(
    "stdio",
    childEnvironment,
    false,
    input,
    output,
    options.onRuntimeProcessSpawn,
    options.onExecutionProcessSpawn,
    options.restartStartupTimeoutMs
  );
  return {
    applicationService: runtime.applicationService(),
    close: () => runtime.close(),
    closeNonforcing:policy=>runtime.closeNonforcing(policy),
    observeNonforcingExit:()=>runtime.observeNonforcingExit()
  };
}

export class IsolatedRuntimeController {
  private child?: ChildProcess;
  private generation?: string;
  private port?: number;
  private lastHeartbeatAt?: number;
  private lastRuntimeHealth?: BridgeRuntimeAdmissionSnapshot;
  private lastCommitAt?: number;
  private activeOperation?: OperationalStateOperationObservation;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly abandoned = new Set<string>();
  private readonly changeListeners = new Set<
    (topic: "dashboard" | "settings" | "enrichment") => void
  >();
  private readonly proxyEdges=new Set<{
    incoming:Readable;outgoing:Writable;proxied?:Writable;response?:Readable;
    capture:McpRequestIdCapture;freeze:()=>void;
  }>();
  private retainProxyContinuation(value?:unknown):boolean {
    if(!this.nonforcingPinned)return false;
    this.nonforcingUnknown=true;
    if(value!==undefined)this.retainedNonforcingMessages.push(value);
    return true;
  }
  private freezeProxyEdges():void {
    for(const edge of this.proxyEdges) {
      try {
        Reflect.apply(ownedReadableUnpipe,edge.incoming,edge.proxied?[edge.proxied]:[]);
        Reflect.apply(ownedReadablePause,edge.incoming,[]);
        if(edge.response){Reflect.apply(ownedReadableUnpipe,edge.response,[edge.outgoing]);Reflect.apply(ownedReadablePause,edge.response,[]);}
        edge.freeze();
      }catch(error){this.nonforcingUnknown=true;this.retainedNonforcingMessages.push(error);}
    }
  }
  private activeProxyRequests = 0;
  private activeProxyBytes = 0;
  private closed = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private startupResolve?: () => void;
  private startupReject?: (error: Error) => void;
  private startupTimer?: NodeJS.Timeout;
  private stderr = "";
  private shutdown?:OwnedProcessShutdown;
  private spawnGeneration?:string;
  private controllerId?:string;
  private nonforcingPinned=false;
  private nonforcingUnknown=false;
  private nonforcingClose?:Promise<ShutdownResult>;
  private readonly requestFence=new RuntimeOperationFence();
  private readonly retainedNonforcingMessages:unknown[]=[];

  private constructor(
    private readonly transport: RuntimeTransport,
    private readonly childEnvironment: NodeJS.ProcessEnv,
    private readonly conformanceFixtures: boolean,
    private readonly input?: Readable,
    private readonly output?: Writable,
    private readonly onRuntimeProcessSpawn?: (processId: number) => void,
    private readonly onExecutionProcessSpawn?: (processId: number) => void,
    private readonly restartStartupTimeoutMs = STARTUP_TIMEOUT_MS
  ) {}

  static async start(
    transport: RuntimeTransport,
    childEnvironment: NodeJS.ProcessEnv = process.env,
    conformanceFixtures = false,
    input?: Readable,
    output?: Writable,
    onRuntimeProcessSpawn?: (processId: number) => void,
    onExecutionProcessSpawn?: (processId: number) => void,
    restartStartupTimeoutMs?: number
  ): Promise<IsolatedRuntimeController> {
    const runtime = new IsolatedRuntimeController(
      transport,
      childEnvironment,
      conformanceFixtures,
      input,
      output,
      onRuntimeProcessSpawn,
      onExecutionProcessSpawn,
      restartStartupTimeoutMs
    );
    try {
      await runtime.spawnAndWait();
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
    return runtime;
  }

  applicationService(): BridgeApplicationService {
    const rpc = <T>(method: ApplicationRpcMethod, ...args: unknown[]) =>
      this.rpc(method, args) as Promise<T>;
    return {
      problemAction: (...args) => rpc("problemAction", ...args),
      historyAction: (...args) => rpc("historyAction", ...args),
      threadHandoff: (...args) => rpc("threadHandoff", ...args),
      dashboardSnapshot: (...args) => rpc("dashboardSnapshot", ...args),
      dashboardHistoryDetail: (...args) => rpc("dashboardHistoryDetail", ...args),
      settingsSnapshot: (...args) => rpc("settingsSnapshot", ...args),
      updateSettings: (...args) => rpc("updateSettings", ...args),
      runtimeSnapshot: (...args) => rpc("runtimeSnapshot", ...args),
      runtimeHealth: () => this.runtimeHealth(),
      beginDrain: (...args) => rpc("beginDrain", ...args),
      cancelDrain: (...args) => rpc("cancelDrain", ...args),
      claimNativeCompletionNotifications: (...args) =>
        rpc("claimNativeCompletionNotifications", ...args),
      markNativeCompletionNotificationsDelivered: (...args) =>
        rpc("markNativeCompletionNotificationsDelivered", ...args),
      releaseNativeCompletionNotifications: (...args) =>
        rpc("releaseNativeCompletionNotifications", ...args),
      skillLibrarySnapshot: (...args) => rpc("skillLibrarySnapshot", ...args),
      readBridgeSkill: (...args) => rpc("readBridgeSkill", ...args),
      readBridgeSkillFile: (...args) => rpc("readBridgeSkillFile", ...args),
      listBridgeSkillVersions: (...args) => rpc("listBridgeSkillVersions", ...args),
      createBridgeSkill: (...args) => rpc("createBridgeSkill", ...args),
      createBridgeSkillFromPackage: (...args) => rpc("createBridgeSkillFromPackage", ...args),
      updateBridgeSkill: (...args) => rpc("updateBridgeSkill", ...args),
      updateBridgeSkillFromPackage: (...args) => rpc("updateBridgeSkillFromPackage", ...args),
      restoreBridgeSkill: (...args) => rpc("restoreBridgeSkill", ...args),
      setBridgeSkillEnabled: (...args) => rpc("setBridgeSkillEnabled", ...args),
      deleteBridgeSkill: (...args) => rpc("deleteBridgeSkill", ...args),
      beginBridgeSkillPackageUpload: (...args) =>
        rpc("beginBridgeSkillPackageUpload", ...args),
      appendBridgeSkillPackageUpload: (...args) =>
        rpc("appendBridgeSkillPackageUpload", ...args),
      inspectBridgeSkillPackageUpload: (...args) =>
        rpc("inspectBridgeSkillPackageUpload", ...args),
      exportBridgeSkillPackage: (...args) => rpc("exportBridgeSkillPackage", ...args),
      subscribeChanges: listener => {
        this.changeListeners.add(listener);
        return () => { this.changeListeners.delete(listener); };
      }
    } as BridgeApplicationService;
  }

  readiness(now = Date.now()): BridgeReadinessSnapshot {
    const heartbeatAgeMs = this.lastHeartbeatAt === undefined
      ? undefined
      : Math.max(0, now - this.lastHeartbeatAt);
    const connected = Boolean(
      this.child?.connected &&
      (this.transport === "stdio" || this.port !== undefined) &&
      this.generation
    );
    const fresh = connected && heartbeatAgeMs !== undefined && heartbeatAgeMs <= HEARTBEAT_STALE_MS;
    const accepting = !this.nonforcingPinned && fresh && this.lastRuntimeHealth?.acceptingNewJobs === true;
    const reportedStateStatus = fresh
      ? this.lastRuntimeHealth?.stateService?.status
      : undefined;
    const executionStatus = fresh
      ? this.lastRuntimeHealth?.executionService?.status
      : undefined;
    const reason = !connected
      ? "state-recovering"
      : !fresh
        ? "state-stale"
        : reportedStateStatus && reportedStateStatus !== "ready"
          ? reportedStateStatus
          : executionStatus && executionStatus !== "idle" && executionStatus !== "ready"
            ? `execution-${executionStatus}` as BridgeReadinessReason
          : !accepting
          ? "admission-draining"
          : this.outstanding >= MAX_PENDING_REQUESTS ||
              this.activeProxyRequests >= MAX_PROXY_REQUESTS ||
              this.activeProxyBytes >= MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT
            ? "state-capacity"
            : "ready";
    return {
      ready: reason === "ready",
      reason,
      limitations: reason === "ready" ? [] : [
        this.lastRuntimeHealth?.stateService?.storageError
          ? `state-storage-${this.lastRuntimeHealth.stateService.storageError}`
          : reason === "state-stale"
            ? this.activeOperation?.access === "read"
              ? "state-read-unconfirmed"
              : this.activeOperation?.access === "write"
                ? "state-write-unconfirmed"
                : "state-response-unconfirmed"
            : reason
      ],
      ...(this.generation ? {
        stateService: {
          protocolVersion: STATE_OWNER_PROTOCOL_VERSION,
          generation: this.generation,
          heartbeatAgeMs: heartbeatAgeMs ?? Number.MAX_SAFE_INTEGER,
          inFlight: this.outstanding,
          queueDepth: Math.max(0, this.outstanding - 1),
          capacity: MAX_PENDING_REQUESTS,
          ...(!fresh && this.activeOperation ? { activeOperation: this.activeOperation } : {}),
          ...(this.lastCommitAt !== undefined ? { lastCommitAt: this.lastCommitAt } : {}),
          ...(this.lastRuntimeHealth?.stateService?.storageError ? {
            storageError: this.lastRuntimeHealth.stateService.storageError,
            storageErrorObservedAt:
              this.lastRuntimeHealth.stateService.storageErrorObservedAt
          } : {})
        }
      } : {})
    };
  }

  runtimeHealth(): BridgeRuntimeAdmissionSnapshot {
    const current = this.lastRuntimeHealth || emptyRuntimeHealth();
    const fresh = !this.nonforcingPinned && this.isFresh();
    const readiness = this.readiness();
    const observationAgeMs = readiness.stateService?.heartbeatAgeMs ?? 0;
    return {
      ...current,
      acceptingNewJobs: !this.nonforcingPinned && fresh && current.acceptingNewJobs,
      backgroundProcessState: fresh ? current.backgroundProcessState : "unknown",
      ...(current.readService ? {
        readService: fresh ? current.readService : {
          ...current.readService,
          status: "read-stale",
          heartbeatAgeMs: (current.readService.heartbeatAgeMs ?? 0) + observationAgeMs
        }
      } : {}),
      ...(current.telemetryService ? {
        telemetryService: fresh ? current.telemetryService : {
          ...current.telemetryService,
          status: "stale"
        }
      } : {}),
      stateService: {
        ...(current.stateService || {}),
        // Admission draining is an execution policy state, not evidence that
        // SQLite or the runtime response boundary is unavailable.
        status: stateServiceStatusForReadiness(
          readiness.reason,
          current.stateService?.status
        ),
        ...(readiness.stateService ? {
          generation: readiness.stateService.generation,
          heartbeatAgeMs: readiness.stateService.heartbeatAgeMs,
          ...(readiness.stateService.activeOperation
            ? { activeOperation: readiness.stateService.activeOperation }
            : {}),
          ...(readiness.stateService.lastCommitAt !== undefined
            ? { lastCommitAt: readiness.stateService.lastCommitAt }
            : {})
        } : {})
      }
    };
  }

  proxy(
    incoming: import("node:http").IncomingMessage,
    outgoing: import("node:http").ServerResponse,
    bufferedRequest?: {
      body: Buffer;
      capture: McpRequestIdCapture;
      priority: boolean;
      ordinarySlotReserved: boolean;
    }
  ): void {
    if(this.nonforcingPinned){writeJson(outgoing,503,{error:'RUNTIME_NONFORCING_PINNED'});return;}
    if (this.port === undefined || !this.child?.connected) {
      if (bufferedRequest) {
        this.activeProxyRequests -= 1;
        writeUnavailable(outgoing, this.readiness(), "not-observed", {}, bufferedRequest.capture.id());
      } else writeMcpUnavailable(incoming, outgoing, this.readiness(), "not-observed");
      return;
    }
    const declaredLength = requestContentLength(incoming.headers);
    if (declaredLength !== undefined && declaredLength > MAX_RPC_BYTES) {
      bufferedRequest?.capture.dispose();
      if (bufferedRequest) this.activeProxyRequests -= 1;
      writeJson(outgoing, 413, {
        ok: false,
        code: "RUNTIME_REQUEST_TOO_LARGE",
        reason: "request-bytes"
      });
      return;
    }
    if (!bufferedRequest && declaredLength !== undefined &&
        this.activeProxyBytes + declaredLength > MAX_PROXY_BYTES_IN_FLIGHT) {
      writeMcpUnavailable(incoming, outgoing, this.readiness(), "not-observed", {
        reason: "state-capacity", limitations: ["state-capacity"]
      });
      return;
    }
    // Another request can consume ordinary bytes after these headers arrive.
    // Classify every unknown-length MCP body before its single dispatch so
    // priority eligibility cannot depend on that arrival order.
    const unknownLengthMcpPost = declaredLength === undefined &&
      incoming.method === "POST" &&
      new URL(incoming.url || "/", "http://bridge.invalid").pathname === "/mcp";
    const ordinarySlotReserved = this.activeProxyRequests < MAX_PROXY_REQUESTS &&
      this.activeProxyBytes < MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT;
    const needsPriorityReservation = this.outstanding >= MAX_PENDING_REQUESTS ||
      this.activeProxyRequests >= MAX_PROXY_REQUESTS ||
      this.activeProxyBytes + (declaredLength ?? 0) > MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT ||
      unknownLengthMcpPost &&
        this.activeProxyBytes > MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT - MAX_PRIORITY_MCP_REQUEST_BYTES;
    if (!bufferedRequest && (
      needsPriorityReservation || unknownLengthMcpPost
    )) {
      if (incoming.method === "POST" && this.outstanding < MAX_PENDING_REQUESTS &&
          this.activeProxyRequests < MAX_PENDING_REQUESTS) {
        this.classifyReservedMcpRequest(incoming, outgoing, {
          ordinarySlotReserved: unknownLengthMcpPost && ordinarySlotReserved,
          normalAdmission: unknownLengthMcpPost && !needsPriorityReservation
        });
      } else {
        writeMcpUnavailable(incoming, outgoing, this.readiness(), "not-observed");
      }
      return;
    }
    const bufferedOrdinaryOverCapacity = bufferedRequest && !bufferedRequest.priority && (
      (!bufferedRequest.ordinarySlotReserved && this.activeProxyRequests > MAX_PROXY_REQUESTS) ||
      this.activeProxyBytes + bufferedRequest.body.length > MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT
    );
    if (bufferedOrdinaryOverCapacity ||
        (declaredLength !== undefined || bufferedRequest) &&
        this.activeProxyBytes + (bufferedRequest?.body.length ?? declaredLength ?? 0) > MAX_PROXY_BYTES_IN_FLIGHT) {
      const failure = { reason: "state-capacity" as const, limitations: ["state-capacity"] };
      if (bufferedRequest) {
        this.activeProxyRequests -= 1;
        writeUnavailable(outgoing, this.readiness(), "not-observed", failure, bufferedRequest.capture.id());
      } else writeMcpUnavailable(incoming, outgoing, this.readiness(), "not-observed", failure);
      return;
    }
    const port = this.port;
    if (!bufferedRequest) this.activeProxyRequests += 1;
    let requestBytes = bufferedRequest?.body.length ?? declaredLength ?? 0;
    this.activeProxyBytes += requestBytes;
    let responseStarted = false;
    let settled = false;
    let requestOutcome: ProxyRequestOutcome = "not-observed";
    const requestIdCapture = bufferedRequest?.capture || new McpRequestIdCapture();
    const edge={incoming,outgoing,capture:requestIdCapture,freeze:()=>{},proxied:undefined as Writable|undefined,response:undefined as Readable|undefined};
    this.proxyEdges.add(edge);
    const finish = () => {
      if(this.retainProxyContinuation())return;
      if (settled) return;
      this.proxyEdges.delete(edge);
      settled = true;
      requestIdCapture.dispose();
      this.activeProxyRequests = Math.max(0, this.activeProxyRequests - 1);
      this.activeProxyBytes = Math.max(0, this.activeProxyBytes - requestBytes);
    };
    const rejectBody = (reason: "request-bytes" | "state-capacity") => {
      if(this.retainProxyContinuation(reason))return;
      proxied.destroy(new Error(
        reason === "request-bytes" ? "RUNTIME_REQUEST_TOO_LARGE" : "RUNTIME_CAPACITY"
      ));
      if (!responseStarted && !outgoing.headersSent) {
        if (reason === "request-bytes") {
          writeJson(outgoing, 413, {
            ok: false,
            code: "RUNTIME_REQUEST_TOO_LARGE",
            reason
          });
        } else {
          writeUnavailable(outgoing, this.readiness(), "not-observed", {
            reason: "state-capacity",
            limitations: ["state-capacity"]
          }, requestIdCapture.id());
        }
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
      finish();
    };
    const proxied = httpRequest({
      host: "127.0.0.1",
      port,
      method: incoming.method,
      path: incoming.url,
      headers: requestHeaders(incoming.headers)
    }, response => {
      edge.response=response;
      if(this.retainProxyContinuation(response)){this.freezeProxyEdges();return;}
      responseStarted = true;
      if (outgoing.destroyed) {
        response.destroy();
        finish();
        return;
      }
      outgoing.writeHead(response.statusCode || 502, responseHeaders(response.headers));
      response.pipe(outgoing);
      response.once("end", finish);
      response.once("error", error => {
        if(this.retainProxyContinuation(error))return;
        if (!outgoing.destroyed) outgoing.destroy(error);
        finish();
      });
    });
    edge.proxied=proxied;
    if(this.retainProxyContinuation(proxied)){this.freezeProxyEdges();return;}
    proxied.once("finish", () => {
      if(this.retainProxyContinuation())return;
      // The full request crossed the supervisor boundary. The child may have
      // acted even if its response or next heartbeat is never observed.
      requestOutcome = "unknown";
    });
    proxied.setTimeout(PROXY_IDLE_TIMEOUT_MS, () => {
      if(this.retainProxyContinuation())return;
      proxied.destroy(new Error("RUNTIME_RESPONSE_UNCONFIRMED"));
      if (!responseStarted && !outgoing.headersSent) {
        writeUnavailable(outgoing, this.readiness(), requestOutcome, {}, requestIdCapture.id());
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
      finish();
    });
    proxied.once("error", error => {
      if(this.retainProxyContinuation(error))return;
      if (!outgoing.headersSent) {
        writeUnavailable(
          outgoing,
          this.readiness(),
          requestOutcome,
          {
            reason: "state-recovering",
            limitations: ["state-response-unconfirmed"]
          },
          requestIdCapture.id()
        );
      } else if (!outgoing.destroyed) {
        outgoing.destroy(error);
      }
      finish();
    });
    incoming.once("aborted", () => {
      if(this.retainProxyContinuation())return;
      proxied.destroy();
      finish();
    });
    outgoing.once("close", () => {
      if(this.retainProxyContinuation())return;
      if (outgoing.writableEnded) return;
      // A completed request body does not emit IncomingMessage.aborted when
      // its caller disconnects while waiting for the response.
      proxied.destroy();
      finish();
    });
    if (!bufferedRequest) incoming.on("data", chunk => {
      if(this.retainProxyContinuation(chunk))return;
      requestIdCapture.append(chunk);
    });
    if (!bufferedRequest) incoming.once("end", () => {if(!this.retainProxyContinuation())requestIdCapture.complete();});
    if (declaredLength === undefined && !bufferedRequest) {
      incoming.on("data", chunk => {
        if(this.retainProxyContinuation(chunk))return;
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        requestBytes += bytes;
        this.activeProxyBytes += bytes;
        if (requestBytes > MAX_RPC_BYTES) rejectBody("request-bytes");
        else if (this.activeProxyBytes > MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT) {
          rejectBody("state-capacity");
        }
      });
    }
    if (bufferedRequest) proxied.end(bufferedRequest.body);
    else incoming.pipe(proxied);
  }

  private classifyReservedMcpRequest(
    incoming: import("node:http").IncomingMessage,
    outgoing: import("node:http").ServerResponse,
    reservation: { ordinarySlotReserved: boolean; normalAdmission: boolean }
  ): void {
    // Reserve before reading so concurrent candidates cannot overfill the
    // physical HTTP limit. Failed classification releases this same slot.
    this.activeProxyRequests += 1;
    const capture = new McpRequestIdCapture();
    let settled = false;
    let reservedBytes = 0;
    let timer:NodeJS.Timeout|undefined;
    const edge={incoming,outgoing,capture,freeze:()=>{if(timer)clearTimeout(timer);}};
    this.proxyEdges.add(edge);
    const releaseBytes = () => {
      if(this.retainProxyContinuation())return;
      this.activeProxyBytes = Math.max(0, this.activeProxyBytes - reservedBytes);
      reservedBytes = 0;
    };
    const cleanup = () => {
      if(this.retainProxyContinuation())return;
      this.proxyEdges.delete(edge);
      if(timer)clearTimeout(timer);
      incoming.off("data", onData);
      incoming.off("end", onEnd);
      incoming.off("close", onClose);
      outgoing.off("close", onClose);
    };
    const reject = (reason: "state-capacity" | "request-bytes" = "state-capacity") => {
      if(this.retainProxyContinuation())return;
      if (settled) return;
      settled = true;
      cleanup();
      releaseBytes();
      this.activeProxyRequests -= 1;
      const id = capture.id();
      capture.dispose();
      if (reason === "request-bytes") {
        writeJson(outgoing, 413, { ok: false, code: "RUNTIME_REQUEST_TOO_LARGE", reason });
      } else {
        writeUnavailable(outgoing, this.readiness(), "not-observed", {
          reason: "state-capacity", limitations: ["state-capacity"]
        }, id);
      }
    };
    const onData = (chunk: Buffer | string) => {
      if(this.retainProxyContinuation(chunk))return;
      if(this.retainProxyContinuation())return;
      if (settled) return;
      if (reservation.normalAdmission) timer?.refresh();
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (reservedBytes + bytes > MAX_RPC_BYTES) { reject("request-bytes"); return; }
      if (this.activeProxyBytes + bytes > MAX_PROXY_BYTES_IN_FLIGHT ||
          !capture.append(chunk)) { reject(); return; }
      reservedBytes += bytes;
      this.activeProxyBytes += bytes;
    };
    const onEnd = () => {
      if(this.retainProxyContinuation())return;
      if (settled) return;
      capture.complete();
      const body = capture.body();
      const priority = body ? isPriorityMcpRequest(body) : false;
      const ordinaryFits = !priority && body &&
        (reservation.ordinarySlotReserved || this.activeProxyRequests <= MAX_PROXY_REQUESTS) &&
        this.activeProxyBytes <= MAX_ORDINARY_PROXY_BYTES_IN_FLIGHT;
      if (!body || new URL(incoming.url || "/", "http://bridge.invalid").pathname !== "/mcp" ||
          !priority && !ordinaryFits) {
        reject(); return;
      }
      settled = true;
      cleanup();
      releaseBytes();
      this.proxy(incoming, outgoing, { body, capture, priority,
        ordinarySlotReserved: reservation.ordinarySlotReserved });
    };
    const onClose = () => reject();
    timer = setTimeout(reject,
      reservation.normalAdmission ? PROXY_IDLE_TIMEOUT_MS : MCP_REJECTION_BODY_WAIT_MS);
    timer.unref();
    incoming.on("data", onData);
    incoming.once("end", onEnd);
    incoming.once("close", onClose);
    outgoing.once("close", onClose);
    incoming.resume();
  }

  async close(): Promise<void> {
    if(this.nonforcingPinned){
      if(!this.nonforcingClose || !(await this.nonforcingClose).exited ||
        !(await this.observeNonforcingExit()).exited || !this.shutdown)throw new Error('NONFORCING_SHUTDOWN_UNCONFIRMED');
      await this.shutdown.closeAfterPin();
      if(!(await this.observeNonforcingExit()).exited)throw new Error('NONFORCING_SHUTDOWN_UNCONFIRMED');
      return;
    }
    if (this.closed) return;
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.rejectPending(new Error("RUNTIME_CLOSED: Isolated Bridge runtime closed."));
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if(this.nonforcingPinned || !beginOrdinaryOwnedProcessStop(child))return;
    if (child.connected) child.send({ type: "close" } satisfies RuntimeCloseMessage);
    await new Promise<void>(resolve => {
      let settled = false;
      const force = setTimeout(() => {if(!this.nonforcingPinned && beginOrdinaryOwnedProcessStop(child))child.kill("SIGKILL");}, FORCE_CLOSE_MS);
      force.unref();
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        resolve();
      };
      child.once("exit", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  }

  get nonforcingShutdownPinned():boolean{return this.nonforcingPinned;}
  private freezeNonforcing():true {
    if(this.nonforcingPinned)return true;
    this.nonforcingPinned=true;
    this.nonforcingUnknown ||= this.closed || !this.generation || this.outstanding>0;
    this.closed=true;this.requestFence.pinNonforcingShutdown();
    this.freezeProxyEdges();
    if(this.restartTimer)clearTimeout(this.restartTimer);
    if(this.stableTimer)clearTimeout(this.stableTimer);
    if(this.startupTimer)clearTimeout(this.startupTimer);
    if(this.transport==='stdio' && this.child?.stdin && this.input)this.input.unpipe(this.child.stdin);
    this.startupReject?.(new Error('RUNTIME_STARTUP_NONFORCING_PINNED'));
    return true;
  }
  closeNonforcing(policy:ShutdownPolicy):Promise<ShutdownResult> {
    const supplied=snapshotShutdownPolicy(policy);if(supplied.allowSigkillEscalation!==false)throw new Error('NONFORCING_SHUTDOWN_POLICY_REQUIRED');
    if(this.nonforcingClose)return this.nonforcingClose;
    let finish!:(value:ShutdownResult)=>void;this.nonforcingClose=new Promise(resolve=>finish=resolve);
    this.freezeNonforcing();
    const owner=this.shutdown;
    if(!owner){this.nonforcingUnknown=true;finish(shutdownResult('uncertain'));return this.nonforcingClose;}
    const operation=owner.closeNonforcing(supplied);
    void boundedShutdown(()=>operation,Math.min(180000,(supplied.graceMs*2+6000)*3)).then(result=>{
      finish(combineShutdown([result,this.nonforcingUnknown?shutdownResult('uncertain'):this.requestFence.observeNonforcingExit()]));
    });
    return this.nonforcingClose;
  }
  async observeNonforcingExit():Promise<ShutdownResult>{
    if(!this.nonforcingPinned || !this.shutdown || this.nonforcingUnknown)return shutdownResult('uncertain');
    return combineShutdown([await this.shutdown.observeNonforcingExit(),this.requestFence.observeNonforcingExit()]);
  }

  private get outstanding(): number {
    return this.pending.size + this.abandoned.size + this.activeProxyRequests;
  }

  private rpcObservationTimeoutMs(): number {
    const configured = Number(this.childEnvironment.CODEX_MCP_BRIDGE_TEST_RPC_OBSERVATION_TIMEOUT_MS);
    return this.childEnvironment.NODE_ENV === "test" &&
      Number.isSafeInteger(configured) && configured >= 50 &&
      configured <= RPC_OBSERVATION_TIMEOUT_MS
      ? configured : RPC_OBSERVATION_TIMEOUT_MS;
  }

  private isFresh(now = Date.now()): boolean {
    return Boolean(
      this.child?.connected &&
      (this.transport === "stdio" || this.port !== undefined) &&
      this.lastHeartbeatAt !== undefined &&
      now - this.lastHeartbeatAt <= HEARTBEAT_STALE_MS
    );
  }

  private rpc(method: ApplicationRpcMethod, args: unknown[]): Promise<unknown> {
    if(this.nonforcingPinned)return Promise.reject(new Error('RUNTIME_NONFORCING_PINNED'));
    const captured=snapshotNonforcingData(args,()=>this.nonforcingPinned);
    if(!captured.ok || this.nonforcingPinned)return Promise.reject(new Error('RUNTIME_REQUEST_DATA_UNCONFIRMED'));
    args=captured.value;
    if (!this.child?.connected || !this.generation) {
      return Promise.reject(new Error(
        "RUNTIME_RESPONSE_UNCONFIRMED: The isolated Bridge runtime is not currently responsive."
      ));
    }
    const control = APPLICATION_CONTROL_METHODS.has(method) ||
      method === "problemAction" &&
        Boolean(args[0] && typeof args[0] === "object" &&
          (args[0] as Record<string, unknown>).action === "retry-stop");
    if (this.outstanding >= MAX_PENDING_REQUESTS ||
        !control && this.outstanding >= MAX_PENDING_REQUESTS - NATIVE_CONTROL_RESERVE) {
      return Promise.reject(new Error("RUNTIME_CAPACITY: Isolated Bridge runtime capacity is exhausted."));
    }
    const requestId = randomUUID();
    const message: RuntimeRpcRequestMessage = {
      type: "rpc",
      protocol: STATE_OWNER_PROTOCOL,
      protocolVersion: STATE_OWNER_PROTOCOL_VERSION,
      generation: this.generation,
      requestId,
      kind: applicationRpcKind(method),
      method,
      args
    };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_RPC_BYTES) {
      return Promise.reject(new Error("RUNTIME_REQUEST_TOO_LARGE: Runtime request exceeds its IPC limit."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if(this.nonforcingPinned)return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        this.abandoned.add(requestId);
        pending.reject(new Error(
          "RUNTIME_RESPONSE_UNCONFIRMED: The isolated Bridge runtime did not answer within the observation budget; the operation outcome is unknown."
        ));
      }, this.rpcObservationTimeoutMs());
      timer.unref();
      this.pending.set(requestId, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.child?.send(message, error => {
        if(this.nonforcingPinned){if(error && this.retainedNonforcingMessages.length<128)this.retainedNonforcingMessages.push(error);return;}
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        pending.reject(new Error(`RUNTIME_SEND_FAILED: ${error.message}`));
      });
    });
  }

  private async spawnAndWait(): Promise<void> {
    if (this.closed) throw new Error("RUNTIME_CLOSED: Isolated Bridge runtime closed.");
    const ready = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });
    const modulePath = fileURLToPath(import.meta.url);
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG]
      : [modulePath, CHILD_FLAG];
    if (this.transport === "stdio") args.push(CHILD_STDIO_FLAG);
    if (this.conformanceFixtures) args.push("--conformance-fixtures");
    const controllerId=randomUUID(),spawnGeneration=randomUUID();
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: {...this.childEnvironment,[RUNTIME_CONTROLLER_ENV]:controllerId,[RUNTIME_GENERATION_ENV]:spawnGeneration},
      stdio: [this.transport === "stdio" ? "pipe" : "ignore", "pipe", "pipe", "ipc"]
    });
    this.child = child;this.controllerId=controllerId;this.spawnGeneration=spawnGeneration;
    this.shutdown=new OwnedProcessShutdown(child,{generation:()=>spawnGeneration,pin:()=>this.freezeNonforcing()},controllerId);
    child.on("message", message => {
      if (this.child === child) this.onMessage(message);
    });
    child.once("error", error => this.onExit(child, error));
    child.once("exit", (code, signal) => this.onExit(
      child,
      new Error(
        `Isolated Bridge runtime exited (code=${code}, signal=${signal}).` +
        (this.stderr ? ` ${this.stderr}` : "")
      )
    ));
    if (child.pid !== undefined) this.onRuntimeProcessSpawn?.(child.pid);
    if(this.nonforcingPinned){await ready;return;}
    this.stderr = "";
    child.stdout?.pipe(this.transport === "stdio" ? this.output || process.stdout : process.stdout);
    if (this.transport === "stdio" && child.stdin && this.input) this.input.pipe(child.stdin);
    child.stderr?.on("data", chunk => {
      if(this.nonforcingPinned){if(this.retainedNonforcingMessages.length<128)this.retainedNonforcingMessages.push(chunk);return;}
      const text = String(chunk);
      this.stderr = (this.stderr + text).slice(-8_192);
      process.stderr.write(text);
    });
    const startupTimeoutMs = this.restartAttempts === 0
      ? STARTUP_TIMEOUT_MS
      : this.restartStartupTimeoutMs;
    this.startupTimer = setTimeout(() => {
      if (this.child !== child || this.generation !== undefined || this.nonforcingPinned || !beginOrdinaryOwnedProcessStop(child)) return;
      child.kill("SIGKILL");
      this.startupReject?.(new Error(
        `RUNTIME_START_TIMEOUT: Isolated Bridge runtime did not start within ` +
        `${startupTimeoutMs} ms.`
      ));
    }, startupTimeoutMs);
    this.startupTimer.unref();
    await ready;
  }

  private onMessage(value: unknown): void {
    if(this.nonforcingPinned){if(this.retainedNonforcingMessages.length<128)this.retainedNonforcingMessages.push(value);return;}
    const captured=snapshotNonforcingData(value,()=>this.nonforcingPinned);
    if(!captured.ok || this.nonforcingPinned)return;
    value=captured.value;
    if (!isRuntimeChildMessage(value)) return;
    if (value.type === "fatal") {
      this.startupReject?.(new Error(`RUNTIME_START_FAILED: ${value.message}`));
      return;
    }
    if (value.type === "ready") {
      if(value.controllerId!==this.controllerId || value.generation!==this.spawnGeneration){this.startupReject?.(new Error('RUNTIME_OWNER_BINDING_MISMATCH'));return;}
      if (
        value.protocol !== STATE_OWNER_PROTOCOL ||
        value.protocolVersion !== STATE_OWNER_PROTOCOL_VERSION
      ) {
        this.startupReject?.(new Error(
          `RUNTIME_PROTOCOL_MISMATCH: Expected ${STATE_OWNER_PROTOCOL_VERSION}, ` +
          `received ${value.protocolVersion}.`
        ));
        return;
      }
      if (value.transport !== this.transport) {
        this.startupReject?.(new Error(
          `RUNTIME_TRANSPORT_MISMATCH: Expected ${this.transport}, received ${value.transport}.`
        ));
        return;
      }
      this.generation = value.generation;
      this.port = value.port;
      this.lastHeartbeatAt = value.heartbeatAt;
      this.lastRuntimeHealth = value.runtimeHealth;
      if (value.lastCommitAt !== undefined) this.lastCommitAt = value.lastCommitAt;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
      this.startupResolve?.();
      this.startupResolve = undefined;
      this.startupReject = undefined;
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => { if(!this.nonforcingPinned)this.restartAttempts = 0; }, RESTART_STABLE_MS);
      this.stableTimer.unref();
      return;
    }
    if (value.generation !== this.generation) return;
    if (value.type === "heartbeat") {
      this.lastHeartbeatAt = value.heartbeatAt;
      this.lastRuntimeHealth = value.runtimeHealth;
      if (value.lastCommitAt !== undefined) this.lastCommitAt = value.lastCommitAt;
      return;
    }
    if (value.type === "operation") {
      this.activeOperation = Object.freeze({ ...value.observation });
      return;
    }
    if (value.type === "operation-clear") {
      this.activeOperation = undefined;
      return;
    }
    if (value.type === "change") {
      for (const listener of this.changeListeners) listener(value.topic);
      return;
    }
    if (value.type === "execution-process") {
      this.onExecutionProcessSpawn?.(value.processId);
      return;
    }
    if (value.type === "rpc-response") {
      if (this.abandoned.delete(value.requestId)) return;
      const pending = this.pending.get(value.requestId);
      if (!pending) return;
      this.pending.delete(value.requestId);
      if (value.ok) pending.resolve(value.result);
      else pending.reject(new Error(
        `${value.error?.code || "RUNTIME_REQUEST_FAILED"}: ` +
        (value.error?.message || "Isolated Bridge runtime request failed.")
      ));
    }
  }

  private onExit(child: ChildProcess, error: Error): void {
    if (this.child !== child) return;
    if(this.nonforcingPinned || isOwnedProcessNonforcing(child))return;
    if (this.transport === "stdio" && child.stdin && this.input) {
      this.input.unpipe(child.stdin);
    }
    this.child = undefined;
    this.generation = undefined;
    this.port = undefined;
    this.lastHeartbeatAt = undefined;
    this.activeOperation = undefined;
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.startupReject?.(error);
    this.startupResolve = undefined;
    this.startupReject = undefined;
    this.rejectPending(new Error(`RUNTIME_OUTCOME_UNKNOWN: ${error.message}`));
    if (!this.closed) this.scheduleRestart();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.abandoned.clear();
  }

  private scheduleRestart(): void {
    if (this.closed || this.nonforcingPinned || this.restartTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** Math.min(this.restartAttempts, 16),
      RESTART_MAX_DELAY_MS
    );
    // Recovery remains available through arbitrarily long storage/runtime
    // outages. The counter is capped only to keep backoff arithmetic bounded.
    this.restartAttempts = Math.min(this.restartAttempts + 1, 16);
    this.restartTimer = setTimeout(() => {
      if(this.nonforcingPinned)return;
      this.restartTimer = undefined;
      void this.spawnAndWait().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }
}

async function runRuntimeChild(transport: RuntimeTransport): Promise<void> {
  if (process.platform === "darwin") process.title = "Codex MCP Bridge State Owner";
  const privateGeneration=process.env[RUNTIME_GENERATION_ENV],privateController=process.env[RUNTIME_CONTROLLER_ENV];
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(!privateGeneration || !privateController || !uuid.test(privateGeneration) || !uuid.test(privateController))throw new Error('RUNTIME_PRIVATE_OWNER_BINDING_MISSING');
  const generation=privateGeneration,controllerId=privateController;
  const conformanceFixtures = process.argv.includes("--conformance-fixtures");
  let activeOperation: OperationalStateOperationObservation | undefined;
  let operationStartedAt = 0;
  let observationToken = 0;
  let lastCommitAt: number | undefined;
  let storageFault: {
    error: RuntimeStorageError;
    observedAt: number;
  } | undefined;
  let closing = false;
  let store: BridgeStateStore | undefined;
  let upstream: ReturnType<typeof createExecutionRuntime> | undefined;
  let telemetry: BridgeTelemetryService | undefined;
  let readProjection: ChildProcessStateReadService | undefined;
  let httpServer: BridgeHttpServer | undefined;
  let stdioRuntime: BridgeStdioRuntime | undefined;
  let applicationService: BridgeApplicationService | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  const resources=new RuntimeResourceShutdown(['telemetry','read','execution','frontend']);
  let shutdownPolicy:ShutdownPolicy & {allowSigkillEscalation:false}={allowSigkillEscalation:false};
  let databaseClosed=false;
  const pinned=()=>resources.pinned;
  const observeResources=async():Promise<ShutdownResult>=>{
    const observed=await resources.observe();
    if(!observed.exited)return observed;
    if(!store)return shutdownResult('uncertain');
    // Database closure follows positive actor/frontend/application quiescence.
    if(!databaseClosed){const closed=store.closeNonforcing();databaseClosed=closed.exited;if(!closed.exited)return closed;}
    return combineShutdown([observed,store.observeNonforcingExit()]);
  };
  const shutdownOwner=new ExecutionShutdownOwner(generation,process.pid,{
    pin(policy){
      shutdownPolicy=policy;
      if(heartbeat)clearInterval(heartbeat);
      if(!store){resources.invalidate('missing-operational-store',undefined);}else {
        try{if(store.pinNonforcingShutdown()!==true)resources.invalidate('database-pin',false);}catch(error){resources.invalidate('database-pin',error);}
      }
      return resources.pin(policy);
    },
    async close(policy){await resources.close(policy);return observeResources();},
    observe:observeResources
  });
  const registerActor=(name:string,actor:{closeNonforcing?:(policy:ShutdownPolicy & {allowSigkillEscalation:false})=>Promise<ShutdownResult>;observeNonforcingExit?:()=>ShutdownResult|Promise<ShutdownResult>;pinNonforcingShutdown?:()=>true})=>{
    const close=actor.closeNonforcing,observe=actor.observeNonforcingExit,pin=actor.pinNonforcingShutdown;
    let initial:Promise<ShutdownResult>|undefined;
    if(typeof close!=='function'||typeof observe!=='function'){resources.invalidate('unsupported-actor:'+name,actor);throw new Error('RUNTIME_RESOURCE_CAPABILITY_INVALID');}
    const hooks:RuntimeResourceHooks={
      pin(){
        if(pin && Reflect.apply(pin,actor,[])!==true)throw new Error('NONFORCING_SHUTDOWN_PIN_UNCONFIRMED');
        initial=Reflect.apply(close,actor,[shutdownPolicy]);return true;
      },
      close:()=>initial ?? Reflect.apply(close,actor,[shutdownPolicy]),
      observe:()=>Reflect.apply(observe,actor,[])
    };
    resources.register(name,hooks);
    if(pinned())throw new Error('RUNTIME_STARTUP_NONFORCING_PINNED');
  };
  // The final receipt must reach the authenticated parent before IPC closes.
  process.on('message',value=>{
    if(!snapshotExecutionShutdownRequest(value))return;
    void shutdownOwner.handle(value,controllerId).then(receipt=>{
      if(!receipt)return;
      if(!process.connected || !process.send){shutdownOwner.invalidateObservation();return;}
      let settled=false;
      const finish=(error?:unknown)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(error){shutdownOwner.invalidateObservation();resources.invalidate('shutdown-receipt-send',error);return;}
        if(receipt.operation==='finalize-nonforcing'&&receipt.result.exited&&shutdownOwner.finalizationAllowed){
          process.exitCode=0;if(process.connected)process.disconnect();
        }
      };
      const timer=setTimeout(()=>finish(new Error('RUNTIME_SHUTDOWN_RECEIPT_TIMEOUT')),6000);
      try{process.send(receipt,finish);}catch(error){finish(error);}
    });
  });

  const send = (message: RuntimeChildMessage) => {
    if(pinned())return;
    if (!process.connected || !process.send) return;
    try {
      process.send(message, () => {
        // A parent may close the IPC channel while an already-started state
        // operation is completing. Losing this observation must not crash the
        // child or change the operation's durable result.
      });
    } catch {
      // The supervisor owns recovery after IPC disconnect.
    }
  };
  const observeTransaction = (phase: OperationalStateOperationObservation["phase"]) => {
    if(pinned())return;
    const token = ++observationToken;
    if (phase === "write-lock-wait" || operationStartedAt === 0) {
      operationStartedAt = Date.now();
    }
    activeOperation = {
      access: "write",
      operation: "state-transaction",
      phase,
      startedAt: operationStartedAt,
      observedAt: Date.now()
    };
    send({ type: "operation", generation, observation: activeOperation });
    if (phase === "responding") {
      lastCommitAt = Date.now();
      telemetry?.recordRuntimeMeasurement({
        component: "state",
        metric: "transaction.duration",
        durationMs: Math.max(0, lastCommitAt - operationStartedAt),
        now: lastCommitAt
      });
      queueMicrotask(() => {
        if (pinned() || token !== observationToken || activeOperation?.access !== "write") return;
        activeOperation = undefined;
        operationStartedAt = 0;
        send({ type: "operation-clear", generation });
      });
    }
  };
  const observeTransactionFailure = (error: unknown) => {
    if(pinned()){resources.invalidate('late-observation',error);return;}
    activeOperation = undefined;
    operationStartedAt = 0;
    send({ type: "operation-clear", generation });
    observeStorageFailure(error);
  };
  const observeStorageFailure = (error: unknown) => {
    if(pinned()){resources.invalidate('late-observation',error);return;}
    const classified = runtimeStorageError(error);
    if (classified) {
      const changed = storageFault?.error !== classified;
      storageFault = { error: classified, observedAt: Date.now() };
      applicationService?.setStorageAdmissionError?.(classified);
      if (changed) telemetry?.recordDiagnosticEvent({
        severity: "error",
        component: "state",
        code: `storage.${classified}`
      });
    }
  };
  const observeTransactionCommitted = () => {
    if(pinned())return;
    const recovered = storageFault !== undefined;
    storageFault = undefined;
    applicationService?.setStorageAdmissionError?.();
    if (recovered) telemetry?.recordDiagnosticEvent({
      severity: "info",
      component: "state",
      code: "storage.recovered"
    });
  };
  const observeSql = (sql: string) => {
    if(pinned())return;
    if (activeOperation?.access === "write") return;
    const statement = sql.trimStart().toUpperCase();
    if (!/^(SELECT|WITH|PRAGMA|EXPLAIN)\b/u.test(statement)) return;
    // A synchronous projection can execute many reads before the event loop
    // yields. Keep its first read observation instead of sending one IPC
    // message per statement; the queued microtask closes the whole span.
    if (activeOperation?.access === "read") return;
    const token = ++observationToken;
    const startedAt = Date.now();
    activeOperation = {
      access: "read",
      operation: "state-query",
      phase: "read-snapshot",
      startedAt,
      observedAt: startedAt
    };
    send({ type: "operation", generation, observation: activeOperation });
    // better-sqlite3's trace callback runs immediately before the synchronous
    // statement. This microtask therefore cannot run until the read (and its
    // current synchronous projection stack) has yielded back to the loop.
    queueMicrotask(() => {
      if (pinned() || token !== observationToken || activeOperation?.access !== "read") return;
      activeOperation = {
        ...activeOperation,
        phase: "serializing",
        observedAt: Date.now()
      };
      send({ type: "operation", generation, observation: activeOperation });
      queueMicrotask(() => {
        if (pinned() || token !== observationToken || activeOperation?.access !== "read") return;
        activeOperation = undefined;
        send({ type: "operation-clear", generation });
      });
    });
  };

  const close = async (code = 0, stopExecution = true) => {
    if(pinned()){return;}
    shutdownOwner.markOrdinaryShutdown();
    if (closing) return;
    closing = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    const closeStep = async (step: () => void | Promise<void>) => {
      try {
        if(pinned())return;
        await step();
      } catch (error) {
        if(pinned()){resources.invalidate('ordinary-close-rejection',error);return;}
        code = 1;
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    };
    await closeStep(async () => {
      if (!httpServer) return;
      await new Promise<void>((resolve, reject) => httpServer?.close(error =>
        error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ? reject(error)
          : resolve()
      ));
    });
    await closeStep(() => stdioRuntime?.close());
    if (!stopExecution) await closeStep(() => upstream?.detachExecution?.());
    await closeStep(() => upstream?.close());
    await closeStep(() => readProjection?.close());
    await closeStep(() => store?.close());
    await closeStep(() => telemetry?.close());
    if(pinned())return;
    if (process.connected) process.disconnect();
    process.exitCode = code;
  };

  try {
    const config = loadConfig();
    store = new BridgeStateStore({
      file: config.stateDatabaseFile,
      traceSql: observeSql,
      onTransactionPhase: observeTransaction,
      onTransactionCommitted: observeTransactionCommitted,
      onTransactionFailure: observeTransactionFailure
    });
    try {
      telemetry = await ChildProcessTelemetryService.start(
        config.telemetryDatabaseFile,
        { sourceStateDatabaseId: store.databaseId }
      );
    } catch (error) {
      if(pinned()){resources.invalidate('telemetry-startup-rejection',error);throw new Error('RUNTIME_STARTUP_NONFORCING_PINNED');}
      telemetry = new InMemoryTelemetryService();
      process.stderr.write(
        `Telemetry persistence unavailable; using bounded memory only: ` +
        `${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    registerActor('telemetry',telemetry);
    readProjection = await ChildProcessStateReadService.start(
      config.stateDatabaseFile,
      process.env,
      { authBoundary: () => config.codexService?.sessionAuthBoundary() || null }
    );
    registerActor('read',readProjection);
    const appServerLateResponses = new AppServerLateResponseJournal(store);
    upstream = createExecutionRuntime(
      config,
      { onLateResponse: response => appServerLateResponses.observe(response) },
      process.env,
      {
        isolateCodexExecution: true,
        onExecutionProcessSpawn: processId => send({
          type: "execution-process",
          generation,
          processId
        }),
        onExecutionExitIntent: reason => {
          telemetry?.recordDiagnosticEvent({
            severity: "error", component: "execution",
            code: `executor-exit-intent.${reason}`
          });
        },
        onExecutionObservationIncident: incident => {
          const failure = incident.failure;
          const base = `worker-observation.${incident.side}.${incident.phase}.${failure.kind}`;
          telemetry?.recordDiagnosticEvent({
            severity: incident.state === "failed" ? "error" :
              incident.state === "degraded" ? "warning" : "info",
            component: "execution",
            code: `${base}.${incident.state}`
          });
          if (failure.psExitCode !== null) telemetry?.recordDiagnosticEvent({
            severity: "warning", component: "execution",
            code: `worker-observation.ps-exit.${failure.psExitCode}`
          });
          if (failure.osCode !== null) telemetry?.recordDiagnosticEvent({
            severity: "warning", component: "execution",
            code: `worker-observation.os-code.${failure.osCode.toLowerCase()}`
          });
          telemetry?.recordRuntimeMeasurement({
            component: "execution", metric: `${base}.duration`,
            durationMs: failure.durationMs
          });
          telemetry?.recordRuntimeMeasurement({
            component: "execution", metric: `${base}.timer-lateness`,
            durationMs: failure.timerLatenessMs
          });
        }
      }
    );
    registerActor('execution',upstream);
    const canAcceptExecution = () => {
      const status = upstream?.executionHealth?.().status;
      return status === undefined || status === "idle" || status === "ready";
    };
    if (transport === "http") {
      httpServer = createHttpServer(config, upstream, undefined, {
        stateStore: store,
        telemetry,
        readProjection,
        healthDiagnostics: () => ({ appServerLateResponses: appServerLateResponses.status() }),
        conformanceFixtures,
        onOperationFailure: observeStorageFailure,
        canAcceptNewJobs: canAcceptExecution
      });
      registerActor('frontend',httpServer);
      await new Promise<void>((resolve, reject) => {
        httpServer?.once("error", reject);
        httpServer?.listen(0, "127.0.0.1", () => {
          httpServer?.removeListener("error", reject);
          resolve();
        });
      });
      applicationService = httpServer.applicationService;
    } else {
      stdioRuntime = createStdioBridgeRuntime(config, upstream, {
        stateStore: store,
        telemetry,
        readProjection,
        onOperationFailure: observeStorageFailure,
        canAcceptNewJobs: canAcceptExecution
      });
      registerActor('frontend',stdioRuntime);
      await stdioRuntime.start();
      applicationService = stdioRuntime.applicationService;
    }
    if(pinned())throw new Error('RUNTIME_STARTUP_NONFORCING_PINNED');
    applicationService.setStorageAdmissionError?.(storageFault?.error);
    if (
      process.env.NODE_ENV === "test" &&
      process.env.CODEX_MCP_BRIDGE_TEST_FREEZE_STATE_PAGE_COUNT === "1"
    ) {
      store.freezePageCountForTesting();
    }
    unsubscribe = applicationService.subscribeChanges?.(topic => {
      send({ type: "change", generation, topic });
    });
    const address = httpServer?.address() as AddressInfo | null | undefined;
    if (transport === "http" && !address) {
      throw new Error("Isolated Bridge runtime address is unavailable.");
    }
    const health = (): BridgeRuntimeAdmissionSnapshot => {
      const operational = applicationService?.runtimeHealth?.() || emptyRuntimeHealth();
      const read = readProjection?.health();
      const diagnostic = telemetry?.status();
      const execution = upstream?.executionHealth?.();
      const executionAccepting = canAcceptExecution();
      return {
        ...operational,
        acceptingNewJobs: operational.acceptingNewJobs && !storageFault && executionAccepting,
        ...(storageFault ? {
          stateService: {
            status: storageFault.error === "busy" ? "state-capacity" : "state-recovering",
            storageError: storageFault.error,
            storageErrorObservedAt: storageFault.observedAt
          }
        } : {}),
        ...(read ? {
          readService: {
            status: read.reason,
            ...(read.generation ? { generation: read.generation } : {}),
            ...(read.heartbeatAgeMs !== undefined
              ? { heartbeatAgeMs: read.heartbeatAgeMs }
              : {}),
            inFlight: read.inFlight,
            capacity: read.capacity,
            ...(read.lastSnapshotAt !== undefined
              ? { lastSnapshotAt: read.lastSnapshotAt }
              : {}),
            ...(read.activeOperation ? { activeOperation: read.activeOperation } : {})
          }
        } : {}),
        ...(diagnostic ? {
          telemetryService: {
            status: telemetry instanceof InMemoryTelemetryService
              ? "memory-only"
              : diagnostic.connected ? "ready" : "recovering",
            queued: diagnostic.queued,
            inFlight: diagnostic.inFlight,
            retained: diagnostic.retained,
            dropped: diagnostic.dropped,
            failed: diagnostic.failed,
            ...(diagnostic.lastPersistedAt !== undefined
              ? { lastPersistedAt: diagnostic.lastPersistedAt }
              : {})
          }
        } : {}),
        ...(execution ? {
          executionService: {
            status: execution.status,
            observationStatus: execution.observationStatus,
            connectionStatus: execution.connectionStatus,
            heartbeatStatus: execution.heartbeatStatus,
            ...(execution.generation ? { generation: execution.generation } : {}),
            ...(execution.heartbeatAgeMs !== undefined
              ? { heartbeatAgeMs: execution.heartbeatAgeMs }
              : {}),
            inFlight: execution.inFlight,
            capacity: execution.capacity,
            ...(execution.journal ? { journal: execution.journal } : {}),
            pendingAcknowledgements: execution.pendingAcknowledgements,
            ...(execution.supervisedWorkers !== undefined
              ? { supervisedWorkers: execution.supervisedWorkers }
              : {}),
            ...(execution.supervisedProcesses !== undefined
              ? { supervisedProcesses: execution.supervisedProcesses }
              : {})
          }
        } : {})
      };
    };
    resources.sealReady();
    send({
      type: "ready",
      controllerId,
      protocol: STATE_OWNER_PROTOCOL,
      protocolVersion: STATE_OWNER_PROTOCOL_VERSION,
      transport,
      generation,
      ...(address ? { port: address.port } : {}),
      heartbeatAt: Date.now(),
      runtimeHealth: health(),
      ...(lastCommitAt !== undefined ? { lastCommitAt } : {})
    });
    heartbeat = setInterval(() => send({
      type: "heartbeat",
      generation,
      heartbeatAt: Date.now(),
      runtimeHealth: health(),
      ...(lastCommitAt !== undefined ? { lastCommitAt } : {})
    }), HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    const closeHttpAfterReadyMs =
      conformanceFixtures && process.env.NODE_ENV === "test"
        ? Number(process.env.CODEX_MCP_BRIDGE_TEST_CLOSE_HTTP_AFTER_READY_MS || 0)
        : 0;
    if (
      httpServer && Number.isSafeInteger(closeHttpAfterReadyMs) &&
      closeHttpAfterReadyMs > 0 && closeHttpAfterReadyMs <= 30_000
    ) {
      const timer = setTimeout(() => {
        if (!closing && !pinned()) httpServer?.close();
      }, closeHttpAfterReadyMs);
      timer.unref();
    }

    process.on("message", value => {
      if (pinned() || !isRuntimeParentMessage(value) || closing) return;
      if (value.type === "close") {
        void close();
        return;
      }
      if (value.generation !== generation) return;
      void resources.operations.run(()=>dispatchApplicationRpc(applicationService as BridgeApplicationService, value)).then(
        result => {
          if(pinned()){resources.invalidate('application-rpc-result:'+value.requestId,{request:value,result});return;}
          send({type:'rpc-response',generation,requestId:value.requestId,ok:true,result:result===undefined?null:result});
        },
        error => {
          if(pinned()){resources.invalidate('application-rpc-rejection',error);return;}
          observeStorageFailure(error);
          send({
            type: "rpc-response",
            generation,
            requestId: value.requestId,
            ok: false,
            error: {
              code: runtimeErrorCode(error),
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      );
    });
    if (transport === "stdio") process.stdin.once("end", () => { void close(0, false); });
    process.once("disconnect", () => { void close(0, false); });
    process.once("SIGTERM", () => { void close(0, false); });
    process.once("SIGINT", () => { void close(0, false); });
  } catch (error) {
    if(pinned()){resources.invalidate('startup-rejection',error);return;}
    send({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    await close(1, false);
  }
}

async function dispatchApplicationRpc(
  applicationService: BridgeApplicationService,
  request: RuntimeRpcRequestMessage
): Promise<unknown> {
  const operation = applicationService[request.method];
  if (typeof operation !== "function") {
    throw new Error(`RUNTIME_OPERATION_UNAVAILABLE: ${request.method} is unavailable.`);
  }
  const result = await (operation as (...args: unknown[]) => unknown).apply(
    applicationService,
    request.args
  );
  const encoded = JSON.stringify(result === undefined ? null : result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RPC_BYTES) {
    throw new Error("RUNTIME_RESPONSE_TOO_LARGE: Runtime response exceeds its IPC limit.");
  }
  return result;
}

function emptyRuntimeHealth(): BridgeRuntimeAdmissionSnapshot {
  return {
    acceptingNewJobs: false,
    activeJobs: 0,
    pendingAdmissions: 0,
    backgroundProcessState: "unknown",
    backgroundProcesses: 0,
    backgroundProcessAgents: 0,
    backgroundProcessUnknownAgents: 0
  };
}

function stateServiceStatusForReadiness(
  reason: BridgeReadinessReason,
  current?: RuntimeStateServiceStatus
): RuntimeStateServiceStatus {
  switch (reason) {
    case "admission-draining":
    case "execution-starting":
    case "execution-stale":
    case "execution-recovering":
    case "execution-capacity":
      return current || "ready";
    default:
      return reason;
  }
}

function runtimeErrorCode(error: unknown): string {
  const stateCode = operationalStateErrorCode(error);
  if (stateCode !== "STATE_COMMAND_FAILED") return stateCode;
  const message = error instanceof Error ? error.message : String(error);
  return /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] || "RUNTIME_REQUEST_FAILED";
}

function runtimeStorageError(error: unknown): RuntimeStorageError | undefined {
  const code = operationalStateErrorCode(error);
  if (code === "STATE_STORAGE_BUSY") return "busy";
  if (code === "STATE_STORAGE_FULL") return "full";
  if (code === "STATE_STORAGE_IO") return "io";
  if (code === "STATE_STORAGE_CORRUPT") return "corrupt";
  if (code === "STATE_STORAGE_READ_ONLY") return "read-only";
  return undefined;
}

function isRuntimeChildMessage(value: unknown): value is RuntimeChildMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "fatal") return typeof message.message === "string";
  if (message.type === "ready") {
    const transport = message.transport === "http" || message.transport === "stdio"
      ? message.transport
      : undefined;
    return message.protocol === STATE_OWNER_PROTOCOL &&
      Number.isSafeInteger(message.protocolVersion) &&
      transport !== undefined && typeof message.controllerId==="string" && typeof message.generation === "string" &&
      (transport === "stdio" || Number.isInteger(message.port) && Number(message.port) > 0) &&
      Number.isSafeInteger(message.heartbeatAt) && isRuntimeHealth(message.runtimeHealth);
  }
  if (message.type === "heartbeat") {
    return typeof message.generation === "string" &&
      Number.isSafeInteger(message.heartbeatAt) && isRuntimeHealth(message.runtimeHealth);
  }
  if (message.type === "operation") {
    return typeof message.generation === "string" && isOperation(message.observation);
  }
  if (message.type === "operation-clear") return typeof message.generation === "string";
  if (message.type === "change") {
    return typeof message.generation === "string" &&
      ["dashboard", "settings", "enrichment"].includes(String(message.topic));
  }
  if (message.type === "execution-process") {
    return typeof message.generation === "string" &&
      Number.isSafeInteger(message.processId) && Number(message.processId) > 0;
  }
  if (message.type === "rpc-response") {
    return typeof message.generation === "string" &&
      typeof message.requestId === "string" && typeof message.ok === "boolean";
  }
  return false;
}

function isRuntimeParentMessage(value: unknown): value is RuntimeParentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "close") return true;
  return message.type === "rpc" &&
    message.protocol === STATE_OWNER_PROTOCOL &&
    message.protocolVersion === STATE_OWNER_PROTOCOL_VERSION &&
    typeof message.generation === "string" &&
    typeof message.requestId === "string" &&
    typeof message.method === "string" &&
    APPLICATION_RPC_METHODS.includes(message.method as ApplicationRpcMethod) &&
    message.kind === applicationRpcKind(message.method as ApplicationRpcMethod) &&
    Array.isArray(message.args) &&
    Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_RPC_BYTES;
}

function applicationRpcKind(method: ApplicationRpcMethod): ApplicationRpcKind {
  if (APPLICATION_QUERY_METHODS.has(method)) return "query";
  if (APPLICATION_CONTROL_METHODS.has(method)) return "control";
  return "command";
}

function isRuntimeHealth(value: unknown): value is BridgeRuntimeAdmissionSnapshot {
  if (!value || typeof value !== "object") return false;
  const health = value as Record<string, unknown>;
  return typeof health.acceptingNewJobs === "boolean" &&
    Number.isSafeInteger(health.activeJobs) && Number(health.activeJobs) >= 0 &&
    Number.isSafeInteger(health.pendingAdmissions) && Number(health.pendingAdmissions) >= 0 &&
    (health.backgroundProcessState === "confirmed" || health.backgroundProcessState === "unknown");
}

function isOperation(value: unknown): value is OperationalStateOperationObservation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Record<string, unknown>;
  return (operation.access === "read" || operation.access === "write") &&
    typeof operation.operation === "string" && operation.operation.length <= 80 &&
    [
      "queue-wait",
      "write-lock-wait",
      "read-snapshot",
      "executing",
      "committing",
      "serializing",
      "responding"
    ].includes(
      String(operation.phase)
    ) &&
    Number.isSafeInteger(operation.startedAt) && Number(operation.startedAt) >= 0 &&
    Number.isSafeInteger(operation.observedAt) &&
    Number(operation.observedAt) >= Number(operation.startedAt);
}

function requestHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete result[name];
  return result;
}

function requestContentLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = headers["content-length"];
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (value === undefined || !/^\d+$/u.test(value)) return MAX_RPC_BYTES + 1;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : MAX_RPC_BYTES + 1;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  for (const name of HOP_BY_HOP_HEADERS) delete result[name];
  return result;
}

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
] as const;

let mcpIdCaptureBytesInFlight = 0;

/** Keeps a bounded raw request body until its complete JSON can be parsed. */
class McpRequestIdCapture {
  private buffer?: Buffer;
  private bytes = 0;
  private ended = false;
  private available = true;

  append(chunk: Buffer | string): boolean {
    if (!this.available || this.ended) return false;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const nextBytes = this.bytes + bytes.length;
    if (nextBytes > MAX_RPC_BYTES) {
      this.dispose();
      return false;
    }
    if (nextBytes > (this.buffer?.length || 0)) {
      const capacity = Math.min(MAX_RPC_BYTES,
        Math.max(nextBytes, (this.buffer?.length || 1_024) * 2));
      const previousCapacity = this.buffer?.length || 0;
      const additionalCapacity = capacity - previousCapacity;
      if (mcpIdCaptureBytesInFlight + additionalCapacity > MAX_MCP_ID_CAPTURE_BYTES_IN_FLIGHT) {
        this.dispose();
        return false;
      }
      // One allocation per growth step keeps thousands of tiny HTTP chunks
      // from retaining thousands of backing buffers outside the byte budget.
      const replacement = Buffer.allocUnsafeSlow(capacity);
      this.buffer?.copy(replacement, 0, 0, this.bytes);
      this.buffer = replacement;
      mcpIdCaptureBytesInFlight += additionalCapacity;
    }
    bytes.copy(this.buffer!, this.bytes);
    this.bytes = nextBytes;
    return true;
  }

  complete(): void { this.ended = true; }

  body(): Buffer | undefined {
    return this.available && this.ended
      ? this.buffer?.subarray(0, this.bytes) || Buffer.alloc(0)
      : undefined;
  }

  id(): string | number | undefined {
    if (!this.available || !this.ended) return;
    try {
      return mcpRequestId(this.buffer?.subarray(0, this.bytes) || Buffer.alloc(0));
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    mcpIdCaptureBytesInFlight -= this.buffer?.length || 0;
    this.bytes = 0;
    this.buffer = undefined;
    this.available = false;
  }
}

function mcpRequestId(body: Buffer): string | number | undefined {
  try {
    const value: unknown = JSON.parse(decodeUtf8Strict(body, "MCP request body"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const id = (value as Record<string, unknown>).id;
    return typeof id === "string" || typeof id === "number" && Number.isFinite(id) ? id : undefined;
  } catch {
    // Malformed, incomplete, or oversized bodies cannot justify an ID guess.
    return;
  }
}

function isPriorityMcpRequest(body: Buffer): boolean {
  if (body.length > MAX_PRIORITY_MCP_REQUEST_BYTES) return false;
  try {
    const value: unknown = JSON.parse(decodeUtf8Strict(body, "MCP request body"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const request = value as Record<string, unknown>;
    if (request.jsonrpc !== "2.0" || request.method !== "tools/call" ||
        !(typeof request.id === "string" ||
          typeof request.id === "number" && Number.isFinite(request.id)) ||
        !request.params || typeof request.params !== "object" ||
        Array.isArray(request.params)) return false;
    const params = request.params as Record<string, unknown>;
    const name = params.name;
    if (name === "codex_answer" || name === "codex_cancel" ||
        name === "codex_steer" || name === "codex_interaction_respond") return true;
    if (name === "codex_ui_completion") {
      const args = params.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) return false;
      return ["accepted", "rejected", "uncertain", "release"].includes(
        String((args as Record<string, unknown>).operation)
      );
    }
    if (name !== "codex_status" || !params.arguments ||
        typeof params.arguments !== "object" || Array.isArray(params.arguments)) return false;
    const query = (params.arguments as Record<string, unknown>).query;
    if (!query || typeof query !== "object" || Array.isArray(query)) return false;
    const exact = query as Record<string, unknown>;
    if (exact.kind === "completion") return true;
    if (exact.kind === "input") return exact.waitMs === undefined || exact.waitMs === 0;
    return (exact.kind === "job" || exact.kind === "request") &&
      exact.waitFor === undefined && exact.waitMs === undefined;
  } catch {
    return false;
  }
}

function writeMcpUnavailable(
  incoming: import("node:http").IncomingMessage,
  outgoing: import("node:http").ServerResponse,
  readiness: BridgeReadinessSnapshot,
  outcome: ProxyRequestOutcome,
  failure: ProxyFailureContext = {}
): void {
  if (incoming.method !== "POST") {
    writeUnavailable(outgoing, readiness, outcome, failure);
    return;
  }
  const capture = new McpRequestIdCapture();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    incoming.off("data", onData);
    incoming.off("end", onEnd);
    incoming.off("close", onClose);
    const id = capture.id();
    capture.dispose();
    writeUnavailable(outgoing, readiness, outcome, failure, id);
  };
  const onData = (chunk: Buffer | string) => {
    if (!capture.append(chunk)) finish();
  };
  const onEnd = () => { capture.complete(); finish(); };
  const onClose = () => finish();
  const timer = setTimeout(finish, MCP_REJECTION_BODY_WAIT_MS);
  timer.unref();
  incoming.on("data", onData);
  incoming.once("end", onEnd);
  incoming.once("close", onClose);
  incoming.resume();
}

function writeUnavailable(
  response: import("node:http").ServerResponse,
  readiness: BridgeReadinessSnapshot,
  outcome: ProxyRequestOutcome,
  failure: ProxyFailureContext = {},
  requestId?: string | number
): void {
  if (response.headersSent || response.destroyed) return;
  const reason = failure.reason || readiness.reason;
  const limitations = failure.limitations || readiness.limitations;
  response.setHeader("retry-after", "1");
  const details = {
    ok: false,
    code: "RUNTIME_RESPONSE_UNCONFIRMED",
    reason,
    limitations,
    retryable: true,
    outcome,
    runtimeReadiness: {
      ready: readiness.ready,
      reason: readiness.reason,
      limitations: readiness.limitations
    },
    ...(readiness.stateService ? { stateService: readiness.stateService } : {})
  };
  writeJson(response, 503, requestId === undefined ? details : {
    jsonrpc: "2.0",
    id: requestId,
    error: {
      code: -32000,
      message: "Bridge runtime temporarily unavailable",
      data: details
    }
  });
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown
): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

if (process.argv.includes(CHILD_FLAG)) {
  await runRuntimeChild(process.argv.includes(CHILD_STDIO_FLAG) ? "stdio" : "http");
}
