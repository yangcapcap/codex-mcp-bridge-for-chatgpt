import { currentExecutionIdentity } from "./executionIdentity.js";
import { ExecutionJournal, type ExecutionJournalStatus } from "./executionJournal.js";
import {WorkerTreeShutdownSupervisor} from "./workerTreeShutdownSupervisor.js";
import {ExecutionShutdownOwner,observeResourcesAfterClose} from "./executionShutdownOwner.js";
import {snapshotExecutionShutdownRequest,snapshotExecutionShutdownReceipt,type ExecutionShutdownRequest} from "./executionShutdownProtocol.js";
import {boundedShutdown,combineShutdown,snapshotShutdownPolicy,shutdownResult,type ShutdownPolicy,type ShutdownResult} from "./shutdown.js";
import {performance} from "node:perf_hooks";
import { ExecutionPeer, executionEndpoint, listenExecutionOwner, readExecutionRecord,
  writeExecutionRecord, clearExitedExecutionOwner, type ExecutionEndpoint } from "./executionTransport.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { codexProcessEnvironment } from "../scripts/runtime-env.mjs";
import {
  CodexAppServerUpstreamPool,
  type CodexAppServerLateResponse,
  type CodexAppServerProtocolOptions
} from "./appServerUpstream.js";
import { UNVERIFIED_APP_SERVER_CAPABILITIES } from "./cliProtocol.js";
import { isCodexInputEvent } from "./codexInputs.js";
import type { BackendCapabilities } from "./modelPolicy.js";
import type {
  CodexBackgroundTerminal,
  CodexInteractionInput,
  CodexInteractionResponse,
  CodexProgress,
  CodexThreadContinueRequest,
  CodexThreadForkRequest,
  CodexThreadResumeProbe,
  CodexThreadStartRequest,
  CodexUpstream,
  CodexWeeklyUsage,
  ToolResult,
  UpstreamWorkerAssignment
} from "./upstream.js";
import type { ThreadReleaseOptions, ThreadReleaseResult } from "./threadConnections.js";
import {
  type JsonRpcProcessIdentity,
  type JsonRpcTerminationResult
} from "./jsonRpcProcess.js";
import type { WorkerTerminationCorrelation } from "./cancellation.js";
import {
  SupervisedProcessTreeRegistry,
  processObservationFailure,
  supervisedProcessKey,
  type ProcessObservationFailure,
  type SupervisedProcessIdentity,
  type SupervisedProcessTreeSnapshot
} from "./processTreeSupervisor.js";

const CHILD_FLAG = "--codex-execution-child";
const PROTOCOL = "bridge-codex-execution" as const;
const PROTOCOL_VERSION = 7 as const;
const HEARTBEAT_MS = 250;
const HEARTBEAT_STALE_MS = 2_000;
const STARTUP_TIMEOUT_MS = 20_000;
const FORCE_CLOSE_MS = 5_000;
const WORKER_TREE_OBSERVATION_MS = 2_000;
const ORPHAN_CLEANUP_GRACE_MS = 1_500;
const RESTART_BASE_DELAY_MS = 250;
const RESTART_MAX_DELAY_MS = 10_000;
const MAX_PENDING_REQUESTS = 128;
const CONTROL_REQUEST_RESERVE = 16;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES_IN_FLIGHT = 32 * 1024 * 1024;
const CONTROL_REQUEST_BYTES_RESERVE = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ACK_WINDOW = 16;
const ACK_REPLY_RESERVE = 8;
const ACK_RETRY_MS = 1_000;

const EXECUTION_OPERATIONS = [
  "listTools",
  "prepareExecution",
  "listModels",
  "readAccountSnapshot",
  "readAuthenticationPolicy",
  "readAccountRateLimits",
  "startThread",
  "continueThread",
  "forkThread",
  "archiveThread",
  "restoreThread",
  "probeThread",
  "releaseThreadConnection",
  "listBackgroundTerminals",
  "listLoadedBackgroundTerminals",
  "terminateBackgroundTerminal",
  "callTool",
  "forceTerminateWorker",
  "respondToInteraction",
  "steerThread"
] as const;

type ExecutionOperation = (typeof EXECUTION_OPERATIONS)[number];

const THREAD_SUBJECT_OPERATIONS = new Set<ExecutionOperation>([
  "archiveThread",
  "restoreThread",
  "probeThread",
  "releaseThreadConnection",
  "listBackgroundTerminals",
  "listLoadedBackgroundTerminals",
  "terminateBackgroundTerminal",
  "steerThread"
]);

const TURN_EXECUTION_OPERATIONS = new Set<ExecutionOperation>([
  "startThread",
  "continueThread",
  "forkThread",
  "callTool"
]);

const CONTROL_EXECUTION_OPERATIONS = new Set<ExecutionOperation>([
  "releaseThreadConnection",
  "terminateBackgroundTerminal",
  "forceTerminateWorker",
  "respondToInteraction",
  "steerThread"
]);

export type CodexExecutionRequestLimits = {
  maxPendingRequests: number;
  controlRequestReserve: number;
  maxBytesInFlight: number;
  controlRequestBytesReserve: number;
};

type SerializableProtocolOptions = Pick<
  CodexAppServerProtocolOptions,
  | "versionCheckTimeoutMs"
  | "requestTimeoutMs"
  | "initializeTimeoutMs"
  | "interruptTimeoutMs"
>;

type ChildConfiguration = {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  command: string;
  poolSize: number;
  options: SerializableProtocolOptions;
  endpoint: ExecutionEndpoint;
};

type RequestMessage = {
  type: "request";
  generation: string;
  requestId: string;
  operation: ExecutionOperation;
  args: unknown[];
  retained?: boolean;
  afterSequence?: number;
};

type ProtectMessage = {
  type: "protect";
  generation: string;
  threadId: string;
};

type ReleaseCheckResponseMessage = {
  type: "release-check-response";
  generation: string;
  requestId: string;
  checkId: string;
  allowed: boolean;
};

type WorkerRegistrationAckMessage = {
  type: "worker-registration-ack";
  generation: string;
  registrationId: string;
};

type WorkerCleanupAckMessage = {
  type: "worker-cleanup-ack";
  generation: string;
  cleanupId: string;
  ok: boolean;
};

type CloseMessage = { type: "close" };
type ParentMessage =
  | RequestMessage
  | ProtectMessage
  | ReleaseCheckResponseMessage
  | WorkerRegistrationAckMessage
  | WorkerCleanupAckMessage
  | CloseMessage;

type ReadyMessage = {
  type: "ready";
  protocol: typeof PROTOCOL;
  version: number;
  generation: string;
  heartbeatAt: number;
  capabilities: BackendCapabilities;
  journal?: ExecutionJournalStatus;
};

type HeartbeatMessage = {
  type: "heartbeat";
  generation: string;
  heartbeatAt: number;
  inFlight: number;
  journal?: ExecutionJournalStatus;
};

type ProgressMessage = {
  type: "progress";
  generation: string;
  requestId: string;
  progress: CodexProgress;
  interactionId?: string;
  interactionInput?: CodexInteractionInput;
};

type AssignmentMessage = {
  type: "assignment";
  generation: string;
  requestId: string;
  assignment: UpstreamWorkerAssignment;
  capabilities: BackendCapabilities;
};

type ResponseMessage = {
  type: "response";
  generation: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  capabilities?: BackendCapabilities;
};

type LateResponseMessage = {
  type: "late-response";
  generation: string;
  response: CodexAppServerLateResponse;
};

type ReleaseCheckMessage = {
  type: "release-check";
  generation: string;
  requestId: string;
  checkId: string;
  threadId: string;
};

type WorkerStartedMessage = {
  type: "worker-started";
  generation: string;
  registrationId: string;
  identity: JsonRpcProcessIdentity;
};

type WorkerExitedMessage = {
  type: "worker-exited";
  generation: string;
  cleanupId: string;
  identity: JsonRpcProcessIdentity;
};

type WorkerCleanupStartedMessage = {
  type: "worker-cleanup-started";
  generation: string;
  cleanupId: string;
  identity: JsonRpcProcessIdentity;
};

type WorkerObservedMessage = {
  type: "worker-observed";
  generation: string;
  trees: SupervisedProcessTreeSnapshot[];
};

export type WorkerObservationIncident = {
  side: "parent" | "child";
  workerKey?: string;
  phase: "refresh" | "registration" | "cleanup";
  state: "degraded" | "recovered" | "failed";
  failure: ProcessObservationFailure;
};

export type ExecutorExitReason =
  | "worker-observation-failed"
  | "worker-cleanup-unconfirmed"
  | "ipc-send-failed"
  | "ipc-serialization-failed"
  | "ipc-message-too-large"
  | "ipc-capacity-exceeded";

type ExecutorExitIntentMessage = {
  type: "executor-exit-intent";
  generation: string;
  reason: ExecutorExitReason;
};

type WorkerObservationStatusMessage = {
  type: "worker-observation-status";
  generation: string;
  incident: WorkerObservationIncident;
};

type FatalMessage = { type: "fatal"; message: string };
type ChildMessage =
  | ReadyMessage
  | HeartbeatMessage
  | ProgressMessage
  | AssignmentMessage
  | ResponseMessage
  | LateResponseMessage
  | ReleaseCheckMessage
  | WorkerStartedMessage
  | WorkerObservedMessage
  | WorkerObservationStatusMessage
  | ExecutorExitIntentMessage
  | WorkerCleanupStartedMessage
  | WorkerExitedMessage
  | FatalMessage
  | { type: "acknowledged"; generation: string; requestId: string; journal?: ExecutionJournalStatus };

