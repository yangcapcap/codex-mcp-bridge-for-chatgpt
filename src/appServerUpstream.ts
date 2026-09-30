import { boundedShutdown, combineShutdown, observeShutdown, snapshotShutdownPolicy, shutdownResult,
  type ShutdownPolicy, type ShutdownResult } from "./shutdown.js";
import { snapshotWorkerShutdownBinding, snapshotWorkerShutdownSupervisor, workerShutdownResult,
  type WorkerShutdownBinding, type WorkerShutdownSupervisor } from "./workerShutdownReceipt.js";
import { validateInitializeResponse } from "./runtimeCompatibility.js";
import type { ThreadPersistence, ThreadReleaseEvidence, ThreadReleaseOptions, ThreadReleaseResult } from "./threadConnections.js";
import { elicitationResponse, readElicitationInput } from "./mcpElicitation.js";
import { inspectCliProtocol, requireCliProtocol, UNVERIFIED_APP_SERVER_CAPABILITIES, type CliProtocolSupport } from "./cliProtocol.js";
import {
  executionAccessArguments, executionAccessEvidence, executionAccessRequest,
  threadAccessParams, turnAccessParams, verifyExecutionAccess,
  type ExecutionAccessRequest, type VerifiedExecutionAccess
} from "./executionAccess.js";
import { localCodexAccountLabels, projectCodexAccount, type CodexAccountSnapshot } from "./codexAccount.js";
import { randomUUID } from "node:crypto";
import { TOKEN_KEYS, tokenCounts, TurnUsageMeter, type TokenCounts } from "./tokenUsage.js";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Progress } from "@modelcontextprotocol/server";
import {
  DEFAULT_CODEX_VERSION_CHECK_TIMEOUT_MS,
  probeCodexCliVersion,
  verifyCodexCli,
  type CodexCliVersionProbe
} from "./appServerCompatibility.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import {
  JsonRpcProcess,
  JsonRpcServerRequestResolved,
  MAX_JSON_RPC_TIMEOUT_MS,
  type JsonRpcLateResponse,
  type JsonRpcProcessIdentity,
  type JsonRpcTerminationResult
} from "./jsonRpcProcess.js";
import { PRODUCT_INFO } from "./productInfo.js";
import { stableCodexWorkingDirectory } from "./codexService.js";
import { MCP_APPROVAL_ROUTING_FEATURE, questionOrigin } from "./questionRouting.js";
import type { BackendCapabilities, ModelSelection } from "./modelPolicy.js";
import {
  assertWorkerTerminationCorrelation,
  type WorkerTerminationCorrelation
} from "./cancellation.js";
import {
  MAX_CODEX_INTERACTION_QUESTIONS,
  type CodexThreadContinueRequest,
  type CodexThreadForkRequest,
  type CodexThreadStartRequest,
  type CodexBackgroundTerminal,
  type CodexInteractionDecision,
  type CodexInteractionResponse,
  type CodexInteractionInput,
  type CodexPendingInteraction,
  type CodexProgress,
  type CodexPublicEvent,
  type CodexThreadLineage,
  type CodexThreadResumeProbe,
  type CodexUpstream,
  type CodexWeeklyUsage,
  type ToolResult,
  type UpstreamWorkerAssignment
} from "./upstream.js";

const REASONING_NOTIFICATIONS = [
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "rawResponseItem/completed",
  "rawResponse/completed"
];

const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_APP_SERVER_INTERRUPT_TIMEOUT_MS = 5_000;
export const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
export const ACCOUNT_RATE_LIMITS_CACHE_TTL_MS = 60_000;

export const APP_SERVER_CLIENT_INFO = Object.freeze({
  name: PRODUCT_INFO.runtimeName,
  title: PRODUCT_INFO.displayName,
  version: BRIDGE_BUILD_INFO.version
});

export type CodexAppServerLateResponse = JsonRpcLateResponse & {
  workerId: string;
  workerGeneration: number;
};

export type CodexAppServerProtocolOptions = {
  environment?: NodeJS.ProcessEnv;
  /** Deadline for checking the configured executable before each worker admission. */
  versionCheckTimeoutMs?: number;
  /** Deadline for bounded control requests; completed turns remain timer-free. */
  requestTimeoutMs?: number;
  /** Defaults to requestTimeoutMs when omitted. */
  initializeTimeoutMs?: number;
  /** Per-stage deadline for the interrupt acknowledgement and completion confirmation. */
  interruptTimeoutMs?: number;
  /**
   * Receives exact responses for recently timed-out control requests. Raw
   * payloads must be sanitized before logging or persistence.
   */
  onLateResponse?: (response: CodexAppServerLateResponse) => void;
  /** Records the owned spawn before protocol initialization; ps is not an admission gate. */
  onWorkerProcessStarted?: (identity: JsonRpcProcessIdentity) => Promise<void> | void;
  /** Resolves after cleanup of the retained owned tree; reserves only this worker until then. */
  onWorkerProcessExited?: (identity: JsonRpcProcessIdentity) => Promise<void> | void;
  /** Synchronous lifetime observation only; must never signal or release a tree. */
  onWorkerProcessExitObserved?: (identity: JsonRpcProcessIdentity) => void;
  /** Optional local tree proof; absence cannot grant nonforcing success. */
  workerShutdownSupervisor?: WorkerShutdownSupervisor;
};

type ResolvedCodexAppServerProtocolOptions = {
  shutdownOwnerId?: string;
  environment?: NodeJS.ProcessEnv;
  versionCheckTimeoutMs: number;
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  interruptTimeoutMs: number;
  onLateResponse?: (response: CodexAppServerLateResponse) => void;
  onWorkerProcessStarted?: (identity: JsonRpcProcessIdentity) => Promise<void> | void;
  onWorkerProcessExited?: (identity: JsonRpcProcessIdentity) => Promise<void> | void;
  /** Synchronous lifetime observation only; must never signal or release a tree. */
  onWorkerProcessExitObserved?: (identity: JsonRpcProcessIdentity) => void;
  /** Optional local tree proof; absence cannot grant nonforcing success. */
  workerShutdownSupervisor?: WorkerShutdownSupervisor;
};

export type CodexAppServerDependencies = {
  versionProbe?: CodexCliVersionProbe;
  protocolProbe?: typeof inspectCliProtocol;
  workerMetricsProbe?: WorkerMetricsProbe;
};

export type WorkerProcessMetrics = {
  rssKb?: number;
  fdCount?: number;
};

export type WorkerMetricsProbe = (pid: number) => Promise<WorkerProcessMetrics>;

type TurnContext = {
  usage: TurnUsageMeter;
  threadId: string;
  turnId: string;
  lineage: CodexThreadLineage;
  executionAccess: VerifiedExecutionAccess;
  onProgress?: (progress: CodexProgress) => void;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  done: Promise<ToolResult>;
  eventSequence: number;
  finalMessage: string;
  commandOutputTails: Map<string, string>;
  lastAgentMessageEventAt: number;
  inputOrigins: Map<string, "app-approval" | "unknown">;
  inputRoutingVerified: boolean;
};

type PendingInteraction = CodexPendingInteraction & {
  requestId: number | string;
  method: string;
  requestParams: Record<string, unknown>;
  privateInput?: CodexInteractionInput;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  answered: boolean;
  autoResolutionTimer?: NodeJS.Timeout;
};

type AppServerInitializationHealth = {
  protocol: "ready" | "starting";
  config: "ready" | "warning" | "starting";
  configWarningCount: number;
  mcpServers: {
    observed: number;
    starting: number;
    ready: number;
    failed: number;
    cancelled: number;
    unobserved: boolean;
  };
};

type WorkerExitObservation = {
  generation: number;
  expected: boolean;
};

type AppWorker = {
  index: number;
  activeCalls: number;
  maintenance?: Promise<void>;
  generation: number;
  connection?: AppServerConnection;
  startingConnection?: AppServerConnection;
  connecting?: Promise<AppServerConnection>;
  spawnCount: number;
  startupFailureCount: number;
  crashCount: number;
  startupSamples: number;
  startupLatencyTotalMs: number;
  lastStartupLatencyMs?: number;
  lastStartupAt?: number;
  maxStartupLatencyMs: number;
  lastCrashAt?: number;
};

export class CodexAppServerUpstreamPool implements CodexUpstream {
  private readonly workers: AppWorker[];
  private readonly threadWorkers = new Map<string, number>();
  private readonly threadAccessRequests = new Map<string, ExecutionAccessRequest>();
  private readonly threadResumeEvidence = new Map<string, boolean>();
  private readonly releaseEvidence = new Map<string, ThreadReleaseEvidence>();
  private readonly detachedThreads = new Set<string>();
  private readonly protocolOptions: ResolvedCodexAppServerProtocolOptions;
  private readonly versionProbe: CodexCliVersionProbe;
  private readonly workerMetricsProbe: WorkerMetricsProbe;
  private protocolSupport?: CliProtocolSupport;
  private protocolCheck?: Promise<CliProtocolSupport>;
  private readonly protocolProbe: typeof inspectCliProtocol;
  private compatibilityCheck?: Promise<string>;
  private compatibilityAbort?: AbortController;
  private accountRateLimitsCache?: {
    value: CodexWeeklyUsage | null;
    expiresAt: number;
  };
  private accountRateLimitsRequest?: Promise<CodexWeeklyUsage | null>;
  private closing = false;
  private readonly shutdownOwnerId = randomUUID();
  private nonforcingClose?: Promise<ShutdownResult>;
  private nonforcingSettled = false;
  private nonforcingHistoryUncertain = false;
  private readonly nonforcingConnections = new Set<AppServerConnection>();

  constructor(
    private readonly codexCommand: string,
    poolSize = 4,
    protocolOptions: CodexAppServerProtocolOptions = {},
    dependencies: CodexAppServerDependencies = {}
  ) {
    if (!Number.isInteger(poolSize) || poolSize <= 0) {
      throw new Error("Codex App Server pool size must be a positive integer.");
    }
    this.protocolOptions = resolveProtocolOptions(protocolOptions);
    this.versionProbe = dependencies.versionProbe || probeCodexCliVersion;
    this.protocolProbe = dependencies.protocolProbe || inspectCliProtocol;
    this.workerMetricsProbe = dependencies.workerMetricsProbe || defaultWorkerMetricsProbe;
    this.workers = Array.from({ length: poolSize }, (_, index) => ({
      index,
      activeCalls: 0,
      generation: 0,
      spawnCount: 0,
      startupFailureCount: 0,
      crashCount: 0,
      startupSamples: 0,
      startupLatencyTotalMs: 0,
      maxStartupLatencyMs: 0
    }));
  }

  async listTools(): Promise<unknown> {
    if (this.closing) throw new Error("Codex App Server upstream is closed.");
    const resumableEvidence = [...this.threadResumeEvidence.values()];
    const liveWorkers = this.workers.filter(
      (worker): worker is AppWorker & { connection: AppServerConnection } =>
        Boolean(worker.connection && !worker.connection.exited)
    );
    const metricSamples = await Promise.all(
      liveWorkers.map(async (worker) => {
        const pid = worker.connection.identity?.pid;
        if (!pid) return undefined;
        try {
          return await this.workerMetricsProbe(pid);
        } catch {
          return undefined;
        }
      })
    );
    const observedMetrics = metricSamples.filter(
      (sample): sample is WorkerProcessMetrics => Boolean(sample)
    );
    const rssSamples = observedMetrics.flatMap((sample) =>
      sample.rssKb === undefined ? [] : [sample.rssKb]
    );
    const fdSamples = observedMetrics.flatMap((sample) =>
      sample.fdCount === undefined ? [] : [sample.fdCount]
    );
    const startupSamples = this.workers.reduce((total, worker) => total + worker.startupSamples, 0);
    const startupLatencyTotalMs = this.workers.reduce(
      (total, worker) => total + worker.startupLatencyTotalMs,
      0
    );
    const initialization = aggregateInitializationHealth(liveWorkers.map((worker) =>
      worker.connection.initializationHealth
    ));
    const totalSpawns = this.workers.reduce((total, worker) => total + worker.spawnCount, 0);
    const totalCrashes = this.workers.reduce((total, worker) => total + worker.crashCount, 0);
    return {
      tools: [
        { name: "codex", description: "Start a Codex App Server thread and turn." },
        { name: "codex-reply", description: "Resume a Codex App Server thread and start a turn." },
        ...(this.capabilities().supportsFork ? [{ name: "thread/fork", description: "Fork a persisted Codex thread and start a turn." }] : []),
        { name: "thread/archive", description: "Archive a persisted Codex thread." },
        { name: "thread/unarchive", description: "Restore an archived Codex thread." },
        ...(this.capabilities().supportsSteering ? [{ name: "turn/steer", description: "Steer an active Codex App Server turn." }] : []),
        ...(this.capabilities().supportsPreciseCancellation ? [{ name: "turn/interrupt", description: "Interrupt an active Codex App Server turn." }] : [])
      ],
      backendKind: "app-server",
      experimental: true,
      capabilities: this.capabilities(),
      protocol: this.protocolSupport ? { verified: true, compatible: this.protocolSupport.compatible, unsupported: this.protocolSupport.unsupported } : { verified: false },
      workerHealth: {
        configured: this.workers.length,
        live: liveWorkers.length,
        starting: this.workers.filter((worker) => Boolean(worker.connecting)).length,
        activeCalls: this.workers.reduce((total, worker) => total + worker.activeCalls, 0),
        stickyThreads: this.threadWorkers.size,
        resources: {
          observedWorkers: observedMetrics.length,
          unavailableWorkers: Math.max(0, liveWorkers.length - observedMetrics.length),
          rssKb: metricAggregate(rssSamples),
          fdCount: metricAggregate(fdSamples)
        },
        startup: {
          spawnCount: totalSpawns,
          failureCount: this.workers.reduce(
            (total, worker) => total + worker.startupFailureCount,
            0
          ),
          latencyMs: {
            samples: startupSamples,
            average: startupSamples > 0
              ? Math.round(startupLatencyTotalMs / startupSamples)
              : null,
            latest: latestStartupLatency(this.workers),
            max: Math.max(0, ...this.workers.map((worker) => worker.maxStartupLatencyMs)) || null
          }
        },
        crashes: {
          count: totalCrashes,
          ratePerSpawn: totalSpawns > 0 ? totalCrashes / totalSpawns : 0,
          lastObservedAt: latestWorkerValue(this.workers, "lastCrashAt")
            ? new Date(latestWorkerValue(this.workers, "lastCrashAt") as number).toISOString()
            : null
        },
        initialization
      },
      resumeEvidence: {
        available: resumableEvidence.filter(Boolean).length,
        unavailable: resumableEvidence.filter((value) => !value).length
      }
    };
  }

