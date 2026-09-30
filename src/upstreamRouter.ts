import type { CodexBackendKind } from "./config.js";
import { executionAccessArguments } from "./executionAccess.js";
import type { JsonRpcTerminationResult } from "./jsonRpcProcess.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import { backendSupports } from "./modelPolicy.js";
import { boundedShutdown, combineShutdown, observeShutdown, snapshotShutdownPolicy, shutdownResult,
  type ShutdownPolicy, type ShutdownResult } from "./shutdown.js";
import type { WorkerTerminationCorrelation } from "./cancellation.js";
import type {
  CodexThreadContinueRequest,
  CodexThreadForkRequest,
  CodexThreadStartRequest,
  CodexBackgroundTerminal,
  CodexPendingInteraction,
  CodexInteractionDecision,
  CodexInteractionResponse,
  CodexInteractionInput,
  CodexProgress,
  CodexThreadResumeProbe,
  CodexUpstream,
  CodexWeeklyUsage,
  ToolResult,
  UpstreamWorkerAssignment
} from "./upstream.js";

const INTERNAL_BACKEND_ARGUMENT = "_bridgeBackendKind";

/** Routes App Server execution while preserving retired backend identities in history. */
export class CodexBackendRouter implements CodexUpstream {
  accountRevision?: () => string;
  executionHealth?: () => import("./executionServiceProcess.js").CodexExecutionServiceHealth;
  private readonly threadBackends = new Map<string, CodexBackendKind>();
  private readonly workerBackends = new Map<string, CodexBackendKind>();
  private readonly backends: ReadonlyMap<CodexBackendKind, CodexUpstream>;
  private nonforcingClose?: Promise<ShutdownResult>;
  private nonforcingSettled = false;
  private ordinaryCloseStarted = false;
  private nonforcingHistoryUncertain = false;

  constructor(
    private readonly defaultBackend: CodexBackendKind,
    appOrRegistry: CodexUpstream | ReadonlyMap<CodexBackendKind, CodexUpstream>
  ) {
    this.backends = "callTool" in appOrRegistry
      ? new Map([["app-server", appOrRegistry]])
      : new Map(appOrRegistry);
    if (defaultBackend !== "app-server" || [...this.backends.keys()].some(kind => kind !== "app-server")) {
      throw new Error("CODEX_BACKEND_RETIRED: Only Codex App Server can execute new work.");
    }
    if (!this.backends.has(defaultBackend)) throw new Error(`Codex backend ${defaultBackend} is not installed or enabled.`);
  }

  supportsExecutionRecovery?: () => boolean;
  async recoverExecution(jobId: string, onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void): Promise<ToolResult> {
    const backend = this.backend(this.defaultBackend);
    if (!backend.recoverExecution) throw new Error("EXECUTION_RECOVERY_UNSUPPORTED");
    return backend.recoverExecution(jobId, onProgress, assignment => {
      if (assignment.threadId) this.bindThread(assignment.threadId, this.defaultBackend);
      this.workerBackends.set(assignment.workerId, this.defaultBackend);
      onAssigned?.(assignment);
    });
  }
  async acknowledgeExecution(jobId: string): Promise<void> { await this.backend(this.defaultBackend).acknowledgeExecution?.(jobId); }
  ownsActiveExecution(jobId: string, assignment: UpstreamWorkerAssignment): boolean {
    return this.backend(assignment.backendKind).ownsActiveExecution?.(jobId, assignment) === true;
  }
  ownsRetainedResult(jobId: string, assignment: UpstreamWorkerAssignment): boolean {
    return this.backend(assignment.backendKind).ownsRetainedResult?.(jobId, assignment) === true;
  }
  async detachExecution(): Promise<void> { await this.backend(this.defaultBackend).detachExecution?.(); }

  bindThread(threadId: string, backendKind: CodexBackendKind): void {
    this.threadBackends.set(threadId, backendKind);
  }

  async listTools(): Promise<unknown> {
    this.assertOpen();
    const entries = [...this.backends];
    const results = await Promise.allSettled(entries.map(([, backend]) => backend.listTools()));
    return {
      defaultBackend: this.defaultBackend,
      backends: Object.fromEntries(entries.map(([kind], index) => [kind, settledValue(results[index])]))
    };
  }

  capabilities(backendKind = this.defaultBackend): BackendCapabilities {
    return backendKind === "app-server" ? this.backend(backendKind).capabilities?.(backendKind) || defaultCapabilities(backendKind) : defaultCapabilities(backendKind);
  }