type PendingRequest = {
  operation: ExecutionOperation;
  message: RequestMessage | { type: "recover"; generation: string; requestId: string };
  retained: boolean;
  sequence: number;
  control: boolean;
  bytes: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (progress: CodexProgress) => void;
  onAssigned?: (assignment: UpstreamWorkerAssignment) => void;
  assignment?: UpstreamWorkerAssignment;
  activeThreadIds: Set<string>;
  interactionId?: string;
  subjectThreadId?: string;
  canRelease?: ThreadReleaseOptions["canRelease"];
};

function sameExecutionAssignment(left: UpstreamWorkerAssignment, right: UpstreamWorkerAssignment): boolean {
  return Boolean(left.upstreamRequestId && right.upstreamRequestId &&
    left.backendKind === right.backendKind && left.workerId === right.workerId &&
    left.workerGeneration === right.workerGeneration &&
    left.upstreamRequestId === right.upstreamRequestId &&
    left.threadId && left.threadId === right.threadId);
}

export type CodexExecutionServiceHealth = {
  status: "idle" | "starting" | "ready" | "stale" | "recovering" | "capacity";
  observationStatus?: "ready" | "degraded";
  connectionStatus?: "connected" | "disconnected";
  heartbeatStatus?: "fresh" | "delayed";
  generation?: string;
  heartbeatAgeMs?: number;
  inFlight: number;
  capacity: number;
  ordinaryInFlight?: number;
  ordinaryCapacity?: number;
  bytesInFlight?: number;
  byteCapacity?: number;
  ordinaryBytesInFlight?: number;
  ordinaryByteCapacity?: number;
  processId?: number;
  supervisedWorkers?: number;
  supervisedProcesses?: number;
  journal?: ExecutionJournalStatus;
  pendingAcknowledgements?: number;
};

export type ChildProcessCodexExecutionServiceOptions = {
  command: string;
  poolSize: number;
  endpoint?: ExecutionEndpoint;
  environment?: NodeJS.ProcessEnv;
  protocolOptions?: CodexAppServerProtocolOptions;
  onLateResponse?: (response: CodexAppServerLateResponse) => void;
  /** Test/diagnostic hook. Process identity is never exposed over MCP. */
  onProcessSpawn?: (processId: number) => void;
  onObservationIncident?: (incident: WorkerObservationIncident) => void;
  onExitIntent?: (reason: ExecutorExitReason) => void;
  /** Test-only override for deterministic ordinary/control saturation coverage. */
  requestLimits?: Partial<CodexExecutionRequestLimits>;
};

/**
 * Codex execution lives outside the operational-state owner. The proxy keeps
 * only bounded callback correlation and presentation-safe transient state;
 * SQLite authority and durable Job state stay in the caller process.
 */
export class ChildProcessCodexExecutionService implements CodexUpstream {
  private child?: ExecutionPeer;
  private readonly endpoint: ExecutionEndpoint;
  private detached = false;
  private generation?: string;
  private lastHeartbeatAt?: number;
  private capabilitiesValue: BackendCapabilities = UNVERIFIED_APP_SERVER_CAPABILITIES;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly retainedResults = new Map<string, UpstreamWorkerAssignment>();
  private readonly acknowledgements = new Set<string>();
  private readonly acknowledgementsInFlight = new Set<string>();
  private acknowledgementTimer?: NodeJS.Timeout;
  private readonly releasedReplies = new Map<string, () => void>();
  private journal?: ExecutionJournalStatus;
  private pendingBytes = 0;
  private ordinaryPending = 0;
  private ordinaryPendingBytes = 0;
  private readonly protectedThreads = new Set<string>();
  private readonly workerProcesses = new SupervisedProcessTreeRegistry();
  private readonly resumableThreads = new Map<string, boolean>();
  private readonly activeThreads = new Set<string>();
  private readonly interactionInputs = new Map<string, CodexInteractionInput>();
  private closed = false;
  private starting = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;
  private workerCleanupTimer?: NodeJS.Timeout;
  private closePromise?: Promise<void>;
  private nonforcingClose?:Promise<ShutdownResult>;
  private nonforcingSettled=false;
  private nonforcingHistoryUncertain=false;
  private nonforcingChild?:ExecutionPeer;
  private nonforcingRequest?:Extract<ExecutionShutdownRequest,{type:"close-nonforcing"}>;
  private finalWorkerReceipt?:ShutdownResult;
  private ordinaryCloseWait?:()=>void;
  private readonly shutdownReceived=new Map<string,ShutdownResult>();
  private readonly shutdownIssued=new Map<string,ExecutionShutdownRequest>();
  private readonly shutdownWaiting=new Map<string,(result:ShutdownResult)=>void>();
  private workerCleanupPromise: Promise<boolean> = Promise.resolve(true);
  private readonly activeObservationFailures = new Map<string, WorkerObservationIncident>();
  private childExitIntent?: ExecutorExitReason;
  private readonly workerCleanupsInFlight = new Set<string>();
  private stderr = "";
  private readonly requestLimits: CodexExecutionRequestLimits;

  private constructor(private readonly options: ChildProcessCodexExecutionServiceOptions) {
    this.requestLimits = resolveExecutionRequestLimits(options.requestLimits);
    this.endpoint = options.endpoint || executionEndpoint();
  }

  static async start(
    options: ChildProcessCodexExecutionServiceOptions
  ): Promise<ChildProcessCodexExecutionService> {
    if (!Number.isInteger(options.poolSize) || options.poolSize < 1 || options.poolSize > 100) {
      throw new Error("EXECUTION_POOL_SIZE_INVALID: Codex execution pool size is invalid.");
    }
    const service = new ChildProcessCodexExecutionService(options);
    try {
      await service.spawnAndWait();
    } catch {
      // The child exit path schedules bounded restart. Keep the proxy alive in
      // a truthful recovering state so a temporary executable/startup failure
      // cannot require restarting the operational state owner.
    }
    return service;
  }

  capabilities(): BackendCapabilities {
    return this.capabilitiesValue;
  }

  listTools(): Promise<unknown> {
    return this.request("listTools", []);
  }

  prepareExecution(input: {
    backendKind: "app-server";
    contextMode: "fresh" | "continue" | "fork";
  }): Promise<void> {
    return this.request("prepareExecution", [input]);
  }

  listModels(backendKind?: "app-server"): Promise<unknown> {
    return this.request("listModels", [backendKind]);
  }

  readAccountSnapshot(): Promise<import("./codexAccount.js").CodexAccountSnapshot | null> {
    return this.request("readAccountSnapshot", []);
  }

  readAuthenticationPolicy(): Promise<{ config: unknown; requirements: unknown }> {
    return this.request("readAuthenticationPolicy", []);
  }

  readAccountRateLimits(): Promise<CodexWeeklyUsage | null> {
    return this.request("readAccountRateLimits", []);
  }

  startThread(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("startThread", [input], onProgress, onAssigned);
  }

  continueThread(
    input: CodexThreadContinueRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("continueThread", [input], onProgress, onAssigned);
  }

  forkThread(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("forkThread", [input], onProgress, onAssigned);
  }

  archiveThread(threadId: string, backendKind?: "app-server"): Promise<void> {
    return this.request("archiveThread", [threadId, backendKind]);
  }

  restoreThread(threadId: string, backendKind?: "app-server"): Promise<void> {
    return this.request("restoreThread", [threadId, backendKind]);
  }

  probeThread(threadId: string, backendKind?: "app-server"): Promise<CodexThreadResumeProbe> {
    return this.request("probeThread", [threadId, backendKind]);
  }

  releaseThreadConnection(
    threadId: string,
    options: ThreadReleaseOptions
  ): Promise<ThreadReleaseResult> {
    return this.request("releaseThreadConnection", [threadId, options]);
  }

  protectThreadFromImplicitResume(threadId: string): void {
    this.protectedThreads.add(threadId);
    this.resumableThreads.set(threadId, false);
    this.sendProtect(threadId);
  }

  listBackgroundTerminals(
    threadId: string,
    backendKind?: "app-server"
  ): Promise<CodexBackgroundTerminal[]> {
    return this.request("listBackgroundTerminals", [threadId, backendKind]);
  }

  listLoadedBackgroundTerminals(
    threadId: string,
    backendKind?: "app-server"
  ): Promise<CodexBackgroundTerminal[] | null> {
    return this.request("listLoadedBackgroundTerminals", [threadId, backendKind]);
  }

  terminateBackgroundTerminal(
    threadId: string,
    processId: string,
    backendKind?: "app-server"
  ): Promise<{ terminated: boolean }> {
    return this.request("terminateBackgroundTerminal", [threadId, processId, backendKind]);
  }

  canResumeThread(threadId: string): boolean | undefined {
    return this.resumableThreads.get(threadId);
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.request("callTool", [name, args], onProgress, onAssigned);
  }

  forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs?: number,
    options?: { interruptOnly: true }
  ): Promise<JsonRpcTerminationResult> {
    return this.request("forceTerminateWorker", [assignment, correlation, graceMs, options]);
  }

  respondToInteraction(
    interactionId: string,
    response: CodexInteractionResponse
  ): Promise<void> {
    return this.request("respondToInteraction", [interactionId, response]);
  }

  interactionInput(interactionId: string): CodexInteractionInput | undefined {
    const input = this.interactionInputs.get(interactionId);
    return input ? structuredClone(input) : undefined;
  }

  canSteerThread(threadId: string): boolean {
    return this.activeThreads.has(threadId) && this.capabilitiesValue.supportsSteering === true;
  }

  steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    return this.request("steerThread", [threadId, prompt]);
  }

  health(now = Date.now()): CodexExecutionServiceHealth {
    const connected = Boolean(this.child?.connected && this.generation);
    const heartbeatAgeMs = this.lastHeartbeatAt === undefined
      ? undefined
      : Math.max(0, now - this.lastHeartbeatAt);
    const status = !connected
      ? this.starting ? "starting" : "recovering"
      : (this.journal && this.journal.lanes.execution.used >= this.journal.lanes.execution.capacity) ||
          this.pending.size >= this.requestLimits.maxPendingRequests ||
            this.pendingBytes >= this.requestLimits.maxBytesInFlight ||
            this.ordinaryPending >=
              this.requestLimits.maxPendingRequests - this.requestLimits.controlRequestReserve ||
            this.ordinaryPendingBytes >=
              this.requestLimits.maxBytesInFlight -
                this.requestLimits.controlRequestBytesReserve
          ? "capacity"
          : "ready";
    return {
      status,
      observationStatus: this.activeObservationFailures.size ? "degraded" : "ready",
      connectionStatus: connected ? "connected" : "disconnected",
      heartbeatStatus: heartbeatAgeMs !== undefined && heartbeatAgeMs <= HEARTBEAT_STALE_MS ? "fresh" : "delayed",
      ...(this.generation ? { generation: this.generation } : {}),
      ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}),
      inFlight: this.pending.size,
      ...(this.journal ? { journal: this.journal } : {}),
      pendingAcknowledgements: this.acknowledgements.size,
      capacity: this.requestLimits.maxPendingRequests,
      ordinaryInFlight: this.ordinaryPending,
      ordinaryCapacity:
        this.requestLimits.maxPendingRequests - this.requestLimits.controlRequestReserve,
      bytesInFlight: this.pendingBytes,
      byteCapacity: this.requestLimits.maxBytesInFlight,
      ordinaryBytesInFlight: this.ordinaryPendingBytes,
      ordinaryByteCapacity:
        this.requestLimits.maxBytesInFlight -
          this.requestLimits.controlRequestBytesReserve,
      supervisedWorkers: this.workerProcesses.size,
      supervisedProcesses: this.workerProcesses.capturedProcessCount,
      ...(this.child?.pid !== undefined ? { processId: this.child.pid } : {})
    };
  }

  get processId(): number | undefined {
    return this.child?.pid;
  }

  /** Test/supervisor control; never exposed through the Bridge protocol. */
  terminate(signal: NodeJS.Signals = "SIGTERM"): boolean {
    return this.child?.kill(signal) ?? false;
  }

  close(): Promise<void> {
    if(this.nonforcingClose)return this.nonforcingClose.then(result=>{
      if(!result.exited)throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
    });
    if (!this.closePromise) this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  closeNonforcing(policy:ShutdownPolicy):Promise<ShutdownResult> {
    const pinned=snapshotShutdownPolicy(policy);
    if(pinned.allowSigkillEscalation!==false)throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    if(this.nonforcingClose)return this.nonforcingClose;
    let resolve!:(result:ShutdownResult)=>void;
    this.nonforcingClose=new Promise(done=>{resolve=done;});
    this.nonforcingHistoryUncertain=Boolean(this.closePromise || this.detached);
    this.closed=true;this.nonforcingChild=this.child;
    this.workerProcesses.pinNonforcingShutdown();
    this.ordinaryCloseWait?.();
    if(this.restartTimer)clearTimeout(this.restartTimer);
    if(this.workerCleanupTimer)clearTimeout(this.workerCleanupTimer);
    if(this.acknowledgementTimer)clearTimeout(this.acknowledgementTimer);
    // Preserve reservations, assignments and ACK evidence rather than synthesize
    // completion or release an unknown writer during shutdown.
    for(const pending of this.pending.values())pending.reject(new Error("NONFORCING_EXECUTION_OUTCOME_UNKNOWN"));
    const binding=this.nonforcingChild?.pinNonforcingShutdown();
    const requestId=randomUUID();
    const request=binding && binding.generation===this.generation ? snapshotExecutionShutdownRequest({...binding,
      type:"close-nonforcing",requestId,closeRequestId:requestId,policy:{...pinned,allowSigkillEscalation:false}}) : undefined;
    if(request?.type==="close-nonforcing")this.nonforcingRequest=request;
    const deadline=pinned.graceMs*2+6000;
    void boundedShutdown(async()=>{
      const workers=this.nonforcingRequest ? await this.exchangeShutdown(this.nonforcingRequest,deadline) : shutdownResult("uncertain");
      return this.finishNonforcing(workers,deadline);
    },Math.min(180000,deadline*3)).then(result=>{this.nonforcingSettled=true;resolve(result);},()=>{
      this.nonforcingSettled=true;resolve(shutdownResult("uncertain"));
    });
    return this.nonforcingClose;
  }

  async observeNonforcingExit():Promise<ShutdownResult> {
    if(!this.nonforcingSettled || !this.nonforcingRequest)return shutdownResult("uncertain");
    if(this.finalWorkerReceipt)return this.measureNonforcing(this.finalWorkerReceipt,6000);
    // Observation has no policy field; the strict parser rejects an extra one.
    const {policy,...original}=this.nonforcingRequest;
    const observation=snapshotExecutionShutdownRequest({...original,type:"observe-nonforcing",requestId:randomUUID()});
    if(!observation)return shutdownResult("uncertain");
    return boundedShutdown(async()=>this.finishNonforcing(await this.exchangeShutdown(observation,6000),6000),18000);
  }

  private exchangeShutdown(request:ExecutionShutdownRequest,deadline:number):Promise<ShutdownResult> {
    const child=this.nonforcingChild;
    if(!child?.connected || this.child!==child || !child.nonforcingBinding || this.shutdownIssued.size>=128)return Promise.resolve(shutdownResult("uncertain"));
    return new Promise(resolve=>{
      let settled=false;
      const finish=(result:ShutdownResult)=>{if(settled)return;settled=true;clearTimeout(timer);this.shutdownWaiting.delete(request.requestId);resolve(result);};
      const timer=setTimeout(()=>finish(shutdownResult("uncertain")),deadline);
      this.shutdownIssued.set(request.requestId,request);this.shutdownWaiting.set(request.requestId,finish);
      try{if(!child.send(request,error=>{if(error)finish(shutdownResult("uncertain"));}))finish(shutdownResult("uncertain"));}
      catch{finish(shutdownResult("uncertain"));}
    });
  }

  private receiveShutdownReceipt(value:unknown):void {
    for(const [id,request] of this.shutdownIssued) {
      const receipt=snapshotExecutionShutdownReceipt(value,request);if(!receipt)continue;
      const prior=this.shutdownReceived.get(id);
      if(prior && JSON.stringify(prior)!==JSON.stringify(receipt.result)) {
        this.nonforcingHistoryUncertain=true;
        this.shutdownWaiting.get(id)?.(shutdownResult("uncertain"));return;
      }
      this.shutdownReceived.set(id,receipt.result);
      if(request.type==="finalize-nonforcing" && receipt.result.exited)this.finalWorkerReceipt=receipt.result;
      this.shutdownWaiting.get(id)?.(receipt.result);return;
    }
  }

  private async finishNonforcing(workers:ShutdownResult,deadline:number):Promise<ShutdownResult> {
    if(workers.exited && this.nonforcingRequest && !this.finalWorkerReceipt) {
      const {policy,...original}=this.nonforcingRequest;
      const finalize=snapshotExecutionShutdownRequest({...original,type:"finalize-nonforcing",requestId:randomUUID()});
      if(finalize)workers=await this.exchangeShutdown(finalize,deadline);
    }
    if(this.finalWorkerReceipt)workers=this.finalWorkerReceipt;
    return this.measureNonforcing(workers,deadline);
  }

  private async measureNonforcing(workers:ShutdownResult,deadline:number):Promise<ShutdownResult> {
    const child=this.nonforcingChild;
    const owner=await boundedShutdown(async()=>{
      const stop=performance.now()+deadline;
      let result=child?.observeNonforcingExit() ?? shutdownResult("uncertain");
      while(workers.exited && this.finalWorkerReceipt && result.outcome==="timeout" && performance.now()<stop) {
        await new Promise(done=>setTimeout(done,20));result=child?.observeNonforcingExit() ?? shutdownResult("uncertain");
      }
      return result;
    },deadline+100);
    const trees=await this.workerProcesses.observeNonforcingExit();
    const proof=combineShutdown([owner,workers,trees,...(this.nonforcingHistoryUncertain ? [shutdownResult("uncertain")] : [])]);
    // Remote/local worker observations overlap; the executor is a separate root.
    return shutdownResult(proof.outcome,owner.survivors+Math.max(workers.survivors,trees.survivors),
      owner.signalFailures+Math.max(workers.signalFailures,trees.signalFailures),owner.identityChanges+Math.max(workers.identityChanges,trees.identityChanges));
  }

  private request<T>(
    operation: ExecutionOperation,
    args: unknown[],
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<T> {
    const child = this.child;
    const generation = this.generation;
    const health = this.health();
    const control = CONTROL_EXECUTION_OPERATIONS.has(operation);
    if (this.closed || !child?.connected || !generation) {
      return Promise.reject(new Error("EXECUTION_UNAVAILABLE: The execution control link is disconnected; the request was not delivered."));
    }
    if (
      this.pending.size >= this.requestLimits.maxPendingRequests ||
      (!control && this.ordinaryPending >=
        this.requestLimits.maxPendingRequests - this.requestLimits.controlRequestReserve)
    ) {
      return Promise.reject(new Error(
        "EXECUTION_CAPACITY: The isolated Codex execution service is at capacity."
      ));
    }
    let wireArgs = args;
    let canRelease: ThreadReleaseOptions["canRelease"] | undefined;
    if (operation === "releaseThreadConnection") {
      const release = args[1] as ThreadReleaseOptions | undefined;
      if (!release || typeof release.canRelease !== "function" ||
          !Array.isArray(release.eligibleThreadIds)) {
        return Promise.reject(new Error(
          "EXECUTION_REQUEST_INVALID: Thread release requires an authoritative state check."
        ));
      }
      canRelease = release.canRelease;
      wireArgs = [args[0], {
        eligibleThreadIds: [...release.eligibleThreadIds],
        ...(release.previousWorkerPid !== undefined
          ? { previousWorkerPid: release.previousWorkerPid }
          : {})
      }];
    }
    const retained = TURN_EXECUTION_OPERATIONS.has(operation) && currentExecutionIdentity() !== undefined;
    const requestId = retained ? currentExecutionIdentity()! : randomUUID();
    const message: RequestMessage = {
      type: "request",
      generation,
      requestId,
      operation,
      args: wireArgs,
      retained
    };
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > MAX_REQUEST_BYTES) {
      return Promise.reject(new Error(
        "EXECUTION_REQUEST_TOO_LARGE: The Codex execution request exceeds its IPC limit."
      ));
    }
    if (
      this.pendingBytes + bytes > this.requestLimits.maxBytesInFlight ||
      (!control && this.ordinaryPendingBytes + bytes >
        this.requestLimits.maxBytesInFlight -
          this.requestLimits.controlRequestBytesReserve)
    ) {
      return Promise.reject(new Error(
        "EXECUTION_CAPACITY: The Codex execution byte capacity is exhausted."
      ));
    }
    // Argument serialization may reenter the controller. Do not admit a new
    // reservation after a synchronous shutdown fence or owner replacement.
    if(this.closed || this.nonforcingClose || this.child!==child || this.generation!==generation)
      return Promise.reject(new Error("NONFORCING_EXECUTION_OUTCOME_UNKNOWN"));
    return new Promise<T>((resolve, reject) => {
      this.pendingBytes += bytes;
      if (!control) {
        this.ordinaryPending += 1;
        this.ordinaryPendingBytes += bytes;
      }
      this.pending.set(requestId, {
        operation,
        message, retained, sequence: 0,
        control,
        bytes,
        resolve,
        reject,
        onProgress,
        onAssigned,
        activeThreadIds: new Set<string>(),
        ...(operation === "respondToInteraction" && typeof args[0] === "string"
          ? { interactionId: args[0] }
          : {}),
        ...(THREAD_SUBJECT_OPERATIONS.has(operation) && typeof args[0] === "string"
          ? { subjectThreadId: args[0] }
          : {}),
        ...(canRelease ? { canRelease } : {})
      });
      // Retain the exact request until an authoritative response. A socket
      // send callback cannot tell whether the owner executed it.
      child.send(message, () => {});
    });
  }

  private sendProtect(threadId: string): void {
    if(this.nonforcingClose)return;
    const child = this.child;
    if (!child?.connected || !this.generation) return;
    const message: ProtectMessage = {
      type: "protect",
      generation: this.generation,
      threadId
    };
    if (Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_REQUEST_BYTES) {
      child.send(message, () => {});
    }
  }

  supportsExecutionRecovery(): boolean { return true; }

  ownsActiveExecution(jobId: string, assignment: UpstreamWorkerAssignment): boolean {
    const pending = this.pending.get(jobId);
    return this.child?.connected === true && Boolean(this.generation && pending?.retained &&
      pending.assignment && sameExecutionAssignment(pending.assignment, assignment));
  }

  ownsRetainedResult(jobId: string, assignment: UpstreamWorkerAssignment): boolean {
    const retained = this.retainedResults.get(jobId);
    return this.child?.connected === true && Boolean(this.generation && retained &&
      sameExecutionAssignment(retained, assignment));
  }

  recoverExecution(jobId: string, onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void): Promise<ToolResult> {
    if(this.nonforcingClose)return Promise.reject(new Error("NONFORCING_EXECUTION_OUTCOME_UNKNOWN"));
    if (this.pending.has(jobId)) return Promise.reject(new Error("EXECUTION_RECOVERY_ALREADY_ATTACHED"));
    return new Promise((resolve, reject) => {
      const message = { type: "recover" as const, generation: this.generation || "", requestId: jobId };
      this.pending.set(jobId, { operation: "callTool", message, retained: true, sequence: 0,
        control: false, bytes: 0, resolve, reject, onProgress, onAssigned, activeThreadIds: new Set() });
      this.ordinaryPending += 1;
      if (this.child?.connected && this.generation) this.child.send(message, () => {});
    });
  }

  acknowledgeExecution(jobId: string): void {
    if(this.nonforcingClose)return;
    this.acknowledgements.add(jobId);
    this.sendNextAcknowledgement();
  }

  private sendNextAcknowledgement(): void {
    if (!this.child?.connected || !this.generation || this.closed || this.detached) return;
    // Commit acknowledgements may remain unconfirmed for a long time. They
    // cannot occupy the reply-release slots needed by metadata and controls.
    for (const requestId of [...this.releasedReplies.keys(), ...this.acknowledgements]) {
      if (this.acknowledgementsInFlight.size >= ACK_WINDOW) break;
      if (this.acknowledgementsInFlight.has(requestId)) continue;
      if (!this.releasedReplies.has(requestId) &&
          [...this.acknowledgementsInFlight].filter(id => !this.releasedReplies.has(id)).length >= ACK_WINDOW - ACK_REPLY_RESERVE) continue;
      this.acknowledgementsInFlight.add(requestId);
      this.child.send({ type: "acknowledge", generation: this.generation, requestId }, () => {});
    }
    if (this.acknowledgements.size && !this.acknowledgementTimer) {
      // Retry the same identities, never the original execution. A dropped ACK
      // or ACK reply must not permanently pin the release queue on a live link.
      this.acknowledgementTimer = setTimeout(() => {
        this.acknowledgementTimer = undefined;
        this.acknowledgementsInFlight.clear();
        this.sendNextAcknowledgement();
      }, ACK_RETRY_MS);
      this.acknowledgementTimer.unref();
    }
  }

  private finishReleasedReplies(): void {
    if(this.nonforcingClose)return;
    if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = undefined;
    this.acknowledgementsInFlight.clear();
    this.acknowledgements.clear();
    // These replies already have an authoritative terminal response. Only the
    // reuse of their transport reservation was waiting for an ACK.
    for (const reply of this.releasedReplies.values()) reply();
    this.releasedReplies.clear();
  }

  /** Detaches a restarting controller without closing the execution owner. */
  detachExecution(): void {
    if(this.nonforcingClose) {
      this.nonforcingHistoryUncertain=true;this.detached=true;this.child?.detach();return;
    }
    this.detached = true;
    this.finishReleasedReplies();
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.child?.detach();
  }

  private async spawnAndWait(): Promise<void> {
    if (this.closed) throw new Error("EXECUTION_CLOSED: Codex execution service closed.");
    const previous = readExecutionRecord<SupervisedProcessTreeSnapshot[]>(this.endpoint, "trees.json") || [];
    for (const tree of previous) { this.workerProcesses.remember(tree.root); this.workerProcesses.merge(tree); }
    const modulePath = fileURLToPath(import.meta.url);
    const configuration: ChildConfiguration = { protocol: PROTOCOL, version: PROTOCOL_VERSION,
      command: this.options.command, poolSize: this.options.poolSize,
      options: serializableOptions(this.options.protocolOptions || {}), endpoint: this.endpoint };
    const encoded = Buffer.from(JSON.stringify(configuration), "utf8").toString("base64url");
    const args = modulePath.endsWith(".ts")
      ? ["--import", "tsx", modulePath, CHILD_FLAG, encoded] : [modulePath, CHILD_FLAG, encoded];
    this.starting = true;
    const child = new ExecutionPeer(this.endpoint, { args,
      env: executionChildEnvironment(this.options.environment || process.env),
      onStderr: value => { this.stderr = (this.stderr + value).slice(-8192); } });
    this.child = child;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.starting = false;
        if (error) reject(error); else resolve();
      };
      // This bounds startup waiting only. It grants no termination authority.
      const timer = setTimeout(() => finish(new Error("EXECUTION_START_PENDING")), STARTUP_TIMEOUT_MS);
      timer.unref();
      child.on("message", value => {
        if(this.nonforcingClose) {
          if(this.child!==child || child!==this.nonforcingChild)return;
          this.receiveShutdownReceipt(value);
          if(isChildMessage(value) && (value.type==="worker-observed" || value.type==="worker-observation-status") &&
            value.generation===this.generation)this.onMessage(value);
          return;
        }
        if (this.detached || this.child !== child || !isChildMessage(value)) return;
        if (value.type === "fatal") { finish(new Error(value.message)); return; }
        if (value.type === "ready") {
          if (value.version !== PROTOCOL_VERSION) { finish(new Error("EXECUTION_INCOMPATIBLE")); child.detach(); return; }
          if (this.generation && this.generation !== value.generation) {
            this.finishReleasedReplies();
            for (const [id] of this.pending) this.takePending(id)?.reject(new Error("CODEX_WORKER_LOST: The original execution owner exited."));
          }
          this.generation = value.generation;
          this.lastHeartbeatAt = Date.now();
          this.capabilitiesValue = value.capabilities;
          this.journal = value.journal;
          this.starting = false;
          if (child.pid !== undefined) this.options.onProcessSpawn?.(child.pid);
          finish();
          this.acknowledgementsInFlight.clear();
          this.sendNextAcknowledgement();
          void this.replayControlState(child);
          return;
        }
        this.onMessage(value);
      });
      child.once("error", error => { finish(error); this.onExit(child, error); });
      child.once("exit", (code, signal) => {
        const error = new Error(`EXECUTION_PROCESS_EXITED: code=${code}, signal=${signal}. exit_intent=${this.closed ? "explicit-close" : "unconfirmed"}. ${this.stderr}`);
        finish(error); this.onExit(child, error);
      });
      child.start();
    });
  }

  private async replayControlState(child: ExecutionPeer): Promise<void> {
    // A large retained history must not overflow the finite transport queue on
    // reconnect. Each write is bounded; active receipts still own their IDs.
    const send = (message: unknown) => new Promise<boolean>(resolve => {
      if (this.nonforcingClose || this.child !== child || !child.connected) { resolve(false); return; }
      child.send(message, error => resolve(!error));
    });
    for (const threadId of this.protectedThreads) {
      if (!await send({ type: "protect", generation: this.generation, threadId })) return;
    }
    for (const [requestId, pending] of this.pending) {
      // A terminal reply waiting only for release must never replay its work,
      // even if the owner received the ACK but its confirmation was lost.
      if (this.releasedReplies.has(requestId)) continue;
      if (!await send({ ...pending.message, generation: this.generation, afterSequence: pending.sequence })) return;
    }
  }

  private onMessage(message: ChildMessage): void {
    if (message.type === "fatal" || message.type === "ready") return;
    if (message.generation !== this.generation) return;
    if (message.type === "acknowledged") {
      if (message.journal) this.journal = message.journal;
      this.acknowledgements.delete(message.requestId);
      this.retainedResults.delete(message.requestId);
      this.acknowledgementsInFlight.delete(message.requestId);
      const reply = this.releasedReplies.get(message.requestId);
      this.releasedReplies.delete(message.requestId);
      reply?.();
      if (!this.acknowledgements.size && this.acknowledgementTimer) {
        clearTimeout(this.acknowledgementTimer); this.acknowledgementTimer = undefined;
      }
      this.sendNextAcknowledgement();
      return;
    }
    if (message.type === "heartbeat") {
      this.lastHeartbeatAt = message.heartbeatAt;
      if (message.journal) this.journal = message.journal;
      return;
    }
    if (message.type === "late-response") {
      this.options.onLateResponse?.(message.response);
      return;
    }
    if (message.type === "worker-observation-status") {
      const incident = message.incident;
      this.recordObservationIncident(incident);
      return;
    }
    if (message.type === "executor-exit-intent") {
      this.childExitIntent = message.reason;
      try { this.options.onExitIntent?.(message.reason); } catch { /* Diagnostics are best effort. */ }
      return;
    }
    if (message.type === "worker-started") return;
    if (message.type === "worker-observed") {
      const keys = new Set(message.trees.map(tree => supervisedProcessKey(tree.root)));
      for (const previous of this.workerProcesses.snapshots()) {
        if (!keys.has(supervisedProcessKey(previous.root))) this.workerProcesses.forget(previous.root);
      }
      for (const tree of message.trees) { this.workerProcesses.remember(tree.root); this.workerProcesses.merge(tree); }
      return;
    }
    if (message.type === "worker-cleanup-started") {
      this.workerCleanupsInFlight.add(message.cleanupId);
      return;
    }
    if (message.type === "worker-exited") {
      this.workerCleanupsInFlight.delete(message.cleanupId);
      return;
    }
    if (message.type === "release-check") {
      const pending = this.pending.get(message.requestId);
      const child = this.child;
      const generation = this.generation;
      if (!pending?.canRelease || pending.operation !== "releaseThreadConnection" ||
          !child?.connected || !generation) return;
      void Promise.resolve()
        .then(() => pending.canRelease!(message.threadId))
        .then(Boolean, () => false)
        .then(allowed => {
          if (this.child !== child || this.generation !== generation || !child.connected) return;
          child.send({
            type: "release-check-response",
            generation,
            requestId: message.requestId,
            checkId: message.checkId,
            allowed
          } satisfies ReleaseCheckResponseMessage, () => {});
        });
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending || this.releasedReplies.has(message.requestId)) return;
    const sequence = (message as ChildMessage & { sequence?: number }).sequence;
    if (sequence !== undefined && sequence <= pending.sequence) return;
    if (message.type === "progress") {
      if (message.interactionId && message.interactionInput) {
        this.interactionInputs.set(message.interactionId, structuredClone(message.interactionInput));
      }
      const resolved = message.progress.event?.details?.resolvedInteractionId;
      if (typeof resolved === "string") this.interactionInputs.delete(resolved);
      try { pending.onProgress?.(message.progress); } catch { this.child?.disconnect(); return; }
      if (sequence !== undefined) pending.sequence = sequence;
      return;
    }
    if (message.type === "assignment") {
      pending.assignment = message.assignment;
      this.capabilitiesValue = message.capabilities;
      const threadId = message.assignment.threadId;
      if (threadId) {
        pending.activeThreadIds.add(threadId);
        if (message.assignment.upstreamRequestId) this.activeThreads.add(threadId);
        this.resumableThreads.set(threadId, true);
      }
      try { pending.onAssigned?.(message.assignment); } catch { this.child?.disconnect(); return; }
      if (sequence !== undefined) pending.sequence = sequence;
      return;
    }
    const completed = pending;
    if (completed.retained && completed.assignment) {
      this.retainedResults.set(message.requestId, completed.assignment);
    }
    for (const threadId of completed.activeThreadIds) this.activeThreads.delete(threadId);
    const deliver = () => {
      this.takePending(message.requestId);
      if (message.ok) {
        if (message.capabilities) this.capabilitiesValue = message.capabilities;
        this.observeResult(completed.operation, message.result, completed.interactionId, completed.subjectThreadId);
        completed.resolve(message.result);
      } else {
        completed.reject(new Error(`${message.error?.code || "EXECUTION_REQUEST_FAILED"}: ` +
          (message.error?.message || "Codex execution request failed.")));
      }
    };
    if (completed.retained) deliver();
    else {
      // Keep a bounded caller from issuing its next read while the previous
      // reply still consumes a journal slot. Durable Jobs instead ACK after DB commit.
      // Keep its parent request/byte reservation until release as well.
      this.releasedReplies.set(message.requestId, deliver);
      this.acknowledgeExecution(message.requestId);
    }
  }

  private observeResult(
    operation: ExecutionOperation,
    result: unknown,
    interactionId?: string,
    subjectThreadId?: string
  ): void {
    if (operation === "respondToInteraction" && interactionId) {
      this.interactionInputs.delete(interactionId);
    }
    if (operation === "archiveThread" && subjectThreadId) {
      this.resumableThreads.set(subjectThreadId, false);
    }
    if (operation === "restoreThread" && subjectThreadId) {
      this.resumableThreads.set(subjectThreadId, true);
    }
    if (operation === "probeThread" && isRecord(result)) {
      const threadId = typeof result.threadId === "string" ? result.threadId : subjectThreadId;
      if (threadId) this.resumableThreads.set(threadId, result.state === "resumable");
    }
    if (operation === "releaseThreadConnection" && isRecord(result) &&
        result.phase === "released") {
      if (subjectThreadId) this.resumableThreads.set(subjectThreadId, false);
      if (Array.isArray(result.releasedThreadIds)) {
        for (const threadId of result.releasedThreadIds) {
          if (typeof threadId === "string") this.resumableThreads.set(threadId, false);
        }
      }
    }
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    this.pendingBytes = Math.max(0, this.pendingBytes - pending.bytes);
    if (!pending.control) {
      this.ordinaryPending = Math.max(0, this.ordinaryPending - 1);
      this.ordinaryPendingBytes = Math.max(0, this.ordinaryPendingBytes - pending.bytes);
    }
    return pending;
  }

  private onExit(child: ExecutionPeer, error: Error): void {
    if (this.child !== child) return;
    if(this.nonforcingClose) {this.starting=false;return;}
    child.detach();
    this.child = undefined;
    this.generation = undefined;
    this.journal = undefined;
    this.finishReleasedReplies();
    this.lastHeartbeatAt = undefined;
    this.starting = false;
    this.activeThreads.clear();
    this.retainedResults.clear();
    this.interactionInputs.clear();
    this.resumableThreads.clear();
    this.workerCleanupsInFlight.clear();
    for (const [requestId] of this.pending) {
      const pending = this.takePending(requestId);
      pending?.reject(new Error(
        `${TURN_EXECUTION_OPERATIONS.has(pending.operation)
          ? "CODEX_WORKER_LOST"
          : "EXECUTION_OUTCOME_UNKNOWN"}: ${error.message}`
      ));
    }
    this.queueWorkerCleanup(!this.closed);
  }

  private recordObservationIncident(incident: WorkerObservationIncident): void {
    const key = `${incident.side}.${incident.phase}:${incident.workerKey || "all"}`;
    if (incident.state === "recovered") {
      this.activeObservationFailures.delete(key);
    } else {
      if (!this.activeObservationFailures.has(key)) {
        this.activeObservationFailures.set(key, incident);
      }
    }
    try { this.options.onObservationIncident?.(incident); } catch { /* Diagnostics are best effort. */ }
  }

  private queueWorkerCleanup(restartWhenClean: boolean): void {
    this.workerCleanupPromise = this.workerCleanupPromise
      .catch(() => false)
      .then(() => this.cleanupRegisteredWorkers());
    void this.workerCleanupPromise.then(cleaned => {
      if (this.closed || !restartWhenClean) return;
      if (cleaned) { clearExitedExecutionOwner(this.endpoint); this.scheduleRestart(); }
      else this.scheduleWorkerCleanupRetry();
    }).catch(() => this.scheduleWorkerCleanupRetry());
  }

  private async cleanupRegisteredWorkers(): Promise<boolean> {
    if(this.nonforcingClose)return (await this.workerProcesses.observeNonforcingExit()).exited;
    // The final auxiliary snapshot may not have crossed a broken socket.
    // Failure to read retained ownership evidence cannot authorize replacement.
    try {
      for (const tree of readExecutionRecord<SupervisedProcessTreeSnapshot[]>(this.endpoint, "trees.json") || []) {
        this.workerProcesses.remember(tree.root); this.workerProcesses.merge(tree);
      }
    } catch { return false; }
    return this.workerProcesses.cleanupAll(ORPHAN_CLEANUP_GRACE_MS);
  }

  private scheduleWorkerCleanupRetry(): void {
    if (this.closed || this.workerCleanupTimer) return;
    this.workerCleanupTimer = setTimeout(() => {
      this.workerCleanupTimer = undefined;
      this.queueWorkerCleanup(true);
    }, WORKER_TREE_OBSERVATION_MS);
    this.workerCleanupTimer.unref();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** Math.min(this.restartAttempts, 16),
      RESTART_MAX_DELAY_MS
    );
    this.restartAttempts = Math.min(this.restartAttempts + 1, 16);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.spawnAndWait().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }

  private async closeInternal(): Promise<void> {
    if (this.detached) return;
    this.closed = true;
    this.finishReleasedReplies();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.workerCleanupTimer) clearTimeout(this.workerCleanupTimer);
    for (const [requestId] of this.pending) {
      this.takePending(requestId)?.reject(new Error(
        "EXECUTION_CLOSED: Codex execution service closed."
      ));
    }
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: "close" } satisfies CloseMessage);
      await new Promise<void>(resolve => {
        let settled = false;
        const force = setTimeout(() => {if(!this.nonforcingClose)child.kill("SIGKILL");}, FORCE_CLOSE_MS);
        force.unref();
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(force);
          this.ordinaryCloseWait=undefined;
          resolve();
        };
        this.ordinaryCloseWait=finish;
        child.once("exit", finish);
        if (child.exitCode !== null || child.signalCode !== null) finish();
      });
    }
    if(this.nonforcingClose)return this.close();
    if (this.child === child) {
      this.child = undefined;
      this.generation = undefined;
    }
    await this.workerCleanupPromise.catch(() => false);
    if(this.nonforcingClose)return this.close();
    const cleaned = await this.cleanupRegisteredWorkers();
    if (!cleaned) {
      throw new Error(
        "EXECUTION_ORPHAN_CLEANUP_FAILED: A supervised Codex worker did not exit."
      );
    }
  }
}