  capabilities(): BackendCapabilities {
    return this.protocolSupport?.capabilities || UNVERIFIED_APP_SERVER_CAPABILITIES;
  }

  async prepareExecution(input: { contextMode: "fresh" | "continue" | "fork" }): Promise<void> {
    await this.connectionFor(this.leastBusyWorker());
    requireCliProtocol(await this.inspectProtocol(), input.contextMode);
  }

  private inspectProtocol(): Promise<CliProtocolSupport> {
    return this.protocolCheck ||= this.protocolProbe(this.codexCommand, this.protocolOptions.environment || process.env)
      .then(support => { this.protocolSupport = support; return support; })
      .catch(error => { this.protocolCheck = undefined; throw error; });
  }

  startThread(
    input: CodexThreadStartRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    return this.callTool(
      "codex",
      requestArguments(input.prompt, input.selection, {
        ...executionAccessArguments(input),
        ephemeral: input.ephemeral === true
      }),
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
      requestArguments(input.prompt, input.selection, {
        threadId: input.threadId,
        ...(input.cwd ? executionAccessArguments(input) : {})
      }),
      onProgress,
      onAssigned
    );
  }

  async forkThread(
    input: CodexThreadForkRequest,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const preferredIndex = this.threadWorkers.get(input.threadId);
    const worker = preferredIndex === undefined ? this.leastBusyWorker() : this.workers[preferredIndex];
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      requireCliProtocol(await this.inspectProtocol(), "fork");
      const result = await connection.forkThreadAndTurn(
        input.threadId,
        requestArguments(input.prompt, input.selection, {
          ...executionAccessArguments(input.cwd ? input : this.requireThreadAccess(input.threadId)),
          ephemeral: input.ephemeral === true
        }),
        onProgress,
        (assignment) => {
          if (assignment.threadId) {
            this.threadWorkers.set(assignment.threadId, worker.index);
            this.threadResumeEvidence.set(assignment.threadId, true);
            this.threadAccessRequests.set(assignment.threadId, executionAccessRequest(executionAccessArguments(input.cwd ? input : this.requireThreadAccess(input.threadId))));
          }
          onAssigned?.(assignment);
        }
      );
      const threadId = structuredString(result, "threadId");
      if (threadId) {
        this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      }
      return result;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.withThreadWorker(threadId, (connection) => connection.archiveThread(threadId));
    this.threadWorkers.delete(threadId);
    this.threadResumeEvidence.set(threadId, false);
  }

  async restoreThread(threadId: string): Promise<void> {
    await this.withThreadWorker(threadId, (connection) => connection.restoreThread(threadId));
    this.threadResumeEvidence.set(threadId, true);
  }

  async listBackgroundTerminals(threadId: string): Promise<CodexBackgroundTerminal[]> {
    this.assertImplicitResumeAllowed(threadId);
    return this.withThreadWorker(threadId, (connection) => connection.listBackgroundTerminals(threadId));
  }

  private assertImplicitResumeAllowed(threadId: string): void {
    if (this.detachedThreads.has(threadId)) throw new Error("THREAD_RELEASED: Continue this conversation explicitly before opening work controls.");
  }

  protectThreadFromImplicitResume(threadId: string): void { this.detachedThreads.add(threadId); }

  async releaseThreadConnection(threadId: string, options: ThreadReleaseOptions): Promise<ThreadReleaseResult> {
    if (this.closing) return { phase: "blocked", reason: "runtime-shutdown" };
    const index = this.threadWorkers.get(threadId);
    const worker = index === undefined ? undefined : this.workers[index];
    if (!worker?.connection || worker.connection.exited) {
      const evidence = this.releaseEvidence.get(threadId);
      if (evidence) return { phase: "released", evidence };
      if (options.previousWorkerPid) {
        try { process.kill(options.previousWorkerPid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return { phase: "released", evidence: "worker-exited" };
        }
      }
      return { phase: "blocked", reason: "ownership-unconfirmed" };
    }
    await worker.maintenance;
    const connection = worker.connection;
    if (!connection || connection.exited || this.closing) return { phase: "blocked", reason: "connection-changed" };
    if (!this.capabilities().supportsThreadUnsubscribe) return { phase: "blocked", reason: "unsupported" };
    const canRelease = async (id: string): Promise<boolean> =>
      Boolean(await options.canRelease(id));
    const allCanRelease = async (ids: readonly string[]): Promise<boolean> => {
      for (const id of ids) if (!(await canRelease(id))) return false;
      return true;
    };
    let unlock!: () => void;
    const maintenance = worker.maintenance = new Promise<void>(resolve => { unlock = resolve; });
    try {
      if (!(await canRelease(threadId))) return { phase: "blocked", reason: "active-work" };
      const safety = await connection.releaseSafety(threadId);
      if (!safety.safe) return { phase: "blocked", reason: safety.reason };
      if (!(await canRelease(threadId))) return { phase: "blocked", reason: "active-work" };
      this.detachedThreads.add(threadId);
      const acknowledgement = await connection.unsubscribeThread(threadId);
      if (acknowledgement === "notLoaded") {
        this.onThreadClosed(worker, connection, threadId);
        return { phase: "released", evidence: "thread-unloaded" };
      }
      const loaded = await connection.listLoadedThreads();
      if (!loaded.includes(threadId)) {
        this.onThreadClosed(worker, connection, threadId);
        return { phase: "released", evidence: "thread-unloaded" };
      }
      // Retire only a completely eligible worker. An unknown child thread,
      // pending request, ephemeral context or another admission prevents it.
      if (worker.activeCalls === 0 &&
          loaded.every(id => options.eligibleThreadIds.includes(id)) &&
          await allCanRelease(loaded)) {
        for (const id of loaded) {
          if (!(await connection.releaseSafety(id)).safe) return { phase: "unsubscribed", reason: "shared-worker-protected" };
        }
        if (worker.activeCalls === 0 && await allCanRelease(loaded)) {
          for (const id of loaded) {
            if (!(await canRelease(id)) || worker.activeCalls > 0) return { phase: "unsubscribed", reason: "shared-worker-protected" };
            await connection.unsubscribeThread(id);
            this.detachedThreads.add(id);
          }
          if (worker.activeCalls === 0 && await allCanRelease(loaded)) {
            await connection.close();
            if (connection.exited) {
              for (const id of loaded) this.releaseEvidence.set(id, "worker-exited");
              return { phase: "released", evidence: "worker-exited", releasedThreadIds: loaded };
            }
          }
        }
      }
      return { phase: "unsubscribed", reason: "upstream-unload-grace" };
    } finally {
      if (worker.maintenance === maintenance) worker.maintenance = undefined;
      unlock();
    }
  }

  async listLoadedBackgroundTerminals(
    threadId: string
  ): Promise<CodexBackgroundTerminal[] | null> {
    const preferredIndex = this.threadWorkers.get(threadId);
    if (preferredIndex === undefined) return null;
    const worker = this.workers[preferredIndex];
    const connection = worker?.connection;
    if (!worker || !connection || connection.exited) return null;

    worker.activeCalls += 1;
    try {
      return await connection.listLoadedBackgroundTerminals(threadId);
    } finally {
      worker.activeCalls -= 1;
    }
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string
  ): Promise<{ terminated: boolean }> {
    this.assertImplicitResumeAllowed(threadId);
    return this.withThreadWorker(threadId, (connection) =>
      connection.terminateBackgroundTerminal(threadId, processId)
    );
  }

  async listModels(): Promise<unknown> {
    const worker = this.leastBusyWorker();
    worker.activeCalls += 1;
    try {
      return await (await this.connectionFor(worker)).listModels();
    } finally {
      worker.activeCalls -= 1;
    }
  }

  async readAccountSnapshot(): Promise<CodexAccountSnapshot | null> {
    return (await this.readAccountDetails()).snapshot;
  }

  /** Account email is returned only to local authentication management. */
  async readAccountDetails(): Promise<{ snapshot: CodexAccountSnapshot; email: string | null; workspaceName: string | null }> {
    const worker = this.leastBusyWorker();
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      const account = await connection.readAccount();
      const limits = projectCodexAccount(account, null).authMode === "chatgpt"
        ? await connection.readAccountRateLimits().catch(() => null) : null;
      const { email, workspaceName } = localCodexAccountLabels(account);
      return { snapshot: projectCodexAccount(account, limits), email, workspaceName };
    } finally { worker.activeCalls -= 1; }
  }