  async prepareExecution(input: { backendKind: CodexBackendKind; contextMode: "fresh" | "continue" | "fork" }): Promise<void> {
    await this.backend(input.backendKind).prepareExecution?.(input);
  }

  async listModels(backendKind = this.defaultBackend): Promise<unknown> {
    const backend = this.backend(backendKind);
    if (!backend.listModels) {
      throw new Error(`Codex backend ${backendKind} does not expose model/list.`);
    }
    return backend.listModels(backendKind);
  }

  async readAccountSnapshot() {
    return this.backend(this.defaultBackend).readAccountSnapshot?.() ?? null;
  }

  async readAccountRateLimits(): Promise<CodexWeeklyUsage | null> {
    // Account usage is exposed only by App Server and is independent of the
    // protocol selected for task execution.
    const backend = this.backend(this.defaultBackend);
    return backend.readAccountRateLimits?.() ?? null;
  }

  startThread(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.callTool(
      "codex",
      {
        prompt: input.prompt,
        ...executionAccessArguments(input),
        ...(backendSupports(input.backendKind, "supportsEphemeralThreads")
          ? { ephemeral: input.ephemeral === true }
          : {}),
        ...selectionArguments(input.selection, input.backendKind),
        ...backendRoutingArgument(input.backendKind)
      },
      onProgress,
      onAssigned
    );
  }

  continueThread(
    input: CodexThreadContinueRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.callTool(
      "codex-reply",
      {
        threadId: input.threadId,
        prompt: input.prompt,
        ...executionAccessArguments(input),
        ...(input.selection ? selectionArguments(input.selection, input.backendKind) : {}),
        ...backendRoutingArgument(input.backendKind)
      },
      onProgress,
      onAssigned
    );
  }

  async forkThread(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const recorded = this.threadBackends.get(input.threadId);
    const kind = recorded || input.backendKind;
    if (recorded && recorded !== input.backendKind) {
      throw new Error(`Codex thread ${input.threadId} is pinned to backend ${recorded}, not ${input.backendKind}.`);
    }
    const backend = this.backend(kind);
    if (!backend.forkThread) throw new Error(`Codex backend ${kind} does not support thread fork.`);
    const result = await backend.forkThread(
      { ...input, backendKind: kind },
      onProgress,
      (assignment) => {
        this.workerBackends.set(assignment.workerId, kind);
        if (assignment.threadId) this.threadBackends.set(assignment.threadId, kind);
        onAssigned?.(assignment);
      }
    );
    const threadId = resultThreadId(result);
    if (threadId) this.threadBackends.set(threadId, kind);
    return result;
  }