async function runChild(configuration: ChildConfiguration): Promise<void> {
  if (process.platform === "darwin") process.title = "Codex MCP Bridge Execution";
  process.stderr.on("error", () => {});
  const generation = randomUUID();
  let closing = false;
  const workerObserver = new SupervisedProcessTreeRegistry();
  const workerShutdown = new WorkerTreeShutdownSupervisor(workerObserver);
  let refreshInFlight = false;
  let refreshFailure: ProcessObservationFailure | undefined;
  const active = new Set<Promise<void>>();
  const releaseChecks = new Map<string, { resolve(allowed: boolean): void; timer: NodeJS.Timeout }>();
  const journal = new ExecutionJournal(generation, (requestId, assignment, reason) => {
    // Actual per-request storage exhaustion, not a probe/heartbeat timeout.
    // Never escalate a delivery problem to shared-worker process termination.
    if (assignment) void pool.forceTerminateWorker(assignment as UpstreamWorkerAssignment,
      { kind: "execution-containment", correlationId: requestId, reasonCode: reason },
      undefined, { interruptOnly: true }).catch(() => {});
  });
  const send = (message: ChildMessage) => journal.send(message);
  const report = (phase: WorkerObservationIncident["phase"], state: WorkerObservationIncident["state"], failure: ProcessObservationFailure, identity?: JsonRpcProcessIdentity) =>
    send({ type: "worker-observation-status", generation, incident: { side: "child", phase, state, failure,
      ...(identity ? { workerKey: supervisedProcessKey(identity) } : {}) } });
  let lastTrees = "";
  const persistTrees = (force = false) => {
    const trees = workerObserver.snapshots();
    const encoded = JSON.stringify(trees);
    if (!force && encoded === lastTrees) return;
    writeExecutionRecord(configuration.endpoint, "trees.json", trees);
    lastTrees = encoded;
    send({ type: "worker-observed", generation, trees });
  };
  const observe = async () => {
    if (refreshInFlight || closing) return;
    refreshInFlight = true;
    try {
      await workerObserver.refresh(); persistTrees();
      if (refreshFailure) report("refresh", "recovered", refreshFailure);
      refreshFailure = undefined;
    } catch (error) {
      if (!refreshFailure) report("refresh", "degraded", processObservationFailure(error));
      refreshFailure = processObservationFailure(error);
    } finally { refreshInFlight = false; }
  };
  const pool = new CodexAppServerUpstreamPool(configuration.command, configuration.poolSize, {
    ...configuration.options, environment: process.env,
    onLateResponse: response => send({ type: "late-response", generation, response }),
    workerShutdownSupervisor:workerShutdown.supervisor,
    onWorkerProcessExitObserved:(identity,binding)=>{
      workerShutdown.markExited(identity,binding);
    },
    onWorkerProcessStarted: async (identity,binding) => {
      // The spawn event and owned pipes establish ownership, independently of ps.
      const registration=workerShutdown.register(identity,binding);
      persistTrees();
      send({ type: "worker-started", generation, registrationId: randomUUID(), identity });
      await registration;
      void observe();
    },
    onWorkerProcessExited: async identity => {
      workerObserver.markExited(identity);
      const cleanupId = randomUUID();
      send({ type: "worker-cleanup-started", generation, cleanupId, identity });
      let failure: ProcessObservationFailure | undefined;
      while (!closing) {
        try {
          if (await workerObserver.release(identity, ORPHAN_CLEANUP_GRACE_MS)) {
            persistTrees();
            if (failure) report("cleanup", "recovered", failure, identity);
            send({ type: "worker-exited", generation, cleanupId, identity });
            return;
          }
          throw new Error("WORKER_CLEANUP_UNCONFIRMED");
        } catch (error) {
          if (!failure) report("cleanup", "degraded", processObservationFailure(error), identity);
          failure = processObservationFailure(error);
        }
        // This worker retains its slot. No parent ack and no global fence.
        await new Promise(resolve => setTimeout(resolve, WORKER_TREE_OBSERVATION_MS));
      }
    }
  });
  const observerTimer = setInterval(() => { void observe(); }, WORKER_TREE_OBSERVATION_MS);
  observerTimer.unref();
  const heartbeat = setInterval(() => send({ type: "heartbeat", generation,
    heartbeatAt: Date.now(), inFlight: active.size, journal: journal.status() }), HEARTBEAT_MS);
  heartbeat.unref();
  let closeServer: (() => Promise<void>) | undefined;
  type ControlLink={send:(value:unknown,done?:(error?:Error|null)=>void)=>boolean;controllerId:string};
  let controlLink:ControlLink|undefined;
  let lastControllerId:string|undefined;
  let poolReceipt:Promise<ShutdownResult>|undefined;
  const stopObservers=()=>{
    closing=true;clearInterval(observerTimer);clearInterval(heartbeat);
    for(const check of releaseChecks.values()){clearTimeout(check.timer);check.resolve(false);}
    releaseChecks.clear();journal.disconnect();
  };
  const workersResult=(poolResult:ShutdownResult,trees:ShutdownResult):ShutdownResult=>{
    const proof=combineShutdown([poolResult,trees]);
    // Each pool receipt includes its selected tree; the all-tree ledger overlaps.
    return shutdownResult(proof.outcome,Math.max(poolResult.survivors,trees.survivors),
      Math.max(poolResult.signalFailures,trees.signalFailures),Math.max(poolResult.identityChanges,trees.identityChanges));
  };
  const shutdownOwner=new ExecutionShutdownOwner(generation,process.pid,{
    pin(policy){
      stopObservers();workerObserver.pinNonforcingShutdown();
      poolReceipt=pool.closeNonforcing(policy);return true;
    },
    async close(){
      const result=await observeResourcesAfterClose(await poolReceipt!,()=>pool.observeNonforcingExit());
      return workersResult(result,await workerObserver.observeNonforcingExit());
    },
    async observe(){
      return workersResult(await pool.observeNonforcingExit(),await workerObserver.observeNonforcingExit());
    }
  });
  const writeControl=(link:ControlLink,value:unknown)=>new Promise<boolean>(resolve=>{
    let settled=false;
    const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(ok && controlLink===link);};
    const timer=setTimeout(()=>finish(false),6000);
    if(controlLink!==link){finish(false);return;}
    try{if(!link.send(value,error=>finish(!error)))finish(false);}catch{finish(false);}
  });
  const shutdownControl=async(value:unknown,controllerId:string)=>{
    const link=controlLink;
    const receipt=await shutdownOwner.handle(value,controllerId);
    if(!receipt || !link || link.controllerId!==controllerId || controlLink!==link)return;
    try {writeExecutionRecord(configuration.endpoint,"trees.json",workerObserver.snapshots());}
    catch{shutdownOwner.invalidateObservation();return;}
    // The tree snapshot and correlated receipt use one authenticated stream.
    // An auxiliary journal queue cannot establish this ordering.
    if(!await writeControl(link,{type:"worker-observed",generation,trees:workerObserver.snapshots()})){
      shutdownOwner.invalidateObservation();return;
    }
    if(!await writeControl(link,receipt)){shutdownOwner.invalidateObservation();return;}
    if(receipt.operation==="finalize-nonforcing" && receipt.result.exited && shutdownOwner.finalizationAllowed &&
      controlLink===link)await closeServer?.();
  };
  const close = async () => {
    if(shutdownOwner.pinned)return;
    shutdownOwner.markOrdinaryShutdown();
    if (closing) return;
    closing = true;
    clearInterval(observerTimer); clearInterval(heartbeat);
    for (const check of releaseChecks.values()) { clearTimeout(check.timer); check.resolve(false); }
    releaseChecks.clear();
    await pool.close().catch(() => {});
    if(shutdownOwner.pinned)return;
    await workerObserver.cleanupAll(ORPHAN_CLEANUP_GRACE_MS).catch(() => false);
    if(shutdownOwner.pinned)return;
    try { persistTrees(); } catch { /* The last verified ledger remains. */ }
    await closeServer?.();
  };
  closeServer = await listenExecutionOwner(configuration.endpoint, generation, {
    connected(link, controllerId) {
      if(shutdownOwner.pinned && lastControllerId!==controllerId)shutdownOwner.invalidateObservation();
      lastControllerId=controllerId;
      controlLink={send:link,controllerId};
      // ready precedes any receipt replay.
      link({ type: "ready", protocol: PROTOCOL, version: PROTOCOL_VERSION,
        generation, heartbeatAt: Date.now(), capabilities: pool.capabilities(), journal: journal.status() });
      if(!shutdownOwner.pinned)journal.connect(link, controllerId);
      try { persistTrees(true); } catch { /* observation is advisory */ }
    },
    disconnected() { controlLink=undefined;journal.disconnect(); },
    message(value,authenticatedControllerId) {
      const shutdownRequest=snapshotExecutionShutdownRequest(value);
      if(shutdownRequest){void shutdownControl(shutdownRequest,authenticatedControllerId).catch(()=>shutdownOwner.invalidateObservation());return;}
      if(shutdownOwner.pinned)return;
      if (value?.type === "terminate-owner") {
        shutdownOwner.markOrdinaryShutdown();
        if (["SIGTERM", "SIGINT", "SIGKILL", "SIGSTOP", "SIGCONT"].includes(value.signal)) process.kill(process.pid, value.signal);
        return;
      }
      if (value?.type === "close") { void close(); return; }
      if (value?.generation !== generation || closing) return;
      if (value.type === "recover" && typeof value.requestId === "string") {
        journal.recover(value.requestId, value.afterSequence); return;
      }
      if (value.type === "acknowledge" && typeof value.requestId === "string") {
        journal.acknowledge(value.requestId);
        send({ type: "acknowledged", generation, requestId: value.requestId, journal: journal.status() });
        return;
      }
      if (!isParentMessage(value)) return;
      if (value.type === "protect") { pool.protectThreadFromImplicitResume(value.threadId); return; }
      if (value.type === "release-check-response") {
        const check = releaseChecks.get(value.checkId);
        if (check) { clearTimeout(check.timer); releaseChecks.delete(value.checkId); check.resolve(value.allowed); }
        return;
      }
      if (value.type !== "request") return;
      if (journal.admit(value, CONTROL_EXECUTION_OPERATIONS.has(value.operation)) !== "new") return;
      const operation = executeChildRequest(pool, generation, value, send, async () => {},
        threadId => new Promise<boolean>(resolve => {
          const checkId = randomUUID();
          const timer = setTimeout(() => { releaseChecks.delete(checkId); resolve(false); }, 10_000);
          timer.unref();
          releaseChecks.set(checkId, { resolve, timer });
          send({ type: "release-check", generation, requestId: value.requestId, checkId, threadId });
        }))
        .catch(error => send({ type: "response", generation, requestId: value.requestId,
          ok: false, error: executionError(error) }))
        .finally(() => active.delete(operation));
      active.add(operation);
    }
  });
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
}