  async readAuthenticationPolicy(): Promise<{ config: unknown; requirements: unknown }> {
    const worker = this.leastBusyWorker();
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      const config = await connection.readConfiguration();
      const requirements = await connection.readConfigurationRequirements();
      return { config, requirements };
    } finally { worker.activeCalls -= 1; }
  }

  async logoutAccount(): Promise<void> {
    const worker = this.leastBusyWorker();
    worker.activeCalls += 1;
    try { await (await this.connectionFor(worker)).logoutAccount(); }
    finally { worker.activeCalls -= 1; }
  }

  async readAccountRateLimits(): Promise<CodexWeeklyUsage | null> {
    const now = Date.now();
    if (this.accountRateLimitsCache && now < this.accountRateLimitsCache.expiresAt) {
      return this.accountRateLimitsCache.value;
    }
    if (this.accountRateLimitsRequest) return this.accountRateLimitsRequest;

    const request = this.fetchAccountRateLimits().then((value) => {
      this.accountRateLimitsCache = {
        value,
        expiresAt: Date.now() + ACCOUNT_RATE_LIMITS_CACHE_TTL_MS
      };
      return value;
    }).finally(() => {
      if (this.accountRateLimitsRequest === request) this.accountRateLimitsRequest = undefined;
    });
    this.accountRateLimitsRequest = request;
    return request;
  }

  canResumeThread(threadId: string): boolean | undefined {
    return this.threadResumeEvidence.get(threadId) ??
      (this.threadWorkers.has(threadId) ? true : undefined);
  }

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    const preferredIndex = this.threadWorkers.get(threadId);
    const worker = preferredIndex === undefined ? this.leastBusyWorker() : this.workers[preferredIndex];
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      const probe = await connection.probeThread(threadId);
      if (probe.state === "resumable" || probe.state === "busy") {
        // A read must not invent ownership of a historical or handed-off thread.
        if (preferredIndex !== undefined && probe.runtimeStatus !== "notLoaded") this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      } else if (probe.state === "orphaned") {
        this.threadWorkers.delete(threadId);
        this.threadResumeEvidence.set(threadId, false);
      }
      return probe;
    } catch {
      if (worker.connection?.exited) {
        worker.connection = undefined;
        this.forgetWorkerThreads(worker.index);
      }
      return { state: "unknown", reason: "transient", threadId, retryable: true };
    } finally {
      worker.activeCalls -= 1;
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    if (name !== "codex" && name !== "codex-reply") {
      throw new Error(`Unsupported App Server compatibility tool: ${name}.`);
    }
    const requestedThreadId = name === "codex-reply" ? requiredString(args.threadId, "threadId") : undefined;
    const previousAccess = requestedThreadId ? this.threadAccessRequests.get(requestedThreadId) : undefined;
    args = { ...(previousAccess ? executionAccessArguments(previousAccess) : {}), ...args };
    const requestedAccess = executionAccessRequest(args);
    const preferred = requestedThreadId === undefined
      ? undefined
      : this.workers[this.threadWorkers.get(requestedThreadId) ?? -1];
    const worker = preferred || this.leastBusyWorker();
    worker.activeCalls += 1;
    try {
      const connection = await this.connectionFor(worker);
      requireCliProtocol(await this.inspectProtocol(), name === "codex" ? "fresh" : "continue");
      const assigned = (assignment: UpstreamWorkerAssignment) => {
        if (assignment.threadId) {
          this.threadWorkers.set(assignment.threadId, worker.index);
          this.threadResumeEvidence.set(assignment.threadId, true);
          this.threadAccessRequests.set(assignment.threadId, requestedAccess);
          this.detachedThreads.delete(assignment.threadId);
          this.releaseEvidence.delete(assignment.threadId);
        }
        onAssigned?.(assignment);
      };
      const result = name === "codex"
        ? await connection.startThreadAndTurn(args, onProgress, assigned)
        : await connection.resumeThreadAndTurn(requestedThreadId as string, args, onProgress, assigned);
      const threadId = structuredString(result, "threadId");
      if (threadId) {
        this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      }
      return result;
    } catch (error) {
      if (worker.connection?.exited) {
        worker.connection = undefined;
        this.forgetWorkerThreads(worker.index);
      }
      throw error;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  interactionInput(interactionId: string): CodexInteractionInput | undefined {
    for (const worker of this.workers) {
      const input = worker.connection?.interactionInput(interactionId);
      if (input) return input;
    }
    return undefined;
  }

  async forceTerminateWorker(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs?: number,
    options?: { interruptOnly: true }
  ): Promise<JsonRpcTerminationResult> {
    if (this.closing) throw new Error("Codex App Server upstream is closed.");
    assertWorkerTerminationCorrelation(correlation);
    const worker = this.workers.find((candidate) => `app-${candidate.index}` === assignment.workerId);
    if (!worker || !worker.connection || worker.generation !== assignment.workerGeneration) {
      throw new Error("The selected App Server worker generation is no longer active.");
    }
    const result = await worker.connection.interruptOrTerminate(assignment, correlation, graceMs, options);
    if (result.workerExited && !this.nonforcingClose) {
      worker.connection = undefined;
      this.forgetWorkerThreads(worker.index);
    }
    return result;
  }

  ownsActiveExecution(_jobId: string, assignment: UpstreamWorkerAssignment): boolean {
    const worker = this.workers.find(candidate => `app-${candidate.index}` === assignment.workerId);
    return Boolean(worker?.connection && worker.generation === assignment.workerGeneration &&
      assignment.threadId && assignment.upstreamRequestId &&
      worker.connection.hasExactTurn(assignment.threadId, assignment.upstreamRequestId));
  }

  private requireThreadAccess(threadId: string): ExecutionAccessRequest {
    const access = this.threadAccessRequests.get(threadId);
    if (!access) throw new Error("EXECUTION_ACCESS_REQUIRED: The thread has no known execution policy; supply cwd, sandbox, and approvalPolicy.");
    return access;
  }

  async respondToInteraction(
    interactionId: string,
    response: CodexInteractionResponse
  ): Promise<void> {
    if (this.closing) throw new Error("Codex App Server upstream is closed.");
    for (const worker of this.workers) {
      if (worker.connection?.respondToInteraction(interactionId, response)) return;
    }
    throw new Error("Unknown or already resolved Codex interaction id.");
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    if (!this.capabilities().supportsSteering) throw new Error("CODEX_PROTOCOL_UNSUPPORTED: The selected CLI does not support turn/steer.");
    const workerIndex = this.threadWorkers.get(threadId);
    const worker = workerIndex === undefined ? undefined : this.workers[workerIndex];
    if (!worker?.connection) throw new Error("The requested Codex thread has no active App Server turn to steer.");
    return worker.connection.steerThread(threadId, prompt);
  }

  canSteerThread(threadId: string): boolean {
    const workerIndex = this.threadWorkers.get(threadId);
    const worker = workerIndex === undefined ? undefined : this.workers[workerIndex];
    return this.capabilities().supportsSteering === true && Boolean(worker?.connection?.hasActiveTurn(threadId));
  }

  closeNonforcing(policy: ShutdownPolicy & {allowSigkillEscalation:false}): Promise<ShutdownResult> {
    const pinned=snapshotShutdownPolicy(policy);
    if (pinned.allowSigkillEscalation!==false) throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    if (this.nonforcingClose) return this.nonforcingClose;
    this.nonforcingHistoryUncertain=this.closing;
    this.closing=true;
    let resolve!: (result:ShutdownResult)=>void;
    this.nonforcingClose=new Promise(done=>{resolve=done;});
    this.accountRateLimitsCache=undefined;
    this.accountRateLimitsRequest=undefined;
    const compatibility=this.compatibilityCheck;
    this.compatibilityAbort?.abort();
    const receipts:Promise<ShutdownResult>[]=[];
    for (const worker of this.workers) {
      for (const connection of [worker.connection,worker.startingConnection]) {
        if (!connection || this.nonforcingConnections.has(connection)) continue;
        this.nonforcingConnections.add(connection);
        // Each connection pins transport and tree synchronously before the first await.
        receipts.push(connection.closeNonforcing({...pinned,allowSigkillEscalation:false}));
      }
    }
    const deadline=pinned.graceMs*2+6000;
    const compatibilityReceipt=compatibility ? boundedShutdown(async()=> {
      try { await compatibility; } catch { /* cancelled admission */ }
      return shutdownResult("exited");
    },deadline) : Promise.resolve(shutdownResult("exited"));
    void Promise.all([...receipts,compatibilityReceipt]).then(results=> {
      this.nonforcingSettled=true;
      resolve(combineShutdown([...results,...(this.nonforcingHistoryUncertain ? [shutdownResult("uncertain")] : [])]));
    },()=>{this.nonforcingSettled=true;resolve(shutdownResult("uncertain"));});
    return this.nonforcingClose;
  }

  async observeNonforcingExit(): Promise<ShutdownResult> {
    if (!this.nonforcingClose || !this.nonforcingSettled || this.nonforcingHistoryUncertain || this.compatibilityCheck) return shutdownResult("uncertain");
    const results=await Promise.all([...this.nonforcingConnections].map(connection=>observeShutdown(connection)));
    return combineShutdown(results.length ? results : [shutdownResult("exited")]);
  }

  async close(): Promise<void> {
    if (this.nonforcingClose) {
      if (!(await this.nonforcingClose).exited) throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
      return;
    }
    this.closing = true;
    this.accountRateLimitsCache = undefined;
    this.accountRateLimitsRequest = undefined;
    this.threadWorkers.clear();
    this.threadResumeEvidence.clear();
    const compatibilityCheck = this.compatibilityCheck;
    this.compatibilityAbort?.abort();
    if (compatibilityCheck) {
      try {
        await compatibilityCheck;
      } catch {
        // Closing intentionally cancels an in-flight executable admission check.
      }
    }
    await Promise.all(
      this.workers.map(async (worker) => {
        const connections = new Set(
          [worker.connection, worker.startingConnection].filter(
            (connection): connection is AppServerConnection => Boolean(connection)
          )
        );
        await Promise.all([...connections].map((connection) => connection.close()));
        if (!worker.connecting) return;
        try {
          await worker.connecting;
        } catch {
          // Failed and interrupted startup paths clean up their own process.
        }
      })
    );
  }

  private leastBusyWorker(): AppWorker {
    if (this.closing) throw new Error("Codex App Server upstream is closed.");
    const available = this.workers.filter(worker => !worker.maintenance);
    if (!available.length) throw new Error("CODEX_WORKER_CAPACITY: All worker slots are reserved for unconfirmed cleanup.");
    return available.reduce((selected, candidate) =>
      candidate.activeCalls < selected.activeCalls ||
      (candidate.activeCalls === selected.activeCalls && candidate.index < selected.index)
        ? candidate
        : selected
    );
  }

  private async fetchAccountRateLimits(): Promise<CodexWeeklyUsage | null> {
    const worker = this.leastBusyWorker();
    worker.activeCalls += 1;
    try {
      const response = await (await this.connectionFor(worker)).readAccountRateLimits();
      return parseCodexWeeklyUsage(response);
    } catch {
      // Usage is supplemental card data. A missing/older endpoint must not
      // prevent the overview or Activity feed from rendering.
      return null;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  private invalidateAccountRateLimits(): void {
    this.accountRateLimitsCache = undefined;
  }

  private async withThreadWorker<T>(
    threadId: string,
    operation: (connection: AppServerConnection) => Promise<T>
  ): Promise<T> {
    const preferredIndex = this.threadWorkers.get(threadId);
    const worker = preferredIndex === undefined ? this.leastBusyWorker() : this.workers[preferredIndex];
    worker.activeCalls += 1;
    try {
      const result = await operation(await this.connectionFor(worker));
      this.threadWorkers.set(threadId, worker.index);
      return result;
    } finally {
      worker.activeCalls -= 1;
    }
  }

  private async connectionFor(worker: AppWorker): Promise<AppServerConnection> {
    await worker.maintenance;
    if (this.closing) throw new Error("Codex App Server upstream is closed.");
    if (worker.connection && !worker.connection.exited) return worker.connection;
    if (!worker.connecting) {
      await this.ensureCompatibleExecutable();
      if (this.closing) throw new Error("Codex App Server upstream is closed.");
      if (worker.connection && !worker.connection.exited) return worker.connection;
      if (!worker.connecting) {
        const generation = ++worker.generation;
        const startupStartedAt = Date.now();
        worker.spawnCount += 1;
        const connection = AppServerConnection.spawn(
          this.codexCommand,
          `app-${worker.index}`,
          generation,
          {
            ...this.protocolOptions,
            shutdownOwnerId: this.shutdownOwnerId,
            onLateResponse: (response) => this.onWorkerLateResponse(worker, response)
          },
          (observation) => this.onWorkerExit(worker, connection, observation),
          () => this.invalidateAccountRateLimits(),
          (threadId) => this.onThreadClosed(worker, connection, threadId)
        );
        worker.startingConnection = connection;
        worker.connecting = connection.initializeForAdmission().then(async (initialized) => {
          if (this.closing) {
            await initialized.close();
            throw new Error("Codex App Server upstream closed during worker startup.");
          }
          const startupLatencyMs = Math.max(0, Date.now() - startupStartedAt);
          worker.startupSamples += 1;
          worker.startupLatencyTotalMs += startupLatencyMs;
          worker.lastStartupLatencyMs = startupLatencyMs;
          worker.lastStartupAt = Date.now();
          worker.maxStartupLatencyMs = Math.max(worker.maxStartupLatencyMs, startupLatencyMs);
          worker.connection = initialized;
          return initialized;
        }).catch((error) => {
          if (!this.closing) worker.startupFailureCount += 1;
          throw error;
        });
      }
    }
    const pending = worker.connecting;
    const starting = worker.startingConnection;
    try {
      return await pending;
    } finally {
      if (worker.connecting === pending) worker.connecting = undefined;
      if (worker.startingConnection === starting) worker.startingConnection = undefined;
    }
  }

  private ensureCompatibleExecutable(): Promise<string> {
    if (this.compatibilityCheck) return this.compatibilityCheck;
    const controller = new AbortController();
    const check = verifyCodexCli(
      this.codexCommand,
      this.protocolOptions.versionCheckTimeoutMs,
      this.versionProbe,
      controller.signal
    ).then(async version => {
      // An external app/npm installation may change at the same path while an
      // older worker is running. Every replacement worker gets fresh contract
      // evidence, including replacements that reuse the same version string.
      this.protocolSupport = undefined;
      this.protocolCheck = undefined;
      requireCliProtocol(await this.inspectProtocol(), "fresh");
      return version;
    });
    this.compatibilityCheck = check;
    this.compatibilityAbort = controller;
    const clear = () => {
      if (this.compatibilityCheck === check) {
        this.compatibilityCheck = undefined;
        this.compatibilityAbort = undefined;
      }
    };
    void check.then(clear, clear);
    return check;
  }

  private onWorkerLateResponse(worker: AppWorker, response: CodexAppServerLateResponse): void {
    if (worker.generation === response.workerGeneration && lateResponseSucceeded(response)) {
      const threadId = lateResponseThreadId(response);
      if (threadId && ["thread/start", "thread/fork", "thread/resume", "turn/start"].includes(response.method) && !this.detachedThreads.has(threadId)) {
        this.threadWorkers.set(threadId, worker.index);
        this.threadResumeEvidence.set(threadId, true);
      }
    }
    this.protocolOptions.onLateResponse?.(response);
  }

  private onWorkerExit(
    worker: AppWorker,
    connection: AppServerConnection,
    observation: WorkerExitObservation
  ): void {
    if (worker.generation !== observation.generation) return;
    if (!observation.expected && !this.closing) {
      worker.crashCount += 1;
      worker.lastCrashAt = Date.now();
    }
    const previousMaintenance = worker.maintenance;
    const cleanup = Promise.resolve(previousMaintenance)
      .then(() => connection.waitForSupervisionRelease())
      .then(() => {
        if (this.nonforcingClose) return;
        if (worker.connection === connection) worker.connection = undefined;
        if (worker.startingConnection === connection) worker.startingConnection = undefined;
        if (worker.maintenance === cleanup) worker.maintenance = undefined;
      });
    worker.maintenance = cleanup;
    // A failed cleanup reserves this worker slot. Other workers remain usable;
    // only verified cleanup may release capacity for a replacement generation.
    void cleanup.catch(() => undefined);
    if (!this.nonforcingClose) this.forgetWorkerThreads(worker.index);
  }

  private forgetWorkerThreads(workerIndex: number): void {
    for (const [threadId, index] of this.threadWorkers) {
      if (index === workerIndex) {
        this.threadWorkers.delete(threadId);
        this.threadResumeEvidence.delete(threadId);
        this.releaseEvidence.set(threadId, "worker-exited");
      }
    }
  }

  private onThreadClosed(worker: AppWorker, connection: AppServerConnection, threadId: string): void {
    if (this.nonforcingClose) return;
    if (worker.connection !== connection && worker.startingConnection !== connection) return;
    if (this.threadWorkers.get(threadId) === worker.index) this.threadWorkers.delete(threadId);
    this.threadResumeEvidence.delete(threadId);
    this.releaseEvidence.set(threadId, "thread-unloaded");
  }
}

class AppServerConnection {
  private readonly rpc: JsonRpcProcess;
  private readonly activeTurns = new Map<string, TurnContext>();
  private readonly threadTurns = new Map<string, string>();
  private readonly loadedThreads = new Set<string>();
  private readonly subscribedThreads = new Set<string>();
  private readonly threadPersistence = new Map<string, ThreadPersistence>();
  private readonly threadAccess = new Map<string, VerifiedExecutionAccess>();
  private readonly threadLineage = new Map<string, CodexThreadLineage>();
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly terminalTurns = new Set<string>();
  private readonly threadTokenTotals = new Map<string, TokenCounts>();
  private readonly threadLoadRevisions = new Map<string, number>();
  private readonly mcpStartupStates = new Map<string, "starting" | "ready" | "failed" | "cancelled">();
  private initializedAt?: number;
  private configWarningCount = 0;
  private closeRequested = false;
  private terminationRequested = false;
  private registeredWorkerIdentity?: JsonRpcProcessIdentity;
  private supervisionRelease: Promise<void> = Promise.resolve();
  private nonforcingClose?: Promise<ShutdownResult>;
  private nonforcingSettled=false;
  private nonforcingBinding?: WorkerShutdownBinding;
  private nonforcingTreePinned=false;
  private ordinaryCleanupStarted=false;
  private nonforcingHistoryUncertain=false;

  private constructor(
    command: string,
    private readonly workerId: string,
    private readonly generation: number,
    private readonly protocolOptions: ResolvedCodexAppServerProtocolOptions,
    private readonly onExitObserved: (observation: WorkerExitObservation) => void,
    private readonly onAccountRateLimitsUpdated: () => void,
    private readonly onThreadClosed: (threadId: string) => void
  ) {
    this.rpc = new JsonRpcProcess({
      command,
      args: ["app-server", "--listen", "stdio://", "-c", `features.${MCP_APPROVAL_ROUTING_FEATURE}=true`],
      ...(protocolOptions.environment ? { env: protocolOptions.environment } : {}),
      cwd: stableCodexWorkingDirectory(protocolOptions.environment),
      debugLabel: `codex-app:${workerId}:g${generation}`,
      omitJsonRpcHeader: true,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, requestId) => this.onServerRequest(method, params, requestId),
      onExit: (error) => this.onProcessExit(error),
      onLateResponse: (response) => {
        const appResponse = {
          ...response,
          workerId,
          workerGeneration: generation
        };
        this.reconcileLateProtocolState(appResponse);
        protocolOptions.onLateResponse?.(appResponse);
      }
    });
  }

  static spawn(
    command: string,
    workerId: string,
    generation: number,
    protocolOptions: ResolvedCodexAppServerProtocolOptions,
    onExitObserved: (observation: WorkerExitObservation) => void,
    onAccountRateLimitsUpdated: () => void,
    onThreadClosed: (threadId: string) => void
  ): AppServerConnection {
    return new AppServerConnection(
      command,
      workerId,
      generation,
      protocolOptions,
      onExitObserved,
      onAccountRateLimitsUpdated,
      onThreadClosed
    );
  }

  async initializeForAdmission(): Promise<AppServerConnection> {
    try {
      const identity = await this.rpc.start();
      this.registeredWorkerIdentity = identity;
      await this.protocolOptions.onWorkerProcessStarted?.(identity);
      await this.initialize();
      return this;
    } catch (error) {
      const identity = this.rpc.identity;
      const initializationError = appServerInitializationError(error, identity);
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [initializationError, cleanupError],
          `${initializationError.message} Worker cleanup also failed.`
        );
      }
      throw initializationError;
    }
  }

  get exited(): boolean {
    return this.rpc.exited;
  }

  get identity(): JsonRpcProcessIdentity | undefined {
    return this.rpc.identity;
  }

  waitForSupervisionRelease(): Promise<void> {
    return this.supervisionRelease;
  }

  get initializationHealth(): AppServerInitializationHealth {
    const statuses = [...this.mcpStartupStates.values()];
    return {
      protocol: this.initializedAt ? "ready" : "starting",
      config: this.initializedAt
        ? this.configWarningCount > 0 ? "warning" : "ready"
        : "starting",
      configWarningCount: this.configWarningCount,
      mcpServers: {
        observed: statuses.length,
        starting: statuses.filter((status) => status === "starting").length,
        ready: statuses.filter((status) => status === "ready").length,
        failed: statuses.filter((status) => status === "failed").length,
        cancelled: statuses.filter((status) => status === "cancelled").length,
        unobserved: statuses.length === 0
      }
    };
  }

  private reconcileLateProtocolState(response: CodexAppServerLateResponse): void {
    if (!lateResponseSucceeded(response)) return;
    const threadId = lateResponseThreadId(response);
    if (!threadId) return;
    const revision = response.lateResponseContext?.loadRevision;
    if (typeof revision === "number" && revision !== (this.threadLoadRevisions.get(threadId) || 0)) return;
    if (response.method === "thread/unsubscribe") {
      this.subscribedThreads.delete(threadId); this.threadAccess.delete(threadId);
      if (isRecord(response.response.result) && response.response.result.status === "notLoaded") {
        this.loadedThreads.delete(threadId); this.threadTokenTotals.delete(threadId); this.onThreadClosed(threadId);
      }
      return;
    }
    if (response.method === "thread/archive" || response.method === "thread/unarchive") {
      // Archive invalidates the materialized thread. Unarchive restores durable
      // persistence but still requires an explicit thread/resume on this worker.
      this.loadedThreads.delete(threadId);
      this.subscribedThreads.delete(threadId);
      this.threadAccess.delete(threadId);
      return;
    }
    if (
      response.method === "thread/start" ||
      response.method === "thread/fork" ||
      response.method === "thread/resume"
    ) {
      this.loadedThreads.add(threadId);
      this.subscribedThreads.add(threadId);
    }
  }

  async startThreadAndTurn(
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const expectedAccess = executionAccessRequest(args);
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/start",
      {
        ...threadAccessParams(expectedAccess, isRecord(args.config) ? args.config : undefined),
        model: optionalString(args.model) || null,
        serviceTier: optionalString(args.serviceTier) || null,
        experimentalRawEvents: false,
        ephemeral: args.ephemeral === true
      },
      { timeoutMs: this.protocolOptions.requestTimeoutMs }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    const threadId = requiredString(thread?.id, "thread/start thread.id");
    this.threadTokenTotals.set(threadId, Object.fromEntries(TOKEN_KEYS.map(key => [key, 0])));
    this.threadAccess.set(threadId, verifyExecutionAccess(response, expectedAccess, "thread/start"));
    const lineage = threadLineage(thread);
    this.loadedThreads.add(threadId);
    this.subscribedThreads.add(threadId);
    this.threadPersistence.set(threadId, thread?.ephemeral === true ? "ephemeral" : thread?.ephemeral === false ? "persistent" : "unknown");
    this.threadLineage.set(threadId, lineage);
    // Record the thread identity before turn/start. Durable threads can be
    // resumed after a worker exit; ephemeral threads remain correlated for
    // diagnostics but may become orphaned when their worker disappears.
    onAssigned?.(this.workerAssignment(threadId));
    return this.startTurn(
      threadId,
      requiredString(args.prompt, "prompt"),
      args,
      onProgress,
      onAssigned,
      lineage
    );
  }

  async resumeThreadAndTurn(
    threadId: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    if (this.threadTurns.has(threadId)) throw new Error("A Codex App Server turn is already active for this thread.");
    const probe = await this.probeThread(threadId);
    if (probe.state === "busy") throw new Error("THREAD_EXTERNALLY_ACTIVE: Wait for the current Codex turn before continuing here.");
    if (probe.state !== "resumable") throw new Error("THREAD_RESUME_UNCONFIRMED: Could not confirm that this conversation can safely resume.");
    let lineage: CodexThreadLineage;
    try { lineage = await this.ensureThreadLoaded(threadId, executionAccessRequest(args)); }
    catch (error) {
      if (/already has an active writer/i.test(String(error))) {
        throw new Error("THREAD_EXTERNALLY_OWNED: Codex or another application still owns this conversation. Release its connection there and retry this same conversation. No bridge turn was started.", {cause:error});
      }
      throw error;
    }
    return this.startTurn(
      threadId,
      requiredString(args.prompt, "prompt"),
      args,
      onProgress,
      onAssigned,
      lineage
    );
  }

  async forkThreadAndTurn(
    sourceThreadId: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void
  ): Promise<ToolResult> {
    const expectedAccess = executionAccessRequest(args);
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/fork",
      { threadId: sourceThreadId, ephemeral: args.ephemeral === true, ...threadAccessParams(expectedAccess) },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { sourceThreadId }
      }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    const threadId = requiredString(thread?.id, "thread/fork thread.id");
    this.threadAccess.set(threadId, verifyExecutionAccess(response, expectedAccess, "thread/fork"));
    const lineage = threadLineage(thread, sourceThreadId);
    this.loadedThreads.add(threadId);
    this.subscribedThreads.add(threadId);
    this.threadPersistence.set(threadId, thread?.ephemeral === true ? "ephemeral" : thread?.ephemeral === false ? "persistent" : "unknown");
    this.threadLineage.set(threadId, lineage);
    onAssigned?.(this.workerAssignment(threadId));
    return this.startTurn(
      threadId,
      requiredString(args.prompt, "prompt"),
      args,
      onProgress,
      onAssigned,
      lineage
    );
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.rpc.request(
      "thread/archive",
      { threadId },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    this.loadedThreads.delete(threadId);
  }

  async restoreThread(threadId: string): Promise<void> {
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/unarchive",
      { threadId },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    const restoredThread = isRecord(response.thread) ? response.thread : undefined;
    const restoredThreadId = typeof restoredThread?.id === "string" ? restoredThread.id : undefined;
    if (restoredThreadId && restoredThreadId !== threadId) {
      throw new Error("Codex App Server restored a different thread than requested.");
    }
    // Unarchive restores persistence but does not guarantee that this App
    // Server connection has materialized the thread. The next operation must
    // load it through thread/resume instead of trusting stale local state.
    this.loadedThreads.delete(threadId);
  }

  async listBackgroundTerminals(threadId: string): Promise<CodexBackgroundTerminal[]> {
    await this.ensureThreadLoaded(threadId);
    return this.listMaterializedBackgroundTerminals(threadId);
  }

  async listLoadedBackgroundTerminals(
    threadId: string
  ): Promise<CodexBackgroundTerminal[] | null> {
    if (!this.loadedThreads.has(threadId)) return null;
    return this.listMaterializedBackgroundTerminals(threadId);
  }

  async releaseSafety(threadId: string): Promise<{ safe: boolean; reason?: string }> {
    if (this.threadPersistence.get(threadId) !== "persistent") return { safe: false, reason: "persistence-unknown" };
    if (this.threadTurns.has(threadId) || [...this.pendingInteractions.values()].some(request => request.threadId === threadId)) {
      return { safe: false, reason: "active-work" };
    }
    const probe = await this.probeThread(threadId);
    if (probe.state !== "resumable") return { safe: false, reason: probe.state === "busy" ? "active-work" : "runtime-unknown" };
    if (probe.runtimeStatus === "notLoaded") return { safe: true };
    try {
      const terminals = await this.listLoadedBackgroundTerminals(threadId);
      return terminals === null ? { safe: false, reason: "background-unknown" }
        : terminals.length > 0 ? { safe: false, reason: "background-work" } : { safe: true };
    } catch { return { safe: false, reason: "background-unknown" }; }
  }

  async unsubscribeThread(threadId: string): Promise<"unsubscribed" | "notSubscribed" | "notLoaded"> {
    if (this.threadTurns.has(threadId) || [...this.pendingInteractions.values()].some(request => request.threadId === threadId)) {
      throw new Error("THREAD_ACTIVE: Cannot unsubscribe an active turn or pending interaction.");
    }
    // Dispatch can succeed even when its acknowledgement times out. Subsequent explicit use must resume.
    this.subscribedThreads.delete(threadId);
    this.threadAccess.delete(threadId);
    const response = await this.rpc.request<Record<string, unknown>>("thread/unsubscribe", { threadId },
      { timeoutMs: this.protocolOptions.requestTimeoutMs, lateResponseContext: { threadId, loadRevision: this.threadLoadRevisions.get(threadId) || 0 } });
    if (!["unsubscribed", "notSubscribed", "notLoaded"].includes(String(response.status))) throw new Error("Invalid thread unsubscribe acknowledgement.");
    this.subscribedThreads.delete(threadId);
    this.threadAccess.delete(threadId);
    return response.status as "unsubscribed" | "notSubscribed" | "notLoaded";
  }

  async listLoadedThreads(): Promise<string[]> {
    const threads: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const response: Record<string, unknown> = await this.rpc.request<Record<string, unknown>>("thread/loaded/list", { cursor, limit: 100 }, { timeoutMs: this.protocolOptions.requestTimeoutMs });
      if (!Array.isArray(response.data) || response.data.some(id => typeof id !== "string")) throw new Error("Invalid loaded thread list.");
      threads.push(...response.data as string[]);
      if (response.nextCursor === null || response.nextCursor === undefined) return threads;
      if (typeof response.nextCursor !== "string" || seen.has(response.nextCursor)) throw new Error("Invalid loaded thread cursor.");
      const nextCursor: string = response.nextCursor;
      cursor = nextCursor; seen.add(nextCursor);
    }
    throw new Error("Loaded thread inspection exceeded its safe bound.");
  }

  private async listMaterializedBackgroundTerminals(
    threadId: string
  ): Promise<CodexBackgroundTerminal[]> {
    const terminals: CodexBackgroundTerminal[] = [];
    let cursor: string | null = null;
    do {
      const response: Record<string, unknown> = await this.rpc.request<Record<string, unknown>>(
        "thread/backgroundTerminals/list",
        { threadId, cursor, limit: 100 },
        { timeoutMs: this.protocolOptions.requestTimeoutMs }
      );
      if (!Array.isArray(response.data)) {
        throw new Error("Codex App Server returned an invalid background terminal list.");
      }
      for (const raw of response.data) {
        if (!isRecord(raw)) throw new Error("Codex App Server returned an invalid background terminal.");
        terminals.push({
          processId: requiredString(raw.processId, "background terminal processId"),
          itemId: requiredString(raw.itemId, "background terminal itemId"),
          command: requiredString(raw.command, "background terminal command"),
          cwd: requiredString(raw.cwd, "background terminal cwd"),
          ...(typeof raw.osPid === "number" ? { osPid: raw.osPid } : {}),
          ...(typeof raw.cpuPercent === "number" ? { cpuPercent: raw.cpuPercent } : {}),
          ...(typeof raw.rssKb === "number" ? { rssKb: raw.rssKb } : {})
        });
      }
      cursor = optionalString(response.nextCursor) || null;
    } while (cursor);
    return terminals;
  }

  async terminateBackgroundTerminal(
    threadId: string,
    processId: string
  ): Promise<{ terminated: boolean }> {
    await this.ensureThreadLoaded(threadId);
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/backgroundTerminals/terminate",
      { threadId, processId },
      { timeoutMs: this.protocolOptions.requestTimeoutMs }
    );
    if (typeof response.terminated !== "boolean") {
      throw new Error("Codex App Server returned an invalid background terminal termination result.");
    }
    return { terminated: response.terminated };
  }

  async probeThread(threadId: string): Promise<CodexThreadResumeProbe> {
    try {
      const response = await this.rpc.request<Record<string, unknown>>(
        "thread/read",
        { threadId, includeTurns: false },
        {
          timeoutMs: this.protocolOptions.requestTimeoutMs,
          lateResponseContext: { threadId }
        }
      );
      const thread = isRecord(response.thread) ? response.thread : undefined;
      if (!thread || thread.id !== threadId || !isRecord(thread.status)) {
        return { state: "unknown", reason: "unsupported", threadId, retryable: true };
      }
      const runtimeStatus = thread.status.type;
      if (runtimeStatus === "notLoaded" || runtimeStatus === "idle") {
        return { state: "resumable", runtimeStatus, threadId, ...threadLineage(thread) };
      }
      if (runtimeStatus === "active") {
        return { state: "busy", runtimeStatus, threadId, retryable: true, ...threadLineage(thread) };
      }
      if (runtimeStatus === "systemError") {
        return { state: "orphaned", reason: "system-error", threadId, retryable: false };
      }
      return { state: "unknown", reason: "unsupported", threadId, retryable: true };
    } catch (error) {
      if (isMissingThreadError(error)) {
        return { state: "orphaned", reason: "missing", threadId, retryable: false };
      }
      if (isUnsupportedThreadReadError(error)) {
        return { state: "unknown", reason: "unsupported", threadId, retryable: true };
      }
      return { state: "unknown", reason: "transient", threadId, retryable: true };
    }
  }

  private async ensureThreadLoaded(threadId: string, expectedAccess?: ExecutionAccessRequest): Promise<CodexThreadLineage> {
    const verified = this.threadAccess.get(threadId);
    if (this.loadedThreads.has(threadId) && this.subscribedThreads.has(threadId) && (!expectedAccess || verified)) {
      if (expectedAccess && verified) {
        verifyExecutionAccess({ ...verified, sandbox: verified.sandboxPolicy }, expectedAccess, "loaded thread");
      }
      return this.threadLineage.get(threadId) || {};
    }
    const loadRevision = (this.threadLoadRevisions.get(threadId) || 0) + 1;
    this.threadLoadRevisions.set(threadId, loadRevision);
    // An external app may have added turns. A previous local counter is not this turn's baseline.
    this.threadTokenTotals.delete(threadId);
    const response = await this.rpc.request<Record<string, unknown>>(
      "thread/resume",
      { threadId, ...(expectedAccess ? threadAccessParams(expectedAccess) : {}) },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId, loadRevision }
      }
    );
    const thread = isRecord(response.thread) ? response.thread : undefined;
    if (!thread || thread.id !== threadId) {
      throw new Error("Codex App Server resumed a different thread than requested.");
    }
    if (expectedAccess) this.threadAccess.set(threadId, verifyExecutionAccess(response, expectedAccess, "thread/resume"));
    const lineage = threadLineage(thread);
    this.loadedThreads.add(threadId);
    this.subscribedThreads.add(threadId);
    this.threadPersistence.set(threadId, thread.ephemeral === false ? "persistent" : thread.ephemeral === true ? "ephemeral" : "unknown");
    this.threadLineage.set(threadId, lineage);
    return lineage;
  }

  async listModels(): Promise<unknown> {
    const data: unknown[] = [];
    let cursor: string | null = null;
    do {
      const response: Record<string, unknown> = await this.rpc.request<Record<string, unknown>>(
        "model/list",
        { cursor, limit: 100, includeHidden: false },
        { timeoutMs: this.protocolOptions.requestTimeoutMs }
      );
      if (!Array.isArray(response.data)) {
        throw new Error("Codex App Server returned an invalid model/list response.");
      }
      data.push(...response.data);
      cursor = optionalString(response.nextCursor) || null;
    } while (cursor);
    return { data, nextCursor: null };
  }

  async readAccount() { return this.rpc.request("account/read", { refreshToken: false }, { timeoutMs: this.protocolOptions.requestTimeoutMs }); }

  async readConfiguration() {
    return this.rpc.request("config/read", { includeLayers: false }, { timeoutMs: this.protocolOptions.requestTimeoutMs });
  }

  async readConfigurationRequirements() {
    return this.rpc.request("configRequirements/read", {}, { timeoutMs: this.protocolOptions.requestTimeoutMs });
  }

  async logoutAccount() {
    return this.rpc.request("account/logout", {}, { timeoutMs: this.protocolOptions.requestTimeoutMs });
  }

  async readAccountRateLimits(): Promise<Record<string, unknown>> {
    return this.rpc.request<Record<string, unknown>>(
      "account/rateLimits/read",
      undefined,
      { timeoutMs: this.protocolOptions.requestTimeoutMs }
    );
  }

  async steerThread(threadId: string, prompt: string): Promise<{ turnId: string }> {
    const turnId = this.threadTurns.get(threadId);
    if (!turnId) throw new Error("The requested Codex thread has no active turn to steer.");
    const result = await this.rpc.request<Record<string, unknown>>(
      "turn/steer",
      {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: prompt, text_elements: [] }]
      },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId, turnId }
      }
    );
    return { turnId: requiredString(result.turnId, "turn/steer turnId") };
  }

  hasActiveTurn(threadId: string): boolean {
    return this.threadTurns.has(threadId);
  }

  hasExactTurn(threadId: string, turnId: string): boolean {
    return this.threadTurns.get(threadId) === turnId;
  }

  interactionInput(interactionId: string): CodexInteractionInput | undefined {
    const pending = this.pendingInteractions.get(interactionId);
    return pending && !pending.answered ? structuredClone(pending.privateInput) : undefined;
  }

  respondToInteraction(
    interactionId: string,
    response: CodexInteractionResponse
  ): boolean {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending) return false;
    if (pending.answered) throw new Error("This Codex interaction response was already submitted.");
    if (pending.kind === "mcp-elicitation") {
      const result = elicitationResponse(pending.privateInput || {}, response);
      pending.answered = true;
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      pending.resolve(result);
    } else if (pending.kind === "user-input") {
      if (!response.answers) throw new Error("User-input interaction requires answers.");
      const questions = pending.questions || [];
      if (JSON.stringify(Object.keys(response.answers).sort()) !== JSON.stringify(questions.map(q => q.id).sort())) {
        throw new Error("Answers must match the exact pending question ids.");
      }
      for (const question of questions) {
        const answers = response.answers[question.id];
        if (!Array.isArray(answers) || answers.some(answer => typeof answer !== "string") ||
            (question.options?.length && question.isOther === false && answers.some(answer => !question.options!.some(option => option.label === answer)))) {
          throw new Error("Answer is not available for this Codex question.");
        }
      }
      pending.answered = true;
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      pending.resolve({
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([key, answers]) => [key, { answers }])
        )
      });
    } else {
      if (!response.decision) throw new Error("Approval interaction requires a decision.");
      if (
        pending.availableDecisions &&
        !pending.availableDecisions.includes(response.decision)
      ) {
        throw new Error("The selected decision is not available for this Codex approval request.");
      }
      pending.answered = true;
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      if (pending.kind === "permission-approval") {
        const requested = isRecord(pending.requestParams.permissions)
          ? pending.requestParams.permissions
          : {};
        pending.resolve({
          permissions:
            response.decision === "accept" || response.decision === "acceptForSession"
              ? grantedPermissions(requested)
              : {},
          scope: response.decision === "acceptForSession" ? "session" : "turn"
        });
      } else {
        pending.resolve({ decision: response.decision || "decline" });
      }
    }
    return true;
  }

  async interruptOrTerminate(
    assignment: UpstreamWorkerAssignment,
    correlation: WorkerTerminationCorrelation,
    graceMs = 1_500,
    options?: { interruptOnly: true }
  ): Promise<JsonRpcTerminationResult> {
    if (this.nonforcingClose) throw new Error("Codex App Server upstream is closed.");
    assertWorkerTerminationCorrelation(correlation);
    const identity = this.rpc.identity;
    if (!identity) throw new Error("App Server worker process identity is unavailable.");
    if (
      (assignment.workerPid !== undefined && assignment.workerPid !== identity.pid) ||
      (assignment.processGroupId !== undefined && assignment.processGroupId !== identity.processGroupId)
    ) {
      throw new Error("The selected App Server process identity changed; refresh status before force-stopping it.");
    }
    const turnId = assignment.upstreamRequestId;
    const context = turnId ? this.activeTurns.get(turnId) : undefined;
    if (turnId && this.terminalTurns.has(turnId)) {
      // Completion can win the race while its receipt is still crossing the
      // control link. That is never permission to kill other turns on this worker.
      return { ...identity, exited: true, escalated: false, signal: null,
        mode: "already-completed", workerExited: false };
    }
    if (turnId && !context) {
      const code = options?.interruptOnly ? "PRECISE_INTERRUPTION_UNCONFIRMED" : "TURN_OWNERSHIP_UNCONFIRMED";
      throw new Error(`${code}: The exact turn is not active on this worker; no process termination was authorized.`);
    }
    if (turnId && context) {
      try {
        this.emit(context, {
          eventId: `turn-interrupt:${turnId}:${correlation.kind}`,
          type: "turn",
          phase: "updated",
          createdAt: Date.now(),
          summary: "A correlated bridge interruption was dispatched.",
          details: correlation.kind === "cancellation-intent"
            ? {
                evidence: "bridge-turn-interrupt",
                cause: correlation.kind,
                cancellationIntentId: correlation.intentId,
                cancellationRequestId: correlation.requestId,
                cancellationSource: correlation.source,
                reasonCode: correlation.reasonCode
              }
            : {
                evidence: "bridge-turn-interrupt",
                cause: correlation.kind,
                correlationId: correlation.correlationId,
                reasonCode: correlation.reasonCode
              }
        });
        await this.rpc.request(
          "turn/interrupt",
          { threadId: context.threadId, turnId },
          {
            timeoutMs: this.protocolOptions.interruptTimeoutMs,
            lateResponseContext: { threadId: context.threadId, turnId }
          }
        );
        const confirmed = await Promise.race([
          context.done.then(() => true, () => true),
          delay(this.protocolOptions.interruptTimeoutMs).then(() => false)
        ]);
        if (confirmed || this.terminalTurns.has(turnId)) {
          return {
            ...identity,
            exited: true,
            escalated: false,
            signal: null,
            mode: "turn-interrupt",
            workerExited: false
          };
        }
      } catch {
        // One UI action automatically falls back to supervised process-group termination.
      }
    }
    if (options?.interruptOnly) {
      throw new Error("PRECISE_INTERRUPTION_UNCONFIRMED: The original turn could not be confirmed stopped; shared worker termination was not authorized.");
    }
    if (this.nonforcingClose) throw new Error("Codex App Server upstream is closed.");
    this.terminationRequested = true;
    const result = await this.rpc.forceTerminate(graceMs);
    if (result.workerExited) await this.waitForSupervisionRelease();
    return result;
  }

  closeNonforcing(policy: ShutdownPolicy & {allowSigkillEscalation:false}): Promise<ShutdownResult> {
    const pinned=snapshotShutdownPolicy(policy);
    if (pinned.allowSigkillEscalation!==false) throw new Error("NONFORCING_SHUTDOWN_POLICY_REQUIRED");
    if (this.nonforcingClose) return this.nonforcingClose;
    this.nonforcingHistoryUncertain=this.nonforcingHistoryUncertain || this.closeRequested || this.terminationRequested || this.ordinaryCleanupStarted;
    this.closeRequested=true;
    let resolve!: (result:ShutdownResult)=>void;
    this.nonforcingClose=new Promise(done=>{resolve=done;});
    const identity=this.rpc.identity;
    this.nonforcingBinding=snapshotWorkerShutdownBinding({ownerId:this.protocolOptions.shutdownOwnerId,
      workerId:this.workerId,workerGeneration:this.generation,pid:identity?.pid,processGroupId:identity?.processGroupId});
    const binding=this.nonforcingBinding, supervisor=this.protocolOptions.workerShutdownSupervisor;
    if (binding && supervisor) {
      try { this.nonforcingTreePinned=supervisor.pinNonforcingShutdown(binding)===true; } catch { /* no fence evidence */ }
    }
    const deadline=pinned.graceMs*2+6000;
    const transport=this.rpc.close({...pinned,allowSigkillEscalation:false});
    this.rejectClosingInteractions();
    const tree=boundedShutdown(async()=> {
      if (!binding || !supervisor || !this.nonforcingTreePinned) return shutdownResult("uncertain");
      return workerShutdownResult(await supervisor.closeNonforcing(binding),binding);
    },deadline);
    void Promise.all([boundedShutdown(()=>transport,deadline),tree]).then(results=> {
      this.nonforcingSettled=true;
      resolve(combineShutdown([...results,...(this.nonforcingHistoryUncertain ? [shutdownResult("uncertain")] : [])]));
    },()=>{this.nonforcingSettled=true;resolve(shutdownResult("uncertain"));});
    return this.nonforcingClose;
  }

  async observeNonforcingExit(): Promise<ShutdownResult> {
    if (!this.nonforcingSettled || !this.nonforcingTreePinned || this.nonforcingHistoryUncertain) return shutdownResult("uncertain");
    const binding=this.nonforcingBinding,supervisor=this.protocolOptions.workerShutdownSupervisor;
    const results=await Promise.all([observeShutdown(this.rpc), boundedShutdown(async()=> {
      if (!binding || !supervisor) return shutdownResult("uncertain");
      return workerShutdownResult(await supervisor.observeNonforcingExit(binding),binding);
    })]);
    return combineShutdown([...results,...(this.nonforcingHistoryUncertain ? [shutdownResult("uncertain")] : [])]);
  }

  private rejectClosingInteractions(): void {
    for (const pending of this.pendingInteractions.values()) {
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      pending.reject(new Error("Codex App Server closed before the interaction was answered."));
    }
    this.pendingInteractions.clear();
  }

  async close(): Promise<void> {
    if (this.nonforcingClose) {
      if (!(await this.nonforcingClose).exited) throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
      return;
    }
    this.closeRequested = true;
    this.rejectClosingInteractions();
    await this.rpc.close();
    await this.waitForSupervisionRelease();
  }

  private async initialize(): Promise<void> {
    const result = await this.rpc.request(
      "initialize",
      {
        clientInfo: APP_SERVER_CLIENT_INFO,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: REASONING_NOTIFICATIONS
        }
      },
      { timeoutMs: this.protocolOptions.initializeTimeoutMs }
    );
    validateInitializeResponse(result);
    await this.rpc.notify("initialized");
    this.initializedAt = Date.now();
  }

  private async startTurn(
    threadId: string,
    prompt: string,
    args: Record<string, unknown>,
    onProgress?: (progress: CodexProgress) => void,
    onAssigned?: (assignment: UpstreamWorkerAssignment) => void,
    lineage: CodexThreadLineage = this.threadLineage.get(threadId) || {}
  ): Promise<ToolResult> {
    if (this.threadTurns.has(threadId)) throw new Error("A Codex App Server turn is already active for this thread.");
    const executionAccess = this.threadAccess.get(threadId);
    if (!executionAccess) throw new Error("EXECUTION_ACCESS_REQUIRED: The thread policy has not been verified.");
    const inputRoutingVerified = await this.verifyInputRouting(threadId);
    const usage = new TurnUsageMeter(this.threadTokenTotals.get(threadId));
    const response = await this.rpc.request<Record<string, unknown>>(
      "turn/start",
      {
        threadId,
        ...turnAccessParams(executionAccess),
        input: [
          { type: "text", text: prompt, text_elements: [] }
        ],
        model: optionalString(args.model) || null,
        effort: modelReasoningEffort(args.config) || null,
        serviceTier: optionalString(args.serviceTier) || null
      },
      {
        timeoutMs: this.protocolOptions.requestTimeoutMs,
        lateResponseContext: { threadId }
      }
    );
    const turn = isRecord(response.turn) ? response.turn : undefined;
    const turnId = requiredString(turn?.id, "turn/start turn.id");
    let resolve!: (result: ToolResult) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<ToolResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const context: TurnContext = {
      usage,
      threadId,
      turnId,
      lineage,
      executionAccess,
      onProgress,
      resolve,
      reject,
      done,
      eventSequence: 0,
      finalMessage: "",
      commandOutputTails: new Map(),
      lastAgentMessageEventAt: 0,
      inputOrigins: new Map(),
      inputRoutingVerified
    };
    this.activeTurns.set(turnId, context);
    this.threadTurns.set(threadId, turnId);
    const assignment = this.workerAssignment(threadId, turnId);
    try {
      onAssigned?.(assignment);
    } catch (error) {
      const containmentCorrelation = {
        kind: "assignment-containment" as const,
        correlationId: randomUUID(),
        reasonCode: "assignment-persistence-failed" as const
      };
      try {
        // Keep the TurnContext and per-thread lock until terminal evidence is
        // observed. interruptOrTerminate waits for turn/completed and falls
        // back to terminating the worker process when confirmation is absent.
        await this.interruptOrTerminate(assignment, containmentCorrelation);
      } catch {
        // A missing process identity is the only expected helper failure. Make
        // one direct containment attempt while preserving the originating
        // assignment-persistence error for the caller.
        try {
          this.terminationRequested = true;
          await this.rpc.forceTerminate();
        } catch {
          // The retained TurnContext/thread lock still prevents overlapping work.
        }
      }
      throw error;
    }
    this.emit(context, {
      eventId: `turn:${turnId}`,
      type: "turn",
      phase: "started",
      createdAt: Date.now(),
      summary: "Codex turn started.",
      details: {
        threadId,
        turnId,
        executionAccess: executionAccessEvidence(executionAccess),
        questionRouting: inputRoutingVerified ? "verified-mcp-elicitation" : "unverified",
        selection: {
          model: optionalString(args.model) || null,
          reasoningEffort: modelReasoningEffort(args.config) || null,
          serviceTier: optionalString(args.serviceTier) || null
        },
        evidence: "turn/start-accepted"
      }
    });
    return done;
  }

  private async verifyInputRouting(threadId: string): Promise<boolean> {
    let cursor: string | null = null;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < 4; page++) {
        const result: Record<string, unknown> = await this.rpc.request<Record<string, unknown>>("experimentalFeature/list", { threadId, cursor, limit: 100 },
          { timeoutMs: Math.min(this.protocolOptions.requestTimeoutMs, 1500) });
        if (!Array.isArray(result.data)) return false;
        const feature = result.data.find((item: unknown) => isRecord(item) && item.name === MCP_APPROVAL_ROUTING_FEATURE);
        if (isRecord(feature)) return feature.enabled === true && feature.stage === "stable";
        const nextCursor: unknown = result.nextCursor;
        if (typeof nextCursor !== "string" || seen.has(nextCursor)) return false;
        cursor = nextCursor; seen.add(nextCursor);
      }
    } catch { /* Older/unsupported peers keep the approval path closed to GPT. */ }
    return false;
  }

  private workerAssignment(
    threadId: string,
    upstreamRequestId?: string
  ): UpstreamWorkerAssignment {
    const identity = this.rpc.identity;
    const lineage = this.threadLineage.get(threadId);
    return {
      backendKind: "app-server",
      workerId: this.workerId,
      workerGeneration: this.generation,
      ...(identity ? { workerPid: identity.pid } : {}),
      ...(identity?.processGroupId !== null && identity?.processGroupId !== undefined
        ? { processGroupId: identity.processGroupId }
        : {}),
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
      threadId,
      threadPersistence: this.threadPersistence.get(threadId) || "unknown",
      ...(lineage?.sessionId ? { sessionId: lineage.sessionId } : {}),
      ...(lineage?.forkedFromThreadId
        ? { forkedFromThreadId: lineage.forkedFromThreadId }
        : {})
    };
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "account/rateLimits/updated") {
      this.onAccountRateLimitsUpdated();
      return;
    }
    if (!isRecord(params)) return;
    if (method === "thread/closed" || method === "thread/status/changed" && isRecord(params.status) && params.status.type === "notLoaded") {
      const id = optionalString(params.threadId);
      if (id && !this.threadTurns.has(id)) {
        this.loadedThreads.delete(id); this.subscribedThreads.delete(id); this.threadAccess.delete(id);
        this.threadTokenTotals.delete(id);
        this.onThreadClosed(id);
      }
    }
    if (method === "configWarning") this.configWarningCount += 1;
    if (method === "mcpServer/startupStatus/updated") {
      const name = optionalString(params.name)?.slice(0, 200);
      const status = params.status;
      if (
        name &&
        (status === "starting" || status === "ready" || status === "failed" || status === "cancelled")
      ) {
        this.mcpStartupStates.set(name, status);
      }
    }
    if (method === "serverRequest/resolved") {
      this.resolvePendingServerRequest(params, "server-resolved");
      return;
    }
    if (REASONING_NOTIFICATIONS.includes(method)) return;
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId) ||
      (isRecord(params.turn) ? optionalString(params.turn.id) : undefined) ||
      (threadId ? this.threadTurns.get(threadId) : undefined);
    const context = turnId ? this.activeTurns.get(turnId) : undefined;
    const protocolEvent = publicNotificationEvent(method, params);
    if (method === "thread/tokenUsage/updated" && threadId && isRecord(params.tokenUsage)) {
      const total = tokenCounts(params.tokenUsage.total);
      if (context && protocolEvent) protocolEvent.details = { ...protocolEvent.details, jobUsage: context.usage.observe(total) };
      if (total) this.threadTokenTotals.set(threadId, total);
    }
    if (!context && protocolEvent && isGlobalProtocolNotice(method)) {
      for (const active of this.activeTurns.values()) {
        const globalEvent = publicNotificationEvent(method, params);
        if (globalEvent) this.emit(active, globalEvent);
      }
      return;
    }
    if (!context) return;
    if (protocolEvent) {
      this.emit(context, protocolEvent);
      return;
    }
    if (method === "turn/completed") {
      this.completeTurn(context, params);
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = rawString(params.delta);
      if (delta) {
        context.finalMessage = boundedAppend(context.finalMessage, delta, 100_000);
        const now = Date.now();
        if (now - context.lastAgentMessageEventAt >= 500) {
          context.lastAgentMessageEventAt = now;
          this.emit(
            context,
            event(
              "agent-message",
              "updated",
              tail(context.finalMessage, 1_000),
              { itemId: optionalString(params.itemId) || null }
            )
          );
        }
      }
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      const itemId = optionalString(params.itemId);
      const delta = rawString(params.delta);
      if (itemId && delta) {
        context.commandOutputTails.set(itemId, tail(boundedAppend(context.commandOutputTails.get(itemId) || "", delta, 16_384), 8_192));
      }
      return;
    }
    if (method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan)
        ? params.plan.filter(isRecord).slice(0, 30).map((step) => ({
            step: optionalString(step.step)?.slice(0, 500) || "",
            status: optionalString(step.status) || "unknown"
          }))
        : [];
      this.emit(context, event("plan", "updated", `Plan updated (${plan.length} steps).`, { plan }));
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = isRecord(params.item) ? params.item : undefined;
      if (!item || item.type === "reasoning") return;
      if (typeof item.id === "string") {
        // Client-provided dynamic tools never establish native question origin.
        context.inputOrigins.set(item.id, item.type === "mcpToolCall" ? "app-approval" : "unknown");
        if (context.inputOrigins.size > 200) context.inputOrigins.delete(context.inputOrigins.keys().next().value!);
      }
      const publicEvent = publicItemEvent(item, method === "item/started" ? "started" : "completed", context);
      if (publicEvent) this.emit(context, publicEvent);
    }
  }

  private resolvePendingServerRequest(
    params: Record<string, unknown>,
    resolution: "server-resolved" | "expired"
  ): void {
    const requestId = params.requestId;
    const threadId = optionalString(params.threadId);
    if ((typeof requestId !== "string" && typeof requestId !== "number") || !threadId) return;
    const match = [...this.pendingInteractions.entries()].find(([, pending]) =>
      String(pending.requestId) === String(requestId) && pending.threadId === threadId
    );
    if (!match) return;
    const [interactionId, pending] = match;
    this.pendingInteractions.delete(interactionId);
    if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
    if (!pending.answered) pending.reject(new JsonRpcServerRequestResolved());
    const context = this.activeTurns.get(pending.turnId);
    if (!context) return;
    const summary = resolution === "expired"
      ? `${pending.kind} expired before a response was submitted.`
      : `${pending.kind} was resolved by the App Server.`;
    this.emit(
      context,
      event(
        isInputInteraction(pending.kind) ? "input-required" : "approval-required",
        "completed",
        summary,
        { resolvedInteractionId: interactionId, resolution }
      )
    );
  }

  private onServerRequest(method: string, params: unknown, requestId: number | string): Promise<unknown> {
    if (!isRecord(params)) throw new Error(`Invalid App Server request payload for ${method}.`);
    const kind = method === "item/commandExecution/requestApproval"
      ? "command-approval"
      : method === "item/fileChange/requestApproval"
        ? "file-approval"
        : method === "item/permissions/requestApproval"
          ? "permission-approval"
          : method === "item/tool/requestUserInput"
            ? "user-input"
            : method === "mcpServer/elicitation/request"
              ? "mcp-elicitation"
              : undefined;
    if (!kind) throw Object.assign(new Error(`Unsupported App Server request: ${method}.`), { code: -32601 });
    const threadId = requiredString(params.threadId, "interaction threadId");
    const turnId = optionalString(params.turnId) || (kind === "mcp-elicitation" ? this.threadTurns.get(threadId) : undefined);
    if (!turnId && kind === "mcp-elicitation") return Promise.resolve({ action: "cancel", content: null });
    if (!turnId) throw new Error("App Server interaction is missing its turn id.");
    const itemId = kind === "mcp-elicitation" ? String(requestId) : requiredString(params.itemId, "interaction itemId");
    const context = this.activeTurns.get(turnId);
    if (!context || context.threadId !== threadId) throw new Error("App Server requested input for an unknown turn.");
    let privateInput: CodexInteractionInput | undefined;
    if (kind === "mcp-elicitation") {
      try { privateInput = readElicitationInput(params); }
      catch {
        this.emit(context, event("warning", "completed", "The MCP server requested an unsupported or invalid elicitation form. The request was cancelled without submitting data."));
        return Promise.resolve({ action: "cancel", content: null });
      }
    }
    const interactionId = `${this.workerId}:${this.generation}:${String(requestId)}`;
    const questions = kind === "user-input" && Array.isArray(params.questions)
      ? params.questions.filter(isRecord).slice(0, MAX_CODEX_INTERACTION_QUESTIONS).map((question) => ({
          id: requiredString(question.id, "question id"),
          header: optionalString(question.header)?.slice(0, 80) || "Input",
          question: optionalString(question.question)?.slice(0, 1_000) || "",
          isSecret: question.isSecret === true,
          ...(typeof question.isOther === "boolean" ? { isOther: question.isOther } : {}),
          options: Array.isArray(question.options)
            ? question.options.filter(isRecord).slice(0, 10).map((option) => ({
                label: optionalString(option.label)?.slice(0, 120) || "",
                description: optionalString(option.description)?.slice(0, 300) || ""
              }))
            : undefined
        }))
      : undefined;
    const summary = kind === "command-approval"
      ? `Command approval required: ${(optionalString(params.command) || "command").slice(0, 500)}${
          optionalString(params.reason) ? ` — ${optionalString(params.reason)!.slice(0, 300)}` : ""
        }`
      : kind === "file-approval"
        ? `File-change approval required.${
            optionalString(params.reason) ? ` ${optionalString(params.reason)!.slice(0, 300)}` : ""
          }`
        : kind === "permission-approval"
          ? `Additional permission approval required: ${(optionalString(params.reason) || "Codex requested additional access.").slice(0, 500)}`
          : kind === "mcp-elicitation"
            ? `MCP input requested by ${requiredString(params.serverName, "MCP serverName")}: ${(optionalString(params.message) || "Input required.").slice(0, 1_000)}`
            : "Codex requires user input.";
    const reason = optionalString(params.reason)?.slice(0, 500);
    const cwdLabel = safePathLabel(params.cwd);
    const grantRootLabel = safePathLabel(params.grantRoot);
    const availableDecisions = interactionDecisions(kind, params);
    const autoResolutionMs = kind === "user-input" ? undefined : readAutoResolutionMs(params.autoResolutionMs);
    const expiresAt = typeof autoResolutionMs === "number"
      ? Date.now() + autoResolutionMs
      : autoResolutionMs === null
        ? null
        : undefined;
    const networkContext = readNetworkContext(params.networkApprovalContext);
    const commandActions = readCommandActions(params.commandActions);
    const proposedAmendments = readProposedAmendments(params);
    const requestedPermissions = readRequestedPermissions(
      kind === "command-approval" ? params.additionalPermissions : params.permissions
    );
    const interaction: CodexPendingInteraction = {
      ...(kind === "user-input" ? { origin: questionOrigin(context.inputRoutingVerified, context.inputOrigins.get(itemId), (questions || []).map(q => q.id)) } : {}),
      interactionId,
      kind,
      threadId,
      turnId,
      itemId,
      summary,
      isBlocking: kind === "user-input" ? params.isBlocking !== false : true,
      ...(kind === "mcp-elicitation" ? { elicitation: {
        mode: params.mode as "form" | "url", serverName: requiredString(params.serverName, "MCP serverName")
      } } : {}),
      ...(reason ? { reason } : {}),
      ...(cwdLabel ? { cwdLabel } : {}),
      ...(grantRootLabel ? { grantRootLabel } : {}),
      ...(availableDecisions ? { availableDecisions } : {}),
      ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(networkContext ? { networkContext } : {}),
      ...(commandActions ? { commandActions } : {}),
      ...(proposedAmendments ? { proposedAmendments } : {}),
      ...(requestedPermissions ? { requestedPermissions } : {}),
      ...(questions ? { questions } : {})
    };
    let resolveInteraction!: (result: unknown) => void;
    let rejectInteraction!: (error: Error) => void;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      resolveInteraction = resolve;
      rejectInteraction = reject;
    });
    const pending: PendingInteraction = {
      ...interaction,
      requestId,
      method,
      requestParams: params,
      ...(privateInput ? { privateInput } : {}),
      resolve: resolveInteraction,
      reject: rejectInteraction,
      answered: false
    };
    if (typeof autoResolutionMs === "number") {
      pending.autoResolutionTimer = setTimeout(() => {
        this.resolvePendingServerRequest(
          { requestId, threadId },
          "expired"
        );
      }, autoResolutionMs);
      pending.autoResolutionTimer.unref?.();
    }
    this.pendingInteractions.set(interactionId, pending);
    try {
      this.emit(
        context,
        event(
          isInputInteraction(kind) ? "input-required" : "approval-required",
          interaction.isBlocking === false ? "updated" : "waiting",
          summary,
          { interaction }
        )
      );
    } catch (error) {
      this.pendingInteractions.delete(interactionId);
      if (pending.autoResolutionTimer) clearTimeout(pending.autoResolutionTimer);
      rejectInteraction(error instanceof Error ? error : new Error(String(error)));
    }
    return responsePromise;
  }

  private completeTurn(context: TurnContext, params: Record<string, unknown>): void {
    const turn = isRecord(params.turn) ? params.turn : {};
    const status = optionalString(turn.status) || "failed";
    if (!context.finalMessage && Array.isArray(turn.items)) {
      for (const item of turn.items.filter(isRecord)) {
        if (item.type === "agentMessage" && typeof item.text === "string") context.finalMessage = item.text;
      }
    }
    this.emit(context, event("turn", "completed", `Codex turn ${status}.`, { status }));
    this.activeTurns.delete(context.turnId);
    this.threadTurns.delete(context.threadId);
    this.terminalTurns.add(context.turnId);
    if (this.terminalTurns.size > 200) this.terminalTurns.delete(this.terminalTurns.values().next().value as string);
    for (const [interactionId, interaction] of this.pendingInteractions) {
      if (interaction.turnId !== context.turnId) continue;
      if (interaction.autoResolutionTimer) clearTimeout(interaction.autoResolutionTimer);
      interaction.reject(new Error("Codex turn ended before the pending interaction was answered."));
      this.pendingInteractions.delete(interactionId);
    }
    const errorMessage = isRecord(turn.error)
      ? optionalString(turn.error.message) || JSON.stringify(turn.error).slice(0, 1_000)
      : undefined;
    const failure = status === "failed" ? classifyTurnFailure(turn.error, errorMessage) : undefined;
    context.resolve({
      ...(status === "failed" ? { isError: true } : {}),
      content: [
        {
          type: "text",
          text: context.finalMessage || errorMessage || `Codex turn ${status}.`
        }
      ],
      structuredContent: {
        threadId: context.threadId,
        turnId: context.turnId,
        turnStatus: status,
        backendKind: "app-server",
        ...context.lineage,
        executionAccess: executionAccessEvidence(context.executionAccess),
        ...(failure ? { error: failure } : {})
      }
    });
  }

  private onProcessExit(error: Error): void {
    const registeredIdentity = this.registeredWorkerIdentity;
    const ownedIdentity=registeredIdentity ?? this.rpc.identity;
    if (ownedIdentity) {
      try { this.protocolOptions.onWorkerProcessExitObserved?.(ownedIdentity); }
      catch { this.nonforcingHistoryUncertain=true; }
    }
    if (registeredIdentity && !this.nonforcingClose) {
      const release = Promise.resolve()
        .then(() => {
          if (this.nonforcingClose) return;
          this.ordinaryCleanupStarted=true;
          return this.protocolOptions.onWorkerProcessExited?.(registeredIdentity);
        })
        .then(() => {
          if (!this.nonforcingClose && this.registeredWorkerIdentity === registeredIdentity) {
            this.registeredWorkerIdentity = undefined;
          }
        });
      this.supervisionRelease = release;
      // The pool also holds this promise as its replacement fence. Attach a
      // handler here so a failed independent cleanup never becomes an
      // unhandled rejection while the executor transitions to fail-closed.
      void release.catch(() => undefined);
    }
    const expected = this.closeRequested || this.terminationRequested;
    const terminalError = expected
      ? error
      : new Error("CODEX_WORKER_LOST: The Codex App Server worker exited during an active turn.");
    for (const interaction of this.pendingInteractions.values()) {
      if (interaction.autoResolutionTimer) clearTimeout(interaction.autoResolutionTimer);
      interaction.reject(terminalError);
    }
    this.pendingInteractions.clear();
    for (const context of this.activeTurns.values()) context.reject(terminalError);
    this.activeTurns.clear();
    this.threadTurns.clear();
    this.onExitObserved({
      generation: this.generation,
      expected
    });
  }

  private emit(context: TurnContext, publicEvent: CodexPublicEvent): void {
    context.eventSequence += 1;
    context.onProgress?.({
      progress: context.eventSequence,
      message: publicEvent.summary.slice(0, 500),
      event: publicEvent
    });
  }
}

