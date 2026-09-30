import type { CallToolResult, Progress } from "@modelcontextprotocol/server";
import type { CodexBackendKind } from "./config.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import type { WorkerTerminationCorrelation } from "./cancellation.js";
import type { JsonRpcTerminationResult } from "./jsonRpcProcess.js";
import type { ExecutionAccessRequest } from "./executionAccess.js";
import type { ShutdownPolicy, ShutdownResult } from "./shutdown.js";

export const MAX_CODEX_INTERACTION_QUESTIONS = 3;

export type ToolResult = CallToolResult;

export type CodexPublicEvent = {
  eventId: string;
  type:
    | "agent-message"
    | "plan"
    | "command"
    | "file-change"
    | "error"
    | "warning"
    | "model"
    | "context"
    | "mcp"
    | "collaboration"
    | "usage"
    | "approval-required"
    | "input-required"
    | "turn";
  phase: "started" | "updated" | "completed" | "waiting";
  createdAt: number;
  summary: string;
  details?: Record<string, unknown>;
};

export type CodexProgress = Progress & { event?: CodexPublicEvent };

export type CodexInteractionDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type CodexInteractionResponse = {
  decision?: CodexInteractionDecision;
  answers?: Record<string, string[]>;
  elicitation?: {
    action: "accept" | "decline" | "cancel";
    content?: Record<string, string | number | boolean | string[]> | null;
  };
};

/** Only read into app-private hydration; URLs and form defaults are transient. */
export type CodexInteractionInput = { url?: string; requestedSchema?: Record<string, unknown> };

export type CodexPendingInteraction = {
  /** Positive correlation with the source tool item; unknown stays on the approval path. */
  origin?: "codex-question" | "app-approval" | "unknown";
  interactionId: string;
  kind: "command-approval" | "file-approval" | "permission-approval" | "user-input" | "mcp-elicitation";
  threadId: string;
  turnId: string;
  itemId: string;
  summary: string;
  isBlocking?: boolean;
  elicitation?: { mode: "form" | "url"; serverName: string };
  reason?: string;
  cwdLabel?: string;
  grantRootLabel?: string;
  availableDecisions?: CodexInteractionDecision[];
  autoResolutionMs?: number | null;
  expiresAt?: number | null;
  networkContext?: {
    host: string;
    protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
  };
  commandActions?: Array<{
    type: "read" | "listFiles" | "search" | "unknown";
    command: string;
    name?: string;
    pathLabel?: string;
    query?: string;
  }>;
  proposedAmendments?: {
    execPolicy?: string[];
    networkPolicy?: Array<{ host: string; action: "allow" | "deny" }>;
  };
  requestedPermissions?: {
    networkEnabled?: boolean | null;
    filesystemRead?: string[];
    filesystemWrite?: string[];
    filesystemEntries?: number;
  };
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    isSecret: boolean;
    isOther?: boolean;
    options?: Array<{ label: string; description: string }>;
  }>;
};

export type CodexThreadLineage = {
  /** App Server session-tree identity reported by the upstream protocol. */
  sessionId?: string;
  /** Direct source thread reported when this thread was created by fork. */
  forkedFromThreadId?: string;
};

export type CodexThreadResumeProbe = (
  | {
      state: "resumable";
      runtimeStatus: "notLoaded" | "idle";
      threadId: string;
    }
  | {
      state: "busy";
      runtimeStatus: "active";
      threadId: string;
      retryable: true;
    }
  | {
      state: "orphaned";
      reason: "missing" | "system-error";
      threadId: string;
      retryable: false;
    }
  | {
      state: "unknown";
      reason: "unsupported" | "transient";
      threadId: string;
      retryable: true;
    }
) & CodexThreadLineage;

export type UpstreamWorkerAssignment = {
  backendKind: CodexBackendKind;
  runtime?: { sdk?: string; python?: string; codex: string; channel?: "stable";
    requestedAuthMode?: "chatgpt" | "api-key"; resolvedAuthMode?: "chatgpt" | "api-key" };
  workerId: string;
  workerGeneration: number;
  threadPersistence?: import("./threadConnections.js").ThreadPersistence;
  workerPid?: number;
  processGroupId?: number;
  upstreamRequestId?: string;
  threadId?: string;
  /** App Server session-tree identity known as soon as the thread is admitted. */
  sessionId?: string;
  /** Direct source thread when the admitted App Server thread is a fork. */
  forkedFromThreadId?: string;
};

export type CodexBackgroundTerminal = {
  processId: string;
  itemId: string;
  command: string;
  cwd: string;
  osPid?: number;
  cpuPercent?: number;
  rssKb?: number;
};