async function executeChildRequest(
  pool: CodexAppServerUpstreamPool,
  generation: string,
  request: RequestMessage,
  send: (message: ChildMessage) => void,
  observeWorkers: () => Promise<void>,
  canRelease: (threadId: string) => Promise<boolean>
): Promise<void> {
  const progress = (value: CodexProgress) => {
    const interaction = isRecord(value.event?.details?.interaction)
      ? value.event?.details?.interaction as Record<string, unknown>
      : undefined;
    const interactionId = typeof interaction?.interactionId === "string"
      ? interaction.interactionId
      : undefined;
    const interactionInput = interactionId ? pool.interactionInput(interactionId) : undefined;
    send({
      type: "progress",
      generation,
      requestId: request.requestId,
      progress: value,
      ...(interactionId ? { interactionId } : {}),
      ...(interactionInput ? { interactionInput } : {})
    });
  };
  const assigned = (assignment: UpstreamWorkerAssignment) => send({
    type: "assignment",
    generation,
    requestId: request.requestId,
    assignment,
    capabilities: pool.capabilities()
  });
  let result: unknown;
  switch (request.operation) {
    case "listTools":
      result = await pool.listTools();
      break;
    case "prepareExecution":
      result = await pool.prepareExecution?.(request.args[0] as {
        backendKind: "app-server";
        contextMode: "fresh" | "continue" | "fork";
      });
      break;
    case "listModels":
      result = await pool.listModels?.();
      break;
    case "readAccountSnapshot":
      result = await pool.readAccountSnapshot();
      break;
    case "readAuthenticationPolicy":
      result = await pool.readAuthenticationPolicy();
      break;
    case "readAccountRateLimits":
      result = await pool.readAccountRateLimits();
      break;
    case "startThread":
      result = await pool.startThread?.(
        request.args[0] as CodexThreadStartRequest,
        progress,
        assigned
      );
      break;
    case "continueThread":
      result = await pool.continueThread?.(
        request.args[0] as CodexThreadContinueRequest,
        progress,
        assigned
      );
      break;
    case "forkThread":
      result = await pool.forkThread?.(
        request.args[0] as CodexThreadForkRequest,
        progress,
        assigned
      );
      break;
    case "archiveThread":
      result = await pool.archiveThread?.(String(request.args[0]));
      break;
    case "restoreThread":
      result = await pool.restoreThread?.(String(request.args[0]));
      break;
    case "probeThread":
      result = await pool.probeThread?.(String(request.args[0]));
      break;
    case "releaseThreadConnection":
      {
        const options = request.args[1] as Omit<ThreadReleaseOptions, "canRelease">;
      result = await pool.releaseThreadConnection?.(
        String(request.args[0]),
        { ...options, canRelease }
      );
      break;
      }
    case "listBackgroundTerminals":
      result = await pool.listBackgroundTerminals?.(String(request.args[0]));
      break;
    case "listLoadedBackgroundTerminals":
      result = await pool.listLoadedBackgroundTerminals?.(String(request.args[0]));
      break;
    case "terminateBackgroundTerminal":
      result = await pool.terminateBackgroundTerminal?.(
        String(request.args[0]),
        String(request.args[1])
      );
      break;
    case "callTool":
      result = await pool.callTool(
        String(request.args[0]),
        request.args[1] as Record<string, unknown>,
        progress,
        assigned
      );
      break;
    case "forceTerminateWorker":
      result = await pool.forceTerminateWorker?.(
        request.args[0] as UpstreamWorkerAssignment,
        request.args[1] as WorkerTerminationCorrelation,
        request.args[2] as number | undefined,
        request.args[3] as { interruptOnly: true } | undefined
      );
      break;
    case "respondToInteraction":
      result = await pool.respondToInteraction?.(
        String(request.args[0]),
        request.args[1] as CodexInteractionResponse
      );
      break;
    case "steerThread":
      result = await pool.steerThread?.(String(request.args[0]), String(request.args[1]));
      break;
  }
  const encoded = JSON.stringify(result === undefined ? null : result);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(
      "EXECUTION_RESPONSE_TOO_LARGE: Codex execution response exceeds its IPC limit."
    );
  }
  send({
    type: "response",
    generation,
    requestId: request.requestId,
    ok: true,
    result: result === undefined ? null : result,
    capabilities: pool.capabilities()
  });
}