export const APP_SERVER_CAPABILITIES: BackendCapabilities = {
  selectionScope: "turn",
  supportsModelOverrideOnContinue: true,
  supportsEffortOverrideOnContinue: true,
  supportsServiceTierOverrideOnContinue: true,
  supportsFork: true,
  supportsSteering: true, supportsPreciseCancellation: true, supportsEphemeralThreads: true,
  supportsThreadInspection: true, supportsBackgroundTerminals: true
};

function metricAggregate(values: number[]): {
  samples: number;
  total: number | null;
  average: number | null;
  max: number | null;
} {
  if (values.length === 0) return { samples: 0, total: null, average: null, max: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    total,
    average: Math.round(total / values.length),
    max: Math.max(...values)
  };
}

function latestWorkerValue(
  workers: AppWorker[],
  key: "lastCrashAt"
): number | null {
  const values = workers.flatMap((worker) => worker[key] === undefined ? [] : [worker[key] as number]);
  return values.length > 0 ? Math.max(...values) : null;
}

function latestStartupLatency(workers: AppWorker[]): number | null {
  const latest = workers
    .filter((worker) => worker.lastStartupAt !== undefined && worker.lastStartupLatencyMs !== undefined)
    .sort((left, right) => (right.lastStartupAt as number) - (left.lastStartupAt as number))[0];
  return latest?.lastStartupLatencyMs ?? null;
}