  async archiveThread(threadId: string, backendKind?: CodexBackendKind): Promise<void> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) throw new Error("The Agent thread backend is unknown.");
    if (kind !== "app-server") return; // Local archival preserves retired history without launching it.
    const backend = this.backend(kind);
    if (!backend.archiveThread) return;
    await backend.archiveThread(threadId, kind);
  }

  protectThreadFromImplicitResume(threadId: string): void {
    this.backend("app-server").protectThreadFromImplicitResume?.(threadId);
  }

  async releaseThreadConnection(threadId: string, options: import("./threadConnections.js").ThreadReleaseOptions) {
    const kind = this.threadBackends.get(threadId);
    if (kind && kind !== "app-server") return { phase: "blocked" as const, reason: "retired-backend" };
    return this.backend("app-server").releaseThreadConnection?.(threadId, options) ||
      { phase: "blocked" as const, reason: "unsupported" };
  }

  async restoreThread(threadId: string, backendKind?: CodexBackendKind): Promise<void> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) throw new Error("The Agent thread backend is unknown.");
    if (kind !== "app-server") return; // Local archival preserves retired history without launching it.
    const backend = this.backend(kind);
    if (!backend.restoreThread) return;
    await backend.restoreThread(threadId, kind);
  }

  async listBackgroundTerminals(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[]> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsBackgroundTerminals")) return [];
    const backend = this.backend(kind);
    return backend.listBackgroundTerminals
      ? backend.listBackgroundTerminals(threadId, kind)
      : [];
  }

  async listLoadedBackgroundTerminals(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexBackgroundTerminal[] | null> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsBackgroundTerminals")) return null;
    const backend = this.backend(kind);
    return backend.listLoadedBackgroundTerminals
      ? backend.listLoadedBackgroundTerminals(threadId, kind)
      : null;
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string,
    backendKind?: CodexBackendKind
  ): Promise<{ terminated: boolean }> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsBackgroundTerminals")) {
      throw new Error("Background terminal control is available only for Codex App Server threads.");
    }
    const backend = this.backend(kind);
    if (!backend.terminateBackgroundTerminal) {
      throw new Error("The Codex App Server does not support background terminal control.");
    }
    return backend.terminateBackgroundTerminal(threadId, processId, kind);
  }

  canResumeThread(threadId: string, backendKind?: CodexBackendKind): boolean | undefined {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) return undefined;
    if (kind !== "app-server") return false;
    return this.backend(kind).canResumeThread?.(threadId, kind);
  }

  async probeThread(
    threadId: string,
    backendKind?: CodexBackendKind
  ): Promise<CodexThreadResumeProbe> {
    const kind = backendKind || this.threadBackends.get(threadId);
    if (!kind) {
      return { state: "unknown", reason: "transient", threadId, retryable: true };
    }
    if (kind !== "app-server") return { state: "orphaned", reason: "missing", threadId, retryable: false };
    const backend = this.backend(kind);
    if (backend.probeThread) return backend.probeThread(threadId, kind);
    const resumable = backend.canResumeThread?.(threadId, kind);
    if (resumable === true) {
      return { state: "resumable", runtimeStatus: "idle", threadId };
    }
    if (resumable === false) {
      return { state: "orphaned", reason: "missing", threadId, retryable: false };
    }
    return { state: "unknown", reason: "transient", threadId, retryable: true };
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const explicitKind = readBackendKind(args[INTERNAL_BACKEND_ARGUMENT]);
    const requestedThreadId = name === "codex-reply" && typeof args.threadId === "string"
      ? args.threadId
      : undefined;
    const kind = explicitKind || (requestedThreadId ? this.threadBackends.get(requestedThreadId) : undefined) || this.defaultBackend;
    if (requestedThreadId) {
      const recorded = this.threadBackends.get(requestedThreadId);
      if (recorded && recorded !== kind) {
        throw new Error(`Codex thread ${requestedThreadId} is pinned to backend ${recorded}, not ${kind}.`);
      }
    }
    const forwarded = { ...args };
    delete forwarded[INTERNAL_BACKEND_ARGUMENT];
    const result = await this.backend(kind).callTool(
      name,
      forwarded,
      onProgress,
      (assignment) => {
        this.workerBackends.set(assignment.workerId, kind);
        if (assignment.threadId) this.threadBackends.set(assignment.threadId, assignment.backendKind);
        onAssigned?.(assignment);
      }
    );
    const threadId = resultThreadId(result);
    if (threadId) this.threadBackends.set(threadId, kind);
    return result;
  }

  forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs?: number,
    options?: { interruptOnly: true }
  ): Promise<JsonRpcTerminationResult> {
    const backend = this.backend(assignment.backendKind);
    if (!backend.forceTerminateWorker) {
      throw new Error(`Codex backend ${assignment.backendKind} does not support supervised force-stop.`);
    }
    if (options?.interruptOnly && assignment.backendKind !== "app-server") {
      throw new Error("PRECISE_INTERRUPTION_REQUIRED: Automatic recovery cannot terminate a shared worker.");
    }
    return backend.forceTerminateWorker(assignment, correlation, graceMs, options);
  }

  async respondToInteraction(
    interactionId: string,
    response: CodexInteractionResponse
  ): Promise<void> {
    const workerId = interactionId.split(":")[0];
    const kind = this.workerBackends.get(workerId);
    if (!kind) throw new Error("The interaction's exact worker is no longer available.");
    const backend = this.backend(kind);
    if (!backend.respondToInteraction) throw new Error("Interaction handling is unavailable for this backend.");
    await backend.respondToInteraction(interactionId, response);
  }

  interactionInput(interactionId: string): CodexInteractionInput | undefined {
    for (const backend of this.backends.values()) {
      const input = backend.interactionInput?.(interactionId);
      if (input) return input;
    }
    return undefined;
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    const kind = this.threadBackends.get(threadId);
    if (!kind || !this.supports(kind, "supportsSteering") || !this.backend(kind).steerThread) {
      throw new Error("Steering is available only for an active Codex App Server turn.");
    }
    return this.backend(kind).steerThread!(threadId, prompt);
  }

  canSteerThread(threadId: string): boolean {
    const kind = this.threadBackends.get(threadId);
    return !!kind && this.supports(kind, "supportsSteering") && this.backend(kind).canSteerThread?.(threadId) === true;
  }

  async close(): Promise<void> {
    if(this.nonforcingClose) {
      if(!(await this.nonforcingClose).exited) throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
      return;
    }
    this.ordinaryCloseStarted=true;
    this.threadBackends.clear();
    this.workerBackends.clear();
    await Promise.allSettled([...this.backends.values()].map(backend => backend.close()));
  }

  closeNonforcing(policy: ShutdownPolicy & {allowSigkillEscalation:false}): Promise<ShutdownResult> {
    const supplied=snapshotShutdownPolicy(policy);
    if(supplied.allowSigkillEscalation!==false) throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    if(this.nonforcingClose) return this.nonforcingClose;
    const pinned=Object.freeze({...supplied,allowSigkillEscalation:false as const});
    this.nonforcingHistoryUncertain=this.ordinaryCloseStarted;
    let seal!: (result:ShutdownResult)=>void;
    this.nonforcingClose=new Promise(resolve=>{seal=resolve;});
    const receipts: Promise<ShutdownResult>[]=[];
    // Invoke each explicit capability synchronously before yielding. Missing
    // capability is uncertain; never fall back to its ordinary force close.
    for(const backend of this.backends.values()) {
      let operation: Promise<ShutdownResult>;
      try {
        const close=backend.closeNonforcing;
        operation=typeof close==="function" ? Promise.resolve(close.call(backend,pinned)) :
          Promise.resolve(shutdownResult("uncertain"));
      } catch {operation=Promise.resolve(shutdownResult("uncertain"));}
      receipts.push(boundedShutdown(()=>operation,pinned.graceMs*2+6000));
    }
    void Promise.all(receipts).then(results=> {
      if(this.nonforcingHistoryUncertain) results.push(shutdownResult("uncertain"));
      this.nonforcingSettled=true;seal(combineShutdown(results));
    });
    return this.nonforcingClose;
  }

  async observeNonforcingExit(): Promise<ShutdownResult> {
    if(!this.nonforcingClose || !this.nonforcingSettled) return shutdownResult("uncertain");
    const results=await Promise.all([...this.backends.values()].map(backend=>observeShutdown(backend)));
    if(this.nonforcingHistoryUncertain) results.push(shutdownResult("uncertain"));
    return combineShutdown(results);
  }

  private assertOpen(): void {
    if(this.nonforcingClose) throw new Error("Codex upstream router is closed for nonforcing shutdown.");
  }

  private backend(kind: CodexBackendKind): CodexUpstream {
    this.assertOpen();
    if (kind !== "app-server") throw new Error("CODEX_BACKEND_RETIRED: This execution path was removed. Start a fresh App Server context with an explicit handoff summary; existing history is preserved.");
    const backend = this.backends.get(kind);
    if (!backend) throw new Error(`Codex backend ${kind} is not installed or enabled. The thread was not moved to another backend.`);
    return backend;
  }

  private supports(kind: CodexBackendKind, feature: Parameters<typeof backendSupports>[1]): boolean {
    return this.capabilities(kind)[feature] ?? backendSupports(kind, feature);
  }
}