function resolveExecutionRequestLimits(
  overrides: Partial<CodexExecutionRequestLimits> | undefined
): CodexExecutionRequestLimits {
  const limits = {
    maxPendingRequests: overrides?.maxPendingRequests ?? MAX_PENDING_REQUESTS,
    controlRequestReserve: overrides?.controlRequestReserve ?? CONTROL_REQUEST_RESERVE,
    maxBytesInFlight: overrides?.maxBytesInFlight ?? MAX_REQUEST_BYTES_IN_FLIGHT,
    controlRequestBytesReserve:
      overrides?.controlRequestBytesReserve ?? CONTROL_REQUEST_BYTES_RESERVE
  };
  if (
    !Number.isSafeInteger(limits.maxPendingRequests) ||
    !Number.isSafeInteger(limits.controlRequestReserve) ||
    limits.maxPendingRequests < 2 ||
    limits.controlRequestReserve < 1 ||
    limits.controlRequestReserve >= limits.maxPendingRequests
  ) {
    throw new Error(
      "EXECUTION_CAPACITY_INVALID: Control request slots must be a strict subset of capacity."
    );
  }
  if (
    !Number.isSafeInteger(limits.maxBytesInFlight) ||
    !Number.isSafeInteger(limits.controlRequestBytesReserve) ||
    limits.maxBytesInFlight < 2 ||
    limits.controlRequestBytesReserve < 1 ||
    limits.controlRequestBytesReserve >= limits.maxBytesInFlight
  ) {
    throw new Error(
      "EXECUTION_CAPACITY_INVALID: Control request bytes must be a strict subset of capacity."
    );
  }
  return limits;
}