function aggregateInitializationHealth(
  workers: AppServerInitializationHealth[]
): Record<string, unknown> {
  return {
    protocol: {
      ready: workers.filter((worker) => worker.protocol === "ready").length,
      starting: workers.filter((worker) => worker.protocol === "starting").length
    },
    config: {
      ready: workers.filter((worker) => worker.config === "ready").length,
      warning: workers.filter((worker) => worker.config === "warning").length,
      starting: workers.filter((worker) => worker.config === "starting").length,
      warningCount: workers.reduce((total, worker) => total + worker.configWarningCount, 0)
    },
    mcpServers: {
      observed: workers.reduce((total, worker) => total + worker.mcpServers.observed, 0),
      starting: workers.reduce((total, worker) => total + worker.mcpServers.starting, 0),
      ready: workers.reduce((total, worker) => total + worker.mcpServers.ready, 0),
      failed: workers.reduce((total, worker) => total + worker.mcpServers.failed, 0),
      cancelled: workers.reduce((total, worker) => total + worker.mcpServers.cancelled, 0),
      unobservedWorkers: workers.filter((worker) => worker.mcpServers.unobserved).length
    }
  };
}

async function defaultWorkerMetricsProbe(pid: number): Promise<WorkerProcessMetrics> {
  const rss = readWorkerRssKb(pid);
  const fds = readWorkerFdCount(pid);
  const [rssResult, fdResult] = await Promise.allSettled([rss, fds]);
  const metrics: WorkerProcessMetrics = {
    ...(rssResult.status === "fulfilled" ? { rssKb: rssResult.value } : {}),
    ...(fdResult.status === "fulfilled" ? { fdCount: fdResult.value } : {})
  };
  if (metrics.rssKb === undefined && metrics.fdCount === undefined) {
    throw new Error("Worker process metrics are unavailable on this platform.");
  }
  return metrics;
}