export type CodexThreadStartRequest = ExecutionAccessRequest & {
  backendKind: CodexBackendKind;
  prompt: string;
  selection: ModelSelection;
  /** App Server only: keep the new thread in memory instead of materializing it on disk. */
  contextId?: string;
  ephemeral?: boolean;
};

export type CodexThreadContinueRequest = ExecutionAccessRequest & {
  backendKind: CodexBackendKind;
  threadId: string;
  prompt: string;
  selection?: ModelSelection;
};

export type CodexThreadForkRequest = ExecutionAccessRequest & {
  backendKind: CodexBackendKind;
  threadId: string;
  prompt: string;
  selection?: ModelSelection;
  /** App Server only: keep the fork in memory instead of materializing it on disk. */
  contextId?: string;
  ephemeral?: boolean;
};

export type CodexWeeklyUsage = {
  /** App Server account rate-limit bucket, normally `codex`. */
  limitId: string;
  usedPercent: number;
  remainingPercent: number;
  /** The selected rolling-window duration. Weekly Codex usage is 10,080 minutes. */
  windowDurationMins: number;
  /** Unix timestamp in seconds, or null when the upstream omits the reset time. */
  resetsAt: number | null;
  /** Local observation time in Unix milliseconds. */
  observedAt: number;
};

export type CodexUpstream = {
  supportsExecutionRecovery?(): boolean;
  recoverExecution?(jobId: string, onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void): Promise<ToolResult>;
  acknowledgeExecution?(jobId: string): void | Promise<void>;
  /** Exact live request/worker binding, used only for controls on its existing Job. */
  ownsActiveExecution?(jobId: string, assignment: UpstreamWorkerAssignment): boolean;
  /** The current executor delivered this exact retained terminal receipt. */
  ownsRetainedResult?(jobId: string, assignment: UpstreamWorkerAssignment): boolean;
  detachExecution?(): void | Promise<void>;
  listTools(): Promise<unknown>;
  /** Read-only contract check, before durable task admission. */
  prepareExecution?(input: { backendKind: CodexBackendKind; contextMode: "fresh" | "continue" | "fork" }): Promise<void>;
  capabilities?(backendKind?: CodexBackendKind): BackendCapabilities;
  listModels?(backendKind?: CodexBackendKind): Promise<unknown>;
  /** Account-wide Codex weekly rate-limit projection exposed by App Server. */
  accountRevision?(): string;
  readAccountSnapshot?(): Promise<import("./codexAccount.js").CodexAccountSnapshot | null>;
  readAuthenticationPolicy?(): Promise<{ config: unknown; requirements: unknown }>;
  readAccountRateLimits?(): Promise<CodexWeeklyUsage | null>;
  startThread?(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  continueThread?(
    input: CodexThreadContinueRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  forkThread?(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  archiveThread?(threadId: string, backendKind?: CodexBackendKind): Promise<void>;
  releaseThreadConnection?(threadId: string, options: import("./threadConnections.js").ThreadReleaseOptions): Promise<import("./threadConnections.js").ThreadReleaseResult>;
  protectThreadFromImplicitResume?(threadId: string): void;
  restoreThread?(threadId: string, backendKind?: CodexBackendKind): Promise<void>;
  listBackgroundTerminals?(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[]>;
  /**
   * Inspect background terminals only when the thread is already materialized
   * in the selected App Server worker. A null result means that inspection was
   * intentionally skipped; implementations must never resume a thread here.
   */
  listLoadedBackgroundTerminals?(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[] | null>;
  terminateBackgroundTerminal?(
    threadId: string,
    processId: string,
    backendKind?: CodexBackendKind
  ): Promise<{ terminated: boolean }>;
  canResumeThread?(threadId: string, backendKind?: CodexBackendKind): boolean | undefined;
  probeThread?(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexThreadResumeProbe>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult>;
  forceTerminateWorker?(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs?: number,
    /** Automatic recovery may interrupt only the exact previously requested turn. */
    options?: { interruptOnly: true }
  ): Promise<JsonRpcTerminationResult>;
  respondToInteraction?(
    interactionId: string,
    response: CodexInteractionResponse
  ): Promise<void>;
  interactionInput?(interactionId: string): CodexInteractionInput | undefined;
  /** Positive local evidence that this exact App Server thread has an in-flight turn. */
  canSteerThread?(threadId: string): boolean;
  steerThread?(threadId: string, prompt: string): Promise<{ turnId: string }>;
  close(): Promise<void>;
  /** Optional explicit capability; missing/void evidence never grants shutdown success. */
  closeNonforcing?(policy: ShutdownPolicy & {allowSigkillEscalation:false}): Promise<ShutdownResult>;
  observeNonforcingExit?(): ShutdownResult | Promise<ShutdownResult>;
};