function serializableOptions(
  options: CodexAppServerProtocolOptions
): SerializableProtocolOptions {
  return {
    ...(options.versionCheckTimeoutMs !== undefined
      ? { versionCheckTimeoutMs: options.versionCheckTimeoutMs }
      : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options.initializeTimeoutMs !== undefined
      ? { initializeTimeoutMs: options.initializeTimeoutMs }
      : {}),
    ...(options.interruptTimeoutMs !== undefined
      ? { interruptTimeoutMs: options.interruptTimeoutMs }
      : {})
  };
}

function executionError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] || "EXECUTION_REQUEST_FAILED",
    message
  };
}

function executionChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = codexProcessEnvironment(source);
  // The executor needs the Codex CLI environment, but it has no authority to
  // open Bridge state, diagnostics, configuration, listener or companion
  // resources. Pass the selected executable in the private child envelope and
  // strip every Bridge configuration variable instead of maintaining a path
  // blacklist that could become incomplete when configuration grows.
  for (const name of Object.keys(environment)) {
    if (name.startsWith("CODEX_MCP_BRIDGE_") || name.startsWith("CODEX_GPT_BRIDGE_")) {
      delete environment[name];
    }
  }
  return environment;
}

function isParentMessage(value: unknown): value is ParentMessage {
  if (!isRecord(value)) return false;
  if (value.type === "close") return true;
  if (value.type === "release-check-response") {
    return typeof value.generation === "string" &&
      typeof value.requestId === "string" &&
      typeof value.checkId === "string" &&
      typeof value.allowed === "boolean";
  }
  if (value.type === "worker-registration-ack") {
    return typeof value.generation === "string" &&
      typeof value.registrationId === "string";
  }
  if (value.type === "worker-cleanup-ack") {
    return typeof value.generation === "string" &&
      typeof value.cleanupId === "string" &&
      typeof value.ok === "boolean";
  }
  if (value.type === "protect") {
    return typeof value.generation === "string" &&
      typeof value.threadId === "string" && value.threadId.length <= 512;
  }
  return value.type === "request" &&
    typeof value.generation === "string" &&
    typeof value.requestId === "string" &&
    EXECUTION_OPERATIONS.includes(value.operation as ExecutionOperation) &&
    Array.isArray(value.args) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_REQUEST_BYTES;
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!isRecord(value)) return false;
  if (value.journal !== undefined && !isJournalStatus(value.journal)) return false;
  if (value.type === "fatal") return typeof value.message === "string";
  if (value.type === "ready") {
    return value.protocol === PROTOCOL && Number.isSafeInteger(value.version) &&
      typeof value.generation === "string" && Number.isSafeInteger(value.heartbeatAt) &&
      isRecord(value.capabilities);
  }
  if (value.type === "heartbeat") {
    return typeof value.generation === "string" && Number.isSafeInteger(value.heartbeatAt) &&
      Number.isSafeInteger(value.inFlight);
  }
  if (value.type === "late-response") {
    return typeof value.generation === "string" && isRecord(value.response);
  }
  if (value.type === "release-check") {
    return typeof value.generation === "string" &&
      typeof value.requestId === "string" &&
      typeof value.checkId === "string" &&
      typeof value.threadId === "string" && value.threadId.length <= 512;
  }
  if (value.type === "worker-started") {
    return typeof value.generation === "string" &&
      typeof value.registrationId === "string" &&
      isJsonRpcProcessIdentity(value.identity);
  }
  if (value.type === "worker-observed") {
    return typeof value.generation === "string" &&
      Array.isArray(value.trees) && value.trees.length <= 100 &&
      value.trees.every((tree: unknown) => isSupervisedProcessTreeSnapshot(tree));
  }
  if (value.type === "worker-observation-status") {
    const incident = value.incident;
    const failure = isRecord(incident) ? incident.failure : undefined;
    return typeof value.generation === "string" &&
      isRecord(incident) && incident.side === "child" &&
      ["refresh", "registration", "cleanup"].includes(incident.phase) &&
      ["degraded", "recovered", "failed"].includes(incident.state) &&
      isProcessObservationFailure(failure);
  }
  if (value.type === "executor-exit-intent") {
    return typeof value.generation === "string" &&
      ["worker-observation-failed", "worker-cleanup-unconfirmed",
        "ipc-send-failed", "ipc-serialization-failed",
        "ipc-message-too-large", "ipc-capacity-exceeded"].includes(value.reason);
  }
  if (value.type === "worker-cleanup-started") {
    return typeof value.generation === "string" &&
      typeof value.cleanupId === "string" &&
      isJsonRpcProcessIdentity(value.identity);
  }
  if (value.type === "worker-exited") {
    return typeof value.generation === "string" &&
      typeof value.cleanupId === "string" &&
      isJsonRpcProcessIdentity(value.identity);
  }
  if (!["progress", "assignment", "response", "acknowledged"].includes(String(value.type))) return false;
  return typeof value.generation === "string" && typeof value.requestId === "string";
}