async function readWorkerRssKb(pid: number): Promise<number> {
  if (process.platform === "win32") throw new Error("RSS probing is unavailable on Windows.");
  const output = await execFileText("ps", ["-o", "rss=", "-p", String(pid)]);
  const value = Number.parseInt(output.trim(), 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid worker RSS sample.");
  return value;
}

async function readWorkerFdCount(pid: number): Promise<number> {
  if (process.platform === "linux") {
    return (await readdir(`/proc/${pid}/fd`)).length;
  }
  if (process.platform === "win32") throw new Error("FD probing is unavailable on Windows.");
  const output = await execFileText("lsof", ["-a", "-p", String(pid), "-Fn"]);
  return output.split(/\r?\n/).filter((line) => /^f\d/.test(line)).length;
}

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

function resolveProtocolOptions(
  options: CodexAppServerProtocolOptions
): ResolvedCodexAppServerProtocolOptions {
  const requestTimeoutMs = positiveTimeout(
    options.requestTimeoutMs ?? DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs"
  );
  return {
    ...(options.environment ? { environment: options.environment } : {}),
    versionCheckTimeoutMs: positiveTimeout(
      options.versionCheckTimeoutMs ?? DEFAULT_CODEX_VERSION_CHECK_TIMEOUT_MS,
      "versionCheckTimeoutMs"
    ),
    requestTimeoutMs,
    initializeTimeoutMs: positiveTimeout(
      options.initializeTimeoutMs ?? requestTimeoutMs,
      "initializeTimeoutMs"
    ),
    interruptTimeoutMs: positiveTimeout(
      options.interruptTimeoutMs ?? DEFAULT_APP_SERVER_INTERRUPT_TIMEOUT_MS,
      "interruptTimeoutMs"
    ),
    ...(options.onLateResponse ? { onLateResponse: options.onLateResponse } : {}),
    ...(options.onWorkerProcessStarted
      ? { onWorkerProcessStarted: options.onWorkerProcessStarted }
      : {}),
    ...(options.onWorkerProcessExited
      ? { onWorkerProcessExited: options.onWorkerProcessExited }
      : {}),
    ...(options.onWorkerProcessExitObserved ? {onWorkerProcessExitObserved:options.onWorkerProcessExitObserved} : {}),
    workerShutdownSupervisor: snapshotWorkerShutdownSupervisor(options.workerShutdownSupervisor)
  };
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_JSON_RPC_TIMEOUT_MS) {
    throw new Error(
      `Codex App Server ${label} must be an integer between 1 and ${MAX_JSON_RPC_TIMEOUT_MS}ms.`
    );
  }
  return value;
}