export function backendRoutingArgument(backendKind: CodexBackendKind): Record<string, unknown> {
  return { [INTERNAL_BACKEND_ARGUMENT]: backendKind };
}

function readBackendKind(value: unknown): CodexBackendKind | undefined {
  return value === "mcp-server" || value === "app-server" || value === "codex-sdk" ? value : undefined;
}

function resultThreadId(result: ToolResult): string | undefined {
  if (!result.structuredContent || typeof result.structuredContent !== "object") return undefined;
  const threadId = (result.structuredContent as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId ? threadId : undefined;
}

function settledValue(result: PromiseSettledResult<unknown>): unknown {
  return result.status === "fulfilled"
    ? { available: true, tools: result.value }
    : { available: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

function selectionArguments(
  selection: ModelSelection,
  backendKind: CodexBackendKind
): Record<string, unknown> {
  return {
    model: selection.model,
    config: { model_reasoning_effort: selection.reasoningEffort },
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {})
  };
}

function defaultCapabilities(kind: CodexBackendKind): BackendCapabilities {
  return kind === "app-server"
    ? {
        selectionScope: "turn",
        supportsModelOverrideOnContinue: true,
        supportsEffortOverrideOnContinue: true,
        supportsServiceTierOverrideOnContinue: true,
        supportsFork: true
      }
    : {
        selectionScope: "thread",
        supportsModelOverrideOnContinue: false,
        supportsEffortOverrideOnContinue: false,
        supportsServiceTierOverrideOnContinue: false,
        supportsFork: false
      };
}