function isJournalStatus(value: unknown): value is ExecutionJournalStatus {
  if (!isRecord(value) || !Number.isSafeInteger(value.observedAt) || !isRecord(value.lanes)) return false;
  return ["execution", "inspection", "metadata", "control"].every(lane => {
    const state = value.lanes[lane];
    return isRecord(state) && ["capacity", "used", "active", "awaitingAcknowledgement",
      "awaitingCommitAcknowledgement", "oldestAcknowledgementMs"].every(key => Number.isSafeInteger(state[key]) && state[key] >= 0) &&
      state.capacity > 0 && state.used <= state.capacity && state.active + state.awaitingAcknowledgement === state.used &&
      state.awaitingCommitAcknowledgement <= state.awaitingAcknowledgement;
  });
}

function isProcessObservationFailure(value: unknown): value is ProcessObservationFailure {
  return isRecord(value) &&
    ["ps-timeout", "ps-spawn", "ps-exit", "ps-output-limit",
      "ps-output-invalid", "ledger-limit", "registration-lost", "unknown"]
      .includes(value.kind) &&
    Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 &&
    value.durationMs <= 86_400_000 &&
    Number.isSafeInteger(value.timerLatenessMs) && value.timerLatenessMs >= 0 &&
    value.timerLatenessMs <= 86_400_000 &&
    (value.psExitCode === null ||
      (Number.isSafeInteger(value.psExitCode) && value.psExitCode >= 0 &&
        value.psExitCode <= 255)) &&
    (value.osCode === null ||
      (typeof value.osCode === "string" && /^[A-Z0-9_]{1,24}$/u.test(value.osCode)));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcProcessIdentity(value: unknown): value is JsonRpcProcessIdentity {
  return isRecord(value) && Number.isSafeInteger(value.pid) && value.pid >= 2 &&
    (value.processGroupId === null ||
      (Number.isSafeInteger(value.processGroupId) && value.processGroupId >= 2));
}

function isSupervisedProcessTreeSnapshot(
  value: unknown
): value is SupervisedProcessTreeSnapshot {
  return isRecord(value) && isJsonRpcProcessIdentity(value.root) &&
    (value.incomplete === undefined || value.incomplete === true) &&
    Array.isArray(value.processes) && value.processes.length <= 4_096 &&
    value.processes.every((entry: unknown): entry is SupervisedProcessIdentity =>
      isRecord(entry) && Number.isSafeInteger(entry.pid) && entry.pid >= 2 &&
      Number.isSafeInteger(entry.parentPid) && entry.parentPid >= 0 &&
      Number.isSafeInteger(entry.processGroupId) && entry.processGroupId >= 2
    );
}

function readChildConfiguration(encoded: string | undefined): ChildConfiguration {
  if (!encoded) throw new Error("Codex execution child configuration is missing.");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  if (!isRecord(parsed) || parsed.protocol !== PROTOCOL || parsed.version !== PROTOCOL_VERSION ||
      typeof parsed.command !== "string" || !parsed.command ||
      !Number.isInteger(parsed.poolSize) || parsed.poolSize < 1 || parsed.poolSize > 100 ||
      !isRecord(parsed.options)) {
    throw new Error("Codex execution child configuration is invalid.");
  }
  return parsed as ChildConfiguration;
}

const childConfiguration = process.argv[process.argv.indexOf(CHILD_FLAG) + 1];
if (process.argv.includes(CHILD_FLAG)) {
  await runChild(readChildConfiguration(childConfiguration));
}