function appServerInitializationError(
  error: unknown,
  processIdentity: JsonRpcProcessIdentity | undefined
): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const metadata = isRecord(error)
    ? Object.fromEntries(
        ["code", "data", "requestId", "method", "timeoutMs"].flatMap((key) =>
          error[key] === undefined ? [] : [[key, error[key]]]
        )
      )
    : {};
  return Object.assign(
    new Error(`Codex App Server initialization failed: ${cause.message}`, { cause }),
    metadata,
    processIdentity ? { processIdentity } : {}
  );
}

function requestArguments(
  prompt: string,
  selection: ModelSelection | undefined,
  base: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...base,
    prompt,
    ...(selection
      ? {
          model: selection.model,
          config: { model_reasoning_effort: selection.reasoningEffort },
          ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {})
        }
      : {})
  };
}

function threadLineage(
  thread: Record<string, unknown> | undefined,
  fallbackForkedFromThreadId?: string
): CodexThreadLineage {
  const sessionId = optionalString(thread?.sessionId)?.slice(0, 200);
  const forkedFromThreadId = (
    optionalString(thread?.forkedFromId) ||
    // Accept the early fixture/preview spelling while the supported official
    // protocol remains forkedFromId.
    optionalString(thread?.forkedFromThreadId) ||
    fallbackForkedFromThreadId
  )?.slice(0, 200);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(forkedFromThreadId ? { forkedFromThreadId } : {})
  };
}

function classifyTurnFailure(
  value: unknown,
  fallbackMessage?: string
): {
  code: string;
  message: string;
  retryable: boolean;
  upstreamKind: string;
  nextActions: string[];
} {
  const error = isRecord(value) ? value : {};
  const info = error.codexErrorInfo;
  const upstreamKind = typeof info === "string"
    ? info
    : isRecord(info)
      ? Object.keys(info)[0] || "other"
      : "other";
  const message = (
    optionalString(error.message) ||
    fallbackMessage ||
    "Codex App Server reported a failed turn."
  ).slice(0, 1_000);
  if (upstreamKind === "contextWindowExceeded") {
    return {
      code: "CONTEXT_WINDOW_EXCEEDED",
      message,
      retryable: true,
      upstreamKind,
      nextActions: [
        "Retry with a smaller task or less attached context.",
        "Start context='fresh' and provide an explicit concise handoffSummary; prior transcript context is not copied.",
        "If policy permits, explicitly select a model with a larger context window. The bridge will not downgrade or reroute silently."
      ]
    };
  }
  const transient = new Set([
    "serverOverloaded",
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
    "internalServerError"
  ]).has(upstreamKind);
  return {
    code: transient ? "UPSTREAM_TEMPORARILY_UNAVAILABLE" : "UPSTREAM_TURN_FAILED",
    message,
    retryable: transient,
    upstreamKind,
    nextActions: transient
      ? ["Retry the same idempotent request after upstream service recovery."]
      : ["Inspect the public error metadata, correct the request or credentials, and retry with a new requestId."]
  };
}

function publicNotificationEvent(
  method: string,
  params: Record<string, unknown>
): CodexPublicEvent | undefined {
  if (method === "error") {
    const error = isRecord(params.error) ? params.error : undefined;
    const message = optionalString(error?.message)?.slice(0, 1_000) || "Codex reported a turn error.";
    return event("error", "updated", message, {
      willRetry: params.willRetry === true,
      hasAdditionalDetails: Boolean(optionalString(error?.additionalDetails))
    });
  }
  if (method === "warning" || method === "guardianWarning") {
    return event(
      "warning",
      "updated",
      (optionalString(params.message) || "Codex reported a warning.").slice(0, 1_000),
      { source: method }
    );
  }
  if (method === "configWarning" || method === "deprecationNotice") {
    const summary = (optionalString(params.summary) || "Codex reported a configuration notice.").slice(0, 1_000);
    return event("warning", "updated", summary, {
      source: method,
      details: optionalString(params.details)?.slice(0, 1_000) || null,
      ...(method === "configWarning" && params.path ? { pathLabel: safePathLabel(params.path) || null } : {})
    });
  }
  if (method === "model/rerouted") {
    const fromModel = optionalString(params.fromModel)?.slice(0, 120) || "unknown";
    const toModel = optionalString(params.toModel)?.slice(0, 120) || "unknown";
    const reason = optionalString(params.reason)?.slice(0, 200) || "unspecified";
    return event("model", "updated", `Model rerouted from ${fromModel} to ${toModel}.`, {
      kind: "rerouted",
      fromModel,
      toModel,
      reason
    });
  }
  if (method === "model/verification") {
    const verifications = Array.isArray(params.verifications)
      ? params.verifications
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 20)
          .map((entry) => entry.slice(0, 200))
      : [];
    return event("model", "updated", "Model verification state changed.", {
      kind: "verification",
      verifications
    });
  }
  if (method === "model/safetyBuffering/updated") {
    const model = optionalString(params.model)?.slice(0, 120) || "unknown";
    return event("model", "updated", `Safety buffering state changed for ${model}.`, {
      kind: "safety-buffering",
      model,
      showBufferingUi: params.showBufferingUi === true,
      fasterModel: optionalString(params.fasterModel)?.slice(0, 120) || null,
      useCases: boundedStringArray(params.useCases, 20, 200),
      reasons: boundedStringArray(params.reasons, 20, 300)
    });
  }
  if (method === "thread/compacted") {
    return event("context", "completed", "Codex compacted the thread context.", {
      kind: "compaction"
    });
  }
  if (method === "item/mcpToolCall/progress") {
    return event(
      "mcp",
      "updated",
      "MCP tool call progressed.",
      { itemId: optionalString(params.itemId)?.slice(0, 200) || null }
    );
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
    return event("usage", "updated", "Codex token usage updated.", {
      total: readTokenUsageBreakdown(usage.total),
      last: readTokenUsageBreakdown(usage.last),
      modelContextWindow:
        typeof usage.modelContextWindow === "number" && Number.isFinite(usage.modelContextWindow)
          ? Math.max(0, Math.trunc(usage.modelContextWindow))
          : null
    });
  }
  return undefined;
}

function isGlobalProtocolNotice(method: string): boolean {
  return method === "warning" || method === "configWarning" || method === "deprecationNotice";
}

function boundedStringArray(value: unknown, maxItems: number, maxChars: number): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, maxItems)
        .map((entry) => entry.slice(0, maxChars))
    : [];
}

function readTokenUsageBreakdown(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const keys = [
    "totalTokens",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens"
  ];
  const entries = keys.flatMap((key) =>
    typeof value[key] === "number" && Number.isFinite(value[key])
      ? [[key, Math.max(0, Math.trunc(value[key]))] as const]
      : []
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function publicItemEvent(
  item: Record<string, unknown>,
  phase: "started" | "completed",
  context: TurnContext
): CodexPublicEvent | undefined {
  const itemId = optionalString(item.id) || randomUUID();
  if (item.type === "agentMessage") {
    const text = optionalString(item.text);
    if (text) context.finalMessage = text;
    return event("agent-message", phase, text?.slice(0, 1_000) || `Agent message ${phase}.`, { itemId });
  }
  if (item.type === "plan") {
    return event("plan", phase, (optionalString(item.text) || `Plan ${phase}.`).slice(0, 1_000), { itemId });
  }
  if (item.type === "commandExecution") {
    return event(
      "command",
      phase,
      `Command ${phase}: ${(optionalString(item.command) || "command").slice(0, 500)}`,
      {
        itemId,
        status: optionalString(item.status) || null,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
        durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
        outputTail: phase === "completed" ? context.commandOutputTails.get(itemId) || null : null
      }
    );
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? item.changes.filter(isRecord).slice(0, 100).map((change) => ({
          path: optionalString(change.path)?.slice(0, 500) || "",
          kind: optionalString(change.kind) || "unknown"
        }))
      : [];
    return event("file-change", phase, `File changes ${phase} (${changes.length}).`, { itemId, changes });
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const server = item.type === "mcpToolCall"
      ? optionalString(item.server)?.slice(0, 120) || "MCP"
      : optionalString(item.namespace)?.slice(0, 120) || "dynamic";
    const tool = optionalString(item.tool)?.slice(0, 160) || "tool";
    const errorMessage = isRecord(item.error)
      ? optionalString(item.error.message)?.slice(0, 1_000) || null
      : null;
    return event("mcp", phase, `${server}.${tool} ${phase}.`, {
      itemId,
      server,
      tool,
      status: optionalString(item.status)?.slice(0, 80) || null,
      durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
      error: errorMessage
    });
  }
  if (item.type === "collabAgentToolCall") {
    const tool = optionalString(item.tool)?.slice(0, 80) || "collaboration";
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 30)
          .map((entry) => entry.slice(0, 200))
      : [];
    return event("collaboration", phase, `Collaboration ${tool} ${phase}.`, {
      itemId,
      tool,
      status: optionalString(item.status)?.slice(0, 80) || null,
      receiverThreadIds: receivers,
      model: optionalString(item.model)?.slice(0, 120) || null,
      reasoningEffort: optionalString(item.reasoningEffort)?.slice(0, 80) || null
    });
  }
  if (item.type === "subAgentActivity") {
    return event("collaboration", phase, `Sub-agent activity ${phase}.`, {
      itemId,
      kind: optionalString(item.kind)?.slice(0, 120) || "unknown",
      agentThreadId: optionalString(item.agentThreadId)?.slice(0, 200) || null
    });
  }
  if (item.type === "contextCompaction") {
    return event("context", phase, `Context compaction ${phase}.`, { itemId });
  }
  return undefined;
}

function event(
  type: CodexPublicEvent["type"],
  phase: CodexPublicEvent["phase"],
  summary: string,
  details?: Record<string, unknown>
): CodexPublicEvent {
  return { eventId: randomUUID(), type, phase, createdAt: Date.now(), summary, ...(details ? { details } : {}) };
}

function structuredString(result: ToolResult, key: string): string | undefined {
  return isRecord(result.structuredContent) ? optionalString(result.structuredContent[key]) : undefined;
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`Missing ${label}.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function lateResponseSucceeded(response: CodexAppServerLateResponse): boolean {
  return !isRecord(response.response.error) &&
    Object.prototype.hasOwnProperty.call(response.response, "result");
}

function lateResponseThreadId(response: CodexAppServerLateResponse): string | undefined {
  const context = response.lateResponseContext;
  const contextualThreadId = safeLateIdentifier(context?.threadId);
  const result = isRecord(response.response.result) ? response.response.result : undefined;
  const returnedThread = result && isRecord(result.thread) ? result.thread : undefined;
  const returnedThreadId = safeLateIdentifier(returnedThread?.id);

  if (response.method === "thread/start" || response.method === "thread/fork") {
    return returnedThreadId;
  }
  if (response.method === "thread/resume" || response.method === "thread/unarchive") {
    if (returnedThreadId && contextualThreadId && returnedThreadId !== contextualThreadId) return undefined;
    return returnedThreadId || contextualThreadId;
  }
  if (
    response.method === "thread/archive" ||
    response.method === "thread/unsubscribe" ||
    response.method === "turn/start" ||
    response.method === "turn/steer" ||
    response.method === "turn/interrupt"
  ) {
    return contextualThreadId;
  }
  return undefined;
}

function safeLateIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function interactionDecisions(
  kind: CodexPendingInteraction["kind"],
  params: Record<string, unknown>
): CodexInteractionDecision[] | undefined {
  if (isInputInteraction(kind)) return undefined;
  if (kind === "command-approval" && Array.isArray(params.availableDecisions)) {
    return [...new Set(params.availableDecisions.filter(isInteractionDecision))];
  }
  return ["accept", "acceptForSession", "decline", "cancel"];
}

function isInteractionDecision(value: unknown): value is CodexInteractionDecision {
  return value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel";
}

function readAutoResolutionMs(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_JSON_RPC_TIMEOUT_MS
    ? value
    : undefined;
}

function safePathLabel(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const label = path.basename(raw).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (label || path.parse(raw).root || "filesystem root").slice(0, 200);
}

function readNetworkContext(
  value: unknown
): CodexPendingInteraction["networkContext"] | undefined {
  if (!isRecord(value)) return undefined;
  const host = optionalString(value.host)?.slice(0, 253);
  const protocol = value.protocol;
  if (
    !host ||
    (protocol !== "http" &&
      protocol !== "https" &&
      protocol !== "socks5Tcp" &&
      protocol !== "socks5Udp")
  ) {
    return undefined;
  }
  return { host, protocol };
}

function readCommandActions(
  value: unknown
): CodexPendingInteraction["commandActions"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.filter(isRecord).slice(0, 20).flatMap((action) => {
    const type = action.type;
    if (type !== "read" && type !== "listFiles" && type !== "search" && type !== "unknown") {
      return [];
    }
    const command = optionalString(action.command)?.slice(0, 500);
    if (!command) return [];
    const pathLabel = safePathLabel(action.path);
    const name = optionalString(action.name)?.slice(0, 120);
    const query = optionalString(action.query)?.slice(0, 300);
    return [{
      type,
      command,
      ...(name ? { name } : {}),
      ...(pathLabel ? { pathLabel } : {}),
      ...(query ? { query } : {})
    }];
  });
  return actions.length > 0 ? actions : undefined;
}

function readProposedAmendments(
  params: Record<string, unknown>
): CodexPendingInteraction["proposedAmendments"] | undefined {
  const execPolicy = Array.isArray(params.proposedExecpolicyAmendment)
    ? params.proposedExecpolicyAmendment
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 30)
        .map((entry) => entry.slice(0, 300))
    : undefined;
  const networkPolicy = Array.isArray(params.proposedNetworkPolicyAmendments)
    ? params.proposedNetworkPolicyAmendments.filter(isRecord).slice(0, 20).flatMap((entry) => {
        const host = optionalString(entry.host)?.slice(0, 253);
        const action = entry.action;
        return host && (action === "allow" || action === "deny") ? [{ host, action }] : [];
      })
    : undefined;
  return execPolicy?.length || networkPolicy?.length
    ? {
        ...(execPolicy?.length ? { execPolicy } : {}),
        ...(networkPolicy?.length ? { networkPolicy } : {})
      }
    : undefined;
}

function readRequestedPermissions(
  value: unknown
): CodexPendingInteraction["requestedPermissions"] | undefined {
  if (!isRecord(value)) return undefined;
  const network = isRecord(value.network) ? value.network : undefined;
  const fileSystem = isRecord(value.fileSystem) ? value.fileSystem : undefined;
  const filesystemRead = Array.isArray(fileSystem?.read)
    ? fileSystem.read.map(safePathLabel).filter((entry): entry is string => Boolean(entry)).slice(0, 50)
    : undefined;
  const filesystemWrite = Array.isArray(fileSystem?.write)
    ? fileSystem.write.map(safePathLabel).filter((entry): entry is string => Boolean(entry)).slice(0, 50)
    : undefined;
  const networkEnabled = network?.enabled;
  const filesystemEntries = Array.isArray(fileSystem?.entries)
    ? Math.min(fileSystem.entries.length, 1_000)
    : undefined;
  if (
    networkEnabled !== true &&
    networkEnabled !== false &&
    networkEnabled !== null &&
    filesystemRead === undefined &&
    filesystemWrite === undefined &&
    filesystemEntries === undefined
  ) {
    return undefined;
  }
  return {
    ...(networkEnabled === true || networkEnabled === false || networkEnabled === null
      ? { networkEnabled }
      : {}),
    ...(filesystemRead !== undefined ? { filesystemRead } : {}),
    ...(filesystemWrite !== undefined ? { filesystemWrite } : {}),
    ...(filesystemEntries !== undefined ? { filesystemEntries } : {})
  };
}

function isMissingThreadError(error: unknown): boolean {
  if (!isRecord(error) || error.code !== -32000) return false;
  const message = typeof error.message === "string" ? error.message : "";
  return /\bthread\b.*\b(?:not found|missing|archived)\b/i.test(message);
}

function isUnsupportedThreadReadError(error: unknown): boolean {
  return isRecord(error) && error.code === -32601;
}

function rawString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function modelReasoningEffort(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.model_reasoning_effort) : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

export function parseCodexWeeklyUsage(
  response: unknown,
  observedAt = Date.now()
): CodexWeeklyUsage | null {
  if (!isRecord(response)) return null;
  const byLimitId = isRecord(response.rateLimitsByLimitId)
    ? response.rateLimitsByLimitId
    : undefined;
  const mappedCodex = byLimitId && isRecord(byLimitId.codex)
    ? byLimitId.codex
    : undefined;
  const legacyCodex = isRecord(response.rateLimits) &&
    (response.rateLimits.limitId === undefined || response.rateLimits.limitId === "codex")
    ? response.rateLimits
    : undefined;
  const bucket = mappedCodex || legacyCodex;
  if (!bucket) return null;

  const weeklyWindow = [bucket.primary, bucket.secondary]
    .find((candidate) =>
      isRecord(candidate) && candidate.windowDurationMins === CODEX_WEEKLY_WINDOW_MINUTES
    );
  if (
    !isRecord(weeklyWindow) ||
    typeof weeklyWindow.usedPercent !== "number" ||
    !Number.isFinite(weeklyWindow.usedPercent)
  ) {
    return null;
  }

  const usedPercent = Math.min(100, Math.max(0, weeklyWindow.usedPercent));
  const resetsAt = typeof weeklyWindow.resetsAt === "number" &&
    Number.isFinite(weeklyWindow.resetsAt) && weeklyWindow.resetsAt >= 0
    ? Math.trunc(weeklyWindow.resetsAt)
    : null;
  return {
    limitId: typeof bucket.limitId === "string" && bucket.limitId
      ? bucket.limitId
      : "codex",
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowDurationMins: CODEX_WEEKLY_WINDOW_MINUTES,
    resetsAt,
    observedAt
  };
}

function boundedAppend(current: string, delta: string, max: number): string {
  const combined = current + delta;
  return combined.length <= max ? combined : combined.slice(combined.length - max);
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function grantedPermissions(requested: Record<string, unknown>): Record<string, unknown> {
  const granted: Record<string, unknown> = {};
  if (isRecord(requested.network)) granted.network = requested.network;
  if (isRecord(requested.fileSystem)) granted.fileSystem = requested.fileSystem;
  return granted;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInputInteraction(kind: CodexPendingInteraction["kind"]): boolean {
  return kind === "user-input" || kind === "mcp-elicitation";
}
