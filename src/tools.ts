import {CallToolResultSchema} from "@modelcontextprotocol/core";
import {combineShutdown, shutdownResult, type ShutdownResult} from "./shutdown.js";
import {snapshotNonforcingData} from "./nonforcingData.js";
import { withExecutionIdentity } from "./executionIdentity.js";
import { dashboardHistoryActionInput, ISSUE_ATTENTION_DAYS, type HistoryRetentionDays, type DashboardHistoryActionInput } from "./workHistory.js";
import { DASHBOARD_STATUS_FILTERS, dashboardSummaryCategory, type DashboardStatusFilter } from "./dashboardPresentation.js";
import { problemActionSchema, problemActionResultSchema, problemQuerySchema, problemOperationSchema,
  problemKey, problemRevision, problemOperationDigest, problemReviewProofs,
  type ProblemQuery, type ProblemAction, type ProblemOperation, type ProblemActionResult } from "./problemReview.js";
import { AutomaticRecoveryController, automaticRecoveryKey,
  type AutomaticRecoveryCandidate, type AutomaticRecoveryResult } from "./automaticRecovery.js";
import { projectRecoveryGuidance, projectSelectorRetryAction, type RequestedProjectIdentity } from "./projectGuidance.js";
import { modelPolicyRecoveryActions } from "./toolGuidance.js";
import {
  guidance,
  modelNextActionOutputSchema,
  nextActionSummary,
  projectModelNextAction,
  settingsAction,
  statusAction
} from "./nextActions.js";
import { DisplayReadPool, waitForDisplay } from "./displayReadPool.js";
import type { CodexAccountSnapshot } from "./codexAccount.js";
import { uiControlProofs, type UiControlClaims } from "./uiControlProofs.js";
import {
  nativeCompletionNotification,
  type NativeCompletionNotification
} from "./completionDelivery.js";
import { createHash, randomUUID } from "node:crypto";
import { authenticatedMcpPrincipal } from "./mcpEvents.js";
import { approvedFollowupDigests, issueApprovedFollowups, readFollowupReference, FOLLOWUP_ID_PATTERN, promptDigest, type ApprovedFollowup, type FollowupReference } from "./taskFollowups.js";
import { ThreadConnectionController, type ThreadConnectionRecord } from "./threadConnections.js";
import { STATE_MAINTENANCE_SLICES, StateMaintenanceScheduler } from "./maintenanceScheduler.js";
import {
  InProcessOperationalStateService,
  executeOperationalStateCommand,
  type OperationalJobRetentionCommand,
  type OperationalStateCommand,
  type OperationalStateOperationObservation,
  type OperationalStateResult
} from "./stateService.js";
import { classifyMemoryOnlyThreadImpact } from "./runtimeAdmission.js";
import type { BridgeTelemetryService } from "./telemetryService.js";
import { codexInputCursor, codexInputSnapshot, isCodexInputEvent, ordinaryCodexQuestion } from "./codexInputs.js";
import { ScopeFairQueue, type ScopeFairQueueStatus } from "./scopeFairQueue.js";
import { registerCodexInputTools, CODEX_INPUT_MODEL_OUTPUT_SCHEMAS } from "./questionTools.js";
import { InteractionNotDispatchedError } from "./interactionDispatch.js";
import path from "node:path";
import * as z from "zod/v4";
import { type McpServer, type Progress, type ToolCallback } from "@modelcontextprotocol/server";
import {
  ACTIVITY_COMPLETION_TRIGGERS,
  ACTIVITY_HANDOFF_POLICIES,
  ACTIVITY_JOB_STATUSES,
  ACTIVITY_KINDS,
  ACTIVITY_LIFECYCLES,
  isActiveActivityJobStatus,
  isTerminalActivityJobStatus,
  type ActivityCompletionTrigger,
  type ActivityHandoffPolicy,
  type ActivityKind,
  type ActivityVerificationEvidence,
  type BridgeActivity
} from "./activity.js";
import {
  AGENT_CONTEXT_MODES,
  canonicalAgentName,
  type ActivityAgentAssignment,
  type AgentContextMode,
  type BridgeAgent,
  type BridgeAgentThread
} from "./agent.js";
import type {
  AccessStrategy,
  BridgeConfig,
  CodexBackendKind,
  SandboxMode
} from "./config.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { resolveExecutionPolicy, resolveTaskSandbox } from "./executionPolicy.js";
import { executionAccessArguments } from "./executionAccess.js";
import {
  HARD_MAX_CONCURRENT_JOBS,
  formatSensitiveFileFindings,
  isCodexBackendKind,
  findSensitiveFiles,
  isPathWithinRoot,
  resolveAllowedCwd
} from "./config.js";
import {
  modelCatalogAdmissionFingerprint,
  modelQuestionCapabilities,
  type CodexModelCatalogProvider,
  type CodexModelCatalogSnapshot,
  type CodexModelDescriptor
} from "./modelCatalog.js";
import {
  MODEL_POLICY_SCHEMA_VERSION,
  backendSupports,
  ModelPolicyError,
  ULTRA_DISABLED_NO_SELECTION_WARNING,
  isModelPolicySuspended,
  listAllowedModelSelections,
  modelChoiceKey,
  modelSelectionKey,
  resolveModelPolicy,
  sameModelPolicy,
  sameModelSelection,
  validateModelSelection,
  validateModelPolicy,
  validatePolicyAgainstCatalog,
  type BackendCapabilities,
  type ExecutionDecision,
  type ModelChoice,
  type ModelPolicy,
  type ModelSelection
} from "./modelPolicy.js";
import type { TrackedCodexSession } from "./sessionRegistry.js";
import {
  extractThreadId,
  LEGACY_SCOPE_ID,
  SCOPE_ID_PATTERN,
  SessionRegistry
} from "./sessionRegistry.js";
import {
  registerSettingsCardResource,
  SETTINGS_CARD_HTML,
  SETTINGS_CARD_HTML_MAX_BYTES,
  SETTINGS_CARD_CONTRACT_GENERATION,
  SETTINGS_CARD_URI
} from "./settingsCard.js";
import {
  DASHBOARD_CARD_CONTRACT_GENERATION,
  DASHBOARD_CARD_URI,
  DASHBOARD_PRIVATE_METADATA_CONTRACT_VERSION,
  DASHBOARD_VIEW_METADATA_KEY,
  DASHBOARD_CARD_HTML,
  DASHBOARD_CARD_HTML_MAX_BYTES,
  shouldShowDashboardNextExecution,
  registerDashboardCardResource
} from "./dashboardCard.js";
import type { ScopeResolver, ToolCallMetadata } from "./scopeResolver.js";
import {
  BridgeStateStore,
  canonicalActivityTitle,
  type ActivityProjectAdmission,
  type BeginSteeringDeliveryInput,
  type CreateActivityInput,
  type DashboardRetainedJobSummary,
  type SteeringDeliveryRecord
} from "./stateStore.js";
import {
  MAX_REGISTERED_PROJECTS,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_CONTEXT_CONFLICT,
  PROJECT_REGISTRY_CHANGED,
  PROJECT_SETUP_REQUIRED,
  PROJECT_UNAVAILABLE,
  normalizeProjectId,
  normalizeProjectName,
  normalizeProjectRef,
  projectNameKey,
  type ProjectSelection,
  type RuntimeProjectSelection,
  type ProjectTarget
} from "./projectRegistry.js";
import {
  MAX_CODEX_INTERACTION_QUESTIONS,
  type CodexPendingInteraction,
  type CodexInteractionDecision,
  type CodexInteractionResponse,
  type CodexInteractionInput,
  type CodexProgress,
  type CodexPublicEvent,
  type CodexThreadResumeProbe,
  type CodexUpstream,
  type CodexWeeklyUsage,
  type ToolResult,
  type UpstreamWorkerAssignment
} from "./upstream.js";
import { backendRoutingArgument } from "./upstreamRouter.js";
import {
  type BridgeUserSettings,
  type BridgeUserSettingsPatch,
  type ProjectRegistryOperation,
  UserSettingsStore
} from "./userSettings.js";
import {
  UI_LOCALE_PREFERENCES,
  missingReasoningEffortTranslations,
  resolvePreferredUiLocale,
  uiTranslation,
  type UiLocalePreference
} from "./uiI18n.js";
import { localizeSettingsView } from "./settingsLocalization.js";
import {
  assertJsonTextIntegrity,
  decodeUtf8Strict,
  hasAtMostUnicodeScalars,
  parseJsonUtf8Strict,
  verbatimText
} from "./textIntegrity.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  CANCELLATION_REASON_MAX_LENGTH,
  JOB_TERMINAL_ORIGINS,
  cancellationTerminationCorrelation,
  type BeginCancellationOperationInput,
  type CancellationIntentRecord,
  type CancellationOperationRecord,
  type CreateCancellationIntentInput,
  type JobTerminalOrigin
} from "./cancellation.js";
import { assertRuntimeEnvOutsideProjectRoots } from "./runtimeEnvProjectGuard.js";
import {
  MAX_MODEL_DESCRIPTION_LENGTH,
  modelDescriptionProjection,
  type ModelDescriptionHistoryPage,
  type ModelDescriptionOverrides
} from "./modelDescriptions.js";
import {
  TOOL_CONTENT_BYTE_CAPS,
  TOOL_STRUCTURED_BYTE_CAPS,
  boundedUtf8JsonString,
  defineToolResultContract,
  projectToolResult,
  type AuthoritativeProjectionChannel,
  type ToolResultContract
} from "./toolResultContracts.js";
import {
  BRIDGE_SKILL_LIMITS,
  BRIDGE_SKILL_SOURCE,
  SkillLibrary,
  type BridgeSkill,
  type CreateBridgeSkillInput,
  type CreateBridgeSkillPackageInput,
  type DeleteBridgeSkillInput,
  type DeletedBridgeSkill,
  type SkillFile,
  type SkillReference,
  type SkillSearchResult,
  type SkillSummary,
  type SkillVersionList,
  type RestoreBridgeSkillInput,
  type SetBridgeSkillEnabledInput,
  type UpdateBridgeSkillInput,
  type UpdateBridgeSkillPackageInput
} from "./skillLibrary.js";

type CodexJobStatus =
  | "running"
  | "terminating"
  | "termination-failed"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
type CodexJobOperation = "start" | "continue";
type SessionMode = "auto" | "new" | "continue";
type CodexJobWaitMode = "change" | "terminal";

export const MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES = 24 * 1024;
/** Complete serialized codex_task descriptor ceiling at maximum bounded choices. */
export const CODEX_TASK_DESCRIPTOR_MAX_JSON_BYTES = 128 * 1024;
/** Stable task envelope adopted once; settings/catalog/project values stay runtime-authoritative. */
/** v6 exposes one durable asynchronous admission contract. */
export const CODEX_TASK_INPUT_CONTRACT_VERSION = "6" as const;
const MODEL_PRIMARY_ANSWER_TRUNCATION_WARNING =
  "The model-authoritative primary answer was truncated by the structured-output byte limit. Request a narrower report only if the missing sections are required.";

type ForceTerminateOptions = {
  interruptOnly?: true;
  acknowledgeAffectedJobIds?: string[];
  /** Durable intents for every job the caller explicitly intended to stop. */
  requestedTargetIntents?: CancellationIntentRecord[];
};

type JobCompletionCallback = (result: ToolResult, job: CodexJob) => void | (() => void);

class JobTerminalCommitError extends Error {
  constructor(cause: unknown) {
    // The original cause can contain accessors or a Proxy. Retain it without
    // formatting it, including when a completion callback has just pinned.
    super("BRIDGE_TERMINAL_COMMIT_FAILED: terminal state remains unconfirmed", { cause });
    this.name = "JobTerminalCommitError";
  }
}

type DeferredJobSettlement =
  | { kind: "resolved"; result: ToolResult; onComplete?: JobCompletionCallback }
  | { kind: "rejected"; error: unknown };

type StableProjectAvailability = {
  projectRevision: number;
  available: boolean;
};

/**
 * Shared HTTP-runtime projection of externally mutable project availability.
 * Registry revisions take effect immediately; filesystem-only changes require
 * repeated observation so catalog/settings rebuilds cannot bypass anti-flap.
 */
export class TaskProjectAvailabilityProjection {
  private readonly stable = new Map<string, StableProjectAvailability>();
  private readonly pending = new Map<string, { available: boolean; observations: number }>();

  constructor(private readonly config: BridgeConfig) {}

  selectable(settings: BridgeUserSettings): ProjectTarget[] {
    this.synchronizeRegistry(settings);
    return settings.projects.filter((project) =>
      project.archivedAt === undefined && this.stable.get(project.projectRef)?.available === true
    );
  }

  observe(settings: BridgeUserSettings, requiredObservations = 2): boolean {
    if (!Number.isInteger(requiredObservations) || requiredObservations < 1) {
      throw new Error("Project availability reconciliation requires a positive observation count.");
    }
    this.synchronizeRegistry(settings);
    let changed = false;
    for (const project of settings.projects) {
      const current = this.stable.get(project.projectRef);
      if (!current || current.projectRevision !== project.projectRevision) continue;
      const available = this.probe(project);
      if (available === current.available) {
        this.pending.delete(project.projectRef);
        continue;
      }
      const candidate = this.pending.get(project.projectRef);
      const observations = candidate?.available === available
        ? candidate.observations + 1
        : 1;
      if (observations < requiredObservations) {
        this.pending.set(project.projectRef, { available, observations });
        continue;
      }
      this.stable.set(project.projectRef, {
        projectRevision: project.projectRevision,
        available
      });
      this.pending.delete(project.projectRef);
      changed = true;
    }
    return changed;
  }

  private synchronizeRegistry(settings: BridgeUserSettings): void {
    const currentRefs = new Set(settings.projects.map((project) => project.projectRef));
    for (const projectRef of this.stable.keys()) {
      if (!currentRefs.has(projectRef)) {
        this.stable.delete(projectRef);
        this.pending.delete(projectRef);
      }
    }
    for (const project of settings.projects) {
      const current = this.stable.get(project.projectRef);
      if (current?.projectRevision === project.projectRevision) continue;
      this.stable.set(project.projectRef, {
        projectRevision: project.projectRevision,
        available: project.archivedAt === undefined && this.probe(project)
      });
      this.pending.delete(project.projectRef);
    }
  }

  private probe(project: ProjectTarget): boolean {
    try {
      return resolveAllowedCwd(project.cwd, this.config.allowedRoots) === project.cwd;
    } catch {
      return false;
    }
  }
}

export const MAX_CODEX_STATUS_WAIT_MS = 60_000;
const MAX_ACTIVE_JOB_OBSERVATION_WAITS = 128;
/** Keep model-visible reads comfortably below common 60-second host lifetimes. */
export const DEFAULT_CODEX_STATUS_WAIT_MS = 20_000;
const JOB_PROGRESS_PERSIST_INTERVAL_MS = 30_000;
const PROGRESS_PERSISTENCE_QUEUE_CAPACITY = 256;
const PROGRESS_PERSISTENCE_PER_PROJECT_CAPACITY = 32;
const PROGRESS_PERSISTENCE_IMMEDIATE_BUDGET = 4;

/**
 * Explicit escape hatch for protocol-owned or upstream-owned JSON leaves. The
 * containing result envelope is always strict; see docs/output-contracts.md.
 */
const opaqueJsonObjectOutputSchema = z.record(z.string(), z.unknown());

const modelChoiceOutputSchema = z.strictObject({
  model: z.string(),
  reasoningEffort: z.string(),
  serviceTier: z.string().optional()
});

const compactExecutionAuditOutputSchema = z.strictObject({
  requested: modelChoiceOutputSchema.omit({ serviceTier: true }).nullable(),
  actual: modelChoiceOutputSchema,
  source: z.enum([
    "fixed",
    "configured-fallback",
    "caller",
    "thread-inherited",
    "backend-default",
    "compatibility-fallback"
  ]),
  evidence: z.enum(["model/rerouted", "turn/start-accepted", "bridge-dispatch"]),
  reroute: z.strictObject({
    fromModel: z.string(),
    toModel: z.string(),
    reason: z.string()
  }).optional()
});

const resultAvailabilityOutputSchema = z.strictObject({
  availability: z.enum(["pending", "delivered", "omitted", "unavailable"]),
  bytes: z.number().int().min(-1).nullable(),
  omitted: z.boolean()
});

const modelResultAvailabilityOutputSchema = z.strictObject({
  availability: z.enum(["pending", "delivered", "omitted", "unavailable"]),
  omitted: z.boolean()
});

const nextToolActionOutputSchema = z.strictObject({
  tool: z.string(),
  arguments: opaqueJsonObjectOutputSchema,
  userPrompt: z.string().optional()
});

const structuredErrorOutputSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  missingFields: z.array(z.string()).optional(),
  contextContinuity: z.literal("not-migrated").optional()
});

const taskStructuredErrorOutputSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().nullable(),
  missingFields: z.array(z.string()).nullable(),
  contextContinuity: z.enum(["not-migrated"]).nullable()
});

const backendHandoffAuditOutputSchema = z.strictObject({
  sourceBackend: z.enum(["mcp-server", "app-server", "codex-sdk"]),
  targetBackend: z.enum(["mcp-server", "app-server", "codex-sdk"]),
  sourceThreadId: z.string(),
  continuity: z.literal("explicit-summary-only"),
  summarySha256: z.string()
});

const bridgeSessionOutputSchema = z.strictObject({
  requestedMode: z.enum(["auto", "new", "continue"]),
  action: z.enum(["start", "continue"]),
  reason: z.enum([
    "explicit-new",
    "explicit-thread",
    "activity-new",
    "activity-compatible",
    "activity-no-compatible",
    "recent-compatible",
    "compatible-session-busy",
    "no-compatible-session"
  ]),
  threadId: z.string().optional(),
  handoff: backendHandoffAuditOutputSchema.optional(),
  scopeId: z.string(),
  requestId: z.string(),
  projectName: z.string().nullable()
});

const dashboardPresentationOutputSchema = z.strictObject({
  statusTool: z.literal("codex_status"),
  openTool: z.literal("codex_dashboard"),
  scope: z.literal("conversation"),
  automatic: z.boolean(),
  reason: z.enum(["default", "experimental-direct-wait"]),
  completionDeliveryRoute: z.enum(["live-card", "direct-wait"])
});

const followupViewOutputSchema = z.strictObject({
  followupId: z.string().regex(FOLLOWUP_ID_PATTERN), requestId: z.string().uuid(),
  status: z.enum(["approved-pending", "admitted", "expired"])
});
const approvedFollowupsOutputSchema = z.array(followupViewOutputSchema).min(1).max(8).optional();

const codexTaskOutputSchema = z.strictObject({
  contractVersion: z.literal("4"),
  kind: z.enum(["task"]),
  state: z.enum([...ACTIVITY_JOB_STATUSES, "setup-required"]),
  terminal: z.boolean(),
  delivery: z.enum(["status", "primary-content", "omitted", "none"]),
  replay: z.boolean(),
  jobId: z.string().nullable(),
  activityId: z.string().nullable(),
  agentId: z.string().nullable(),
  threadId: z.string().nullable(),
  projectName: z.string().nullable(),
  requestId: z.string().nullable(),
  approvedFollowups: z.array(followupViewOutputSchema).min(1).max(8).nullable(),
  jobVersion: z.number().int().min(1).nullable(),
  activityVersion: z.number().int().min(1).nullable(),
  backend: z.enum(["mcp-server", "app-server", "codex-sdk"]).nullable(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable(),
  completionDeliveryPolicy: z.enum(["live-card", "direct-wait"]).nullable(),
  requestedModel: z.string().nullable(),
  requestedReasoningEffort: z.string().nullable(),
  actualModel: z.string().nullable(),
  actualReasoningEffort: z.string().nullable(),
  rerouted: z.boolean(),
  rerouteReason: z.string().nullable(),
  resultAvailability: z.enum(["pending", "delivered", "omitted", "unavailable"]),
  resultOmitted: z.boolean(),
  answer: z.string().nullable(),
  error: taskStructuredErrorOutputSchema.nullable(),
  warnings: z.array(z.string()),
  nextActions: z.array(modelNextActionOutputSchema)
}).superRefine((value, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: "custom", path, message });
  const hasJob = value.jobId !== null;
  const active = value.state === "running" || value.state === "terminating" || value.state === "termination-failed";
  const terminalFailure = value.state === "failed" || value.state === "interrupted" || value.state === "cancelled";

  if (value.resultOmitted !== (value.resultAvailability === "omitted")) {
    issue(["resultOmitted"], "resultOmitted must match resultAvailability=omitted.");
  }
  if (value.resultAvailability === "delivered" !== (value.answer !== null)) {
    issue(["answer"], "A delivered result must carry exactly one model-authoritative answer.");
  }
  if (value.answer !== null && value.answer.length === 0) {
    issue(["answer"], "A model-authoritative answer cannot be empty.");
  }
  if (!hasJob) {
    if (value.state !== "failed" && value.state !== "setup-required") {
      issue(["state"], "A task without an admitted Job must be failed or setup-required.");
    }
    if (!value.terminal || value.delivery !== "none" || value.resultAvailability !== "unavailable" || value.error === null) {
      issue(["state"], "A pre-admission task result must be terminal, unavailable, and carry a structured error.");
    }
    for (const field of ["activityId", "agentId", "threadId", "requestId", "approvedFollowups", "jobVersion", "activityVersion", "backend", "sandbox", "completionDeliveryPolicy"] as const) {
      if (value[field] !== null) issue([field], "A pre-admission task result cannot contain Job identity or execution fields.");
    }
    return;
  }
  // An asynchronous admission can return before App Server assigns its first
  // thread. The Job and Agent are already durable and scoped, while threadId
  // stays null until the assignment callback records it. Do not invent a
  // thread identity merely to satisfy the task envelope.
  for (const field of ["activityId", "agentId", "requestId", "jobVersion", "backend", "sandbox", "completionDeliveryPolicy"] as const) {
    if (value[field] === null) issue([field], "An admitted Job result requires its current identity and execution fields.");
  }
  if (active) {
    if (value.terminal || value.delivery !== "status" || value.resultAvailability !== "pending" || value.answer !== null) {
      issue(["state"], "An active Job must be non-terminal with a pending status result.");
    }
    return;
  }
  if (!value.terminal) issue(["terminal"], "A terminal Job state must set terminal=true.");
  if (value.state === "completed") {
    if (value.error !== null) issue(["error"], "A completed Job cannot carry an error.");
    if (value.resultAvailability === "pending") {
      issue(["resultAvailability"], "A completed Job must have a delivered, omitted, or unavailable result.");
    }
    if (value.resultAvailability === "delivered" && !["primary-content", "status"].includes(value.delivery)) {
      issue(["delivery"], "A delivered completed result must use primary-content or status delivery.");
    }
    if (value.resultAvailability === "omitted" && value.delivery !== "omitted") {
      issue(["delivery"], "An omitted completed result must use omitted delivery.");
    }
    if (value.resultAvailability === "unavailable" && value.delivery !== "none") {
      issue(["delivery"], "An unavailable completed result must use no delivery.");
    }
    return;
  }
  if (terminalFailure && (value.delivery !== "none" || value.resultAvailability !== "unavailable" || value.answer !== null || value.error === null)) {
    issue(["state"], "A failed, interrupted, or cancelled Job must expose only a terminal structured error.");
  }
});

export const DASHBOARD_STATUSES = [
  "running",
  "background-process-running",
  "input-required",
  "approval-required",
  "terminating",
  "termination-failed",
  "liveness-unknown",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "idle",
  "orphaned"
] as const;

const dashboardExecutionOutputSchema = z.strictObject({
  model: z.string(),
  modelDisplayName: z.string().optional(),
  reasoningEffort: z.string(),
  serviceTier: z.string().optional(),
  reroutedModel: z.string().optional(),
  reroutedModelDisplayName: z.string().optional(),
  isCurrent: z.boolean()
});

const cancellationDisplayOutputSchema = z.strictObject({
  targetKind: z.enum(["job", "activity"]),
  agentName: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["requested", "succeeded", "failed"]),
  reason: z.string().trim().min(1).max(CANCELLATION_REASON_MAX_LENGTH),
  requestedAt: z.iso.datetime()
});

const dashboardTokenUsageOutputSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number()
});

const dashboardTurnOutputSchema = z.strictObject({
  activityKey: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  activityTitle: z.string().nullable(),
  tokenUsage: dashboardTokenUsageOutputSchema.optional(),
  execution: dashboardExecutionOutputSchema.optional(),
  status: z.enum(DASHBOARD_STATUSES),
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().min(0).nullable(),
  cancellation: cancellationDisplayOutputSchema.optional()
});

const dashboardConversationUrlOutputSchema = z.string().regex(
  /^https:\/\/chatgpt\.com\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
);

const dashboardCodexThreadUrlOutputSchema = z.string().regex(
  /^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
);

const workHistoryPolicyOutputSchema = z.strictObject({
  retentionDays: z.number().int().min(0), issueAttentionDays: z.number().int().positive(),
  reviewUntilRetention: z.boolean().optional(),
  automaticRecovery: z.boolean().optional(),
  lastCleanupAt: z.string().nullable(), lastCleanupCount: z.number().int().min(0), totalRemoved: z.number().int().min(0)
});
const dashboardRowOutputSchema = z.strictObject({
  handoff: z.object({ phase: z.string(), reason: z.string().optional(), requested: z.boolean(), canOpen: z.boolean() }).optional(),
  rowKey: z.string().regex(/^[0-9a-f]{32}$/),
  activityKey: z.string().regex(/^[0-9a-f]{32}$/),
  conversationKey: z.string().regex(/^[0-9a-f]{32}$/),
  sessionAlias: z.string(),
  conversationUrl: dashboardConversationUrlOutputSchema.optional(),
  codexThreadUrl: dashboardCodexThreadUrlOutputSchema.optional(),
  bucket: z.enum(["active", "recent", "idle"]),
  projectKey: z.string().regex(/^[0-9a-f]{32}$/),
  projectName: z.string().nullable(),
  agentName: z.string(),
  activityTitle: z.string().nullable(),
  tokenUsage: dashboardTokenUsageOutputSchema.optional(),
  execution: dashboardExecutionOutputSchema.optional(),
  status: z.enum(DASHBOARD_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  elapsedMs: z.number().int().min(0),
  backgroundProcessCount: z.number().int().min(0),
  controlKind: z.literal("request").nullable().optional(),
  latestTurn: dashboardTurnOutputSchema.nullable().optional(),
  history: z.array(dashboardTurnOutputSchema).optional(),
  historyCount: z.number().int().min(0).optional(),
  /**
   * Identifies the execution represented by this Agent row. A deferred
   * history response must carry the same value before a client renders it.
   */
  historyRevision: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

const dashboardProblemOutputSchema = z.strictObject({
  problemKey: z.string().regex(/^[a-f0-9]{32}$/), revision: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["failed", "unknown", "termination-failed", "orphaned"]),
  source: z.enum(["execution", "runtime", "recovery"]), review: z.enum(["pending", "acknowledged", "automatic"]),
  acknowledgedAt: z.string().nullable(), observedAt: z.string(), reason: z.string().max(1000).nullable(),
  canAcknowledge: z.boolean(), canUnacknowledge: z.boolean(), canRecheck: z.boolean(), canRetryStop: z.boolean(),
  stopImpact: z.strictObject({ affectedJobIds: z.array(z.string()).max(100), agentNames: z.array(z.string()).max(100) }).optional(),
  automatic: z.strictObject({kind:z.enum(["recheck","retry-stop","release"]),state:z.enum(["retrying","resolved","blocked"]),
    attempts:z.number().int().min(1),reason:z.string(),evidence:z.string().optional()}).optional(),
  row: dashboardRowOutputSchema
});
const dashboardProblemsOutputSchema = z.strictObject({
  query: problemQuerySchema, revision: z.string(), pendingCount: z.number().int().min(0),
  reviewableCount: z.number().int().min(0),
  acknowledgedCount: z.number().int().min(0),
  historyCount: z.number().int().min(0).optional(),
  automaticCount: z.number().int().min(0).optional(),
  rows: z.array(dashboardProblemOutputSchema),
  page: z.strictObject({ offset:z.number().int().min(0),limit:z.number().int().positive(),
    total:z.number().int().min(0),returned:z.number().int().min(0),hasPrevious:z.boolean(),hasNext:z.boolean() })
});

const dashboardPageOutputSchema = z.strictObject({
  offset: z.number().int().min(0),
  limit: z.number().int().positive(),
  returned: z.number().int().min(0),
  total: z.number().int().min(0),
  returnedConversations: z.number().int().min(0),
  conversationTotal: z.number().int().min(0),
  hasPrevious: z.boolean(),
  hasNext: z.boolean()
});

const dashboardCountsOutputSchema = z.strictObject({
  trackedProjects: z.number().int().min(0),
  trackedConversations: z.number().int().min(0),
  retainedJobs: z.number().int().min(0),
  active: z.number().int().min(0),
  running: z.number().int().min(0),
  inputRequired: z.number().int().min(0),
  approvalRequired: z.number().int().min(0),
  terminating: z.number().int().min(0),
  needsAttention: z.number().int().min(0),
  responseRequired: z.number().int().min(0).optional(),
  problems: z.number().int().min(0).optional(),
  backgroundProcesses: z.number().int().min(0),
  backgroundProcessAgents: z.number().int().min(0),
  runtimeUnknownAgents: z.number().int().min(0),
  runtimeProbeSkippedAgents: z.number().int().min(0),
  completed: z.number().int().min(0),
  failed: z.number().int().min(0),
  interrupted: z.number().int().min(0),
  cancelled: z.number().int().min(0),
  idleAgents: z.number().int().min(0),
  orphanedAgents: z.number().int().min(0)
});

const codexWeeklyUsageOutputSchema = z.strictObject({
  source: z.literal("codex-account-rate-limits"),
  limitId: z.string().trim().min(1).max(100),
  usedPercent: z.number().min(0).max(100),
  remainingPercent: z.number().min(0).max(100),
  windowDurationMins: z.literal(7 * 24 * 60),
  resetsAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime()
});

const dashboardModelOutputSchema = z.strictObject({
  kind: z.literal("dashboard"),
  scope: z.literal("bridge-wide"),
  readOnly: z.literal(true),
  statusSource: z.literal("codex-runtime-only"),
  summary: z.string()
});

const jobCompletionDeliveryOutputSchema = z.strictObject({
  kind: z.literal("job-completion-delivery"),
  state: z.enum(["claimed", "waiting", "settled"]),
  receipt: z.string().regex(/^completion-[a-f0-9]{64}$/).optional(),
  attempt: z.number().int().min(1).optional(),
  leaseExpiresAt: z.iso.datetime().optional(),
  deliveryState: z.enum([
    "pending",
    "leased",
    "host-rejected",
    "host-accepted",
    "acceptance-unknown",
    "result-read"
  ]).optional()
});

const cardEnrichmentOutputSchema = z.strictObject({
  state: z.enum(["structural", "enriched"]),
  runtimeRequests: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  timeouts: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  usageTimedOut: z.boolean(),
  runtimeUnavailable: z.number().int().min(0).optional(),
  pendingReads: z.number().int().min(0).optional(),
  usageUnavailable: z.boolean().optional(),
  oldestObservationAt: z.iso.datetime().optional()
});

const dashboardViewOutputSchema = z.strictObject({
  problems: dashboardProblemsOutputSchema.optional(),
  historyPolicy: workHistoryPolicyOutputSchema.optional(),
  kind: z.literal("dashboard"),
  generatedAt: z.string(),
  scope: z.enum(["bridge-wide", "conversation"]),
  statusFilter: z.enum(DASHBOARD_STATUS_FILTERS).optional(),
  filter: z.strictObject({
    mode: z.enum(["conversation", "all"]),
    conversationAvailable: z.boolean(),
    conversationHasWork: z.boolean()
  }).optional(),
  statusSource: z.literal("codex-runtime-only"),
  coverage: z.literal("bridge-known-retained"),
  enrichment: cardEnrichmentOutputSchema,
  codexAccount: z.record(z.string(), z.unknown()).nullable().optional(),
  usageContext: z.string().nullable().optional(),
  weeklyUsage: codexWeeklyUsageOutputSchema.nullable().optional(),
  usageDisplayStatus: z.enum(["checking", "switching", "available", "timed-out", "unavailable", "no-limit", "signed-out", "not-applicable"]).optional(),
  counts: dashboardCountsOutputSchema,
  activeRows: z.array(dashboardRowOutputSchema),
  terminalRows: z.array(dashboardRowOutputSchema),
  idleRows: z.array(dashboardRowOutputSchema),
  statusRows: z.array(dashboardRowOutputSchema).optional(),
  statusRowsComplete: z.literal(true).optional(),
  historyIncluded: z.boolean().optional(),
  pagination: z.strictObject({
    active: dashboardPageOutputSchema,
    terminal: dashboardPageOutputSchema,
    idle: dashboardPageOutputSchema
  }),
  uiLocalePreference: z.enum(UI_LOCALE_PREFERENCES)
});

/**
 * A narrow, on-demand history slice for one visible Agent row. Status cards
 * deliberately omit every row's history from their initial projection; this
 * keeps the summary fast without making an Agent's previous runs invisible.
 */
const dashboardHistoryDetailOutputSchema = z.strictObject({
  kind: z.literal("dashboard-history"),
  rowKey: z.string().regex(/^[0-9a-f]{32}$/),
  history: z.array(dashboardTurnOutputSchema),
  historyCount: z.number().int().min(0),
  /** Matches the snapshot row that selected the representative execution. */
  historyRevision: z.string().regex(/^[a-f0-9]{64}$/).optional()
});

const modelDescriptionHistoryPageOutputSchema = z.strictObject({
  kind: z.literal("model-description-history"),
  modelId: z.string(),
  versions: z.array(z.strictObject({
    version: z.number().int().positive(),
    description: z.string().nullable(),
    createdAt: z.string().nullable()
  })),
  nextBeforeVersion: z.number().int().positive().nullable()
});

export const DASHBOARD_VIEW_PRIVATE_MAX_BYTES = 512 * 1_024;
export const dashboardViewPrivateMetadataSchema = z.strictObject({
  kind: z.literal("codex/dashboardView"),
  version: z.literal(DASHBOARD_PRIVATE_METADATA_CONTRACT_VERSION),
  purpose: z.literal("bridge-wide-read-only-hydration"),
  view: dashboardViewOutputSchema
});

export function validateDashboardViewPrivateMetadata(
  value: unknown
): z.infer<typeof dashboardViewPrivateMetadataSchema> {
  const parsed = dashboardViewPrivateMetadataSchema.parse(value);
  const bytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (bytes > DASHBOARD_VIEW_PRIVATE_MAX_BYTES) {
    throw new Error(
      `${DASHBOARD_VIEW_METADATA_KEY} is ${bytes} bytes, above its ${DASHBOARD_VIEW_PRIVATE_MAX_BYTES}-byte contract.`
    );
  }
  return parsed;
}

const bridgeUserSettingsOutputSchema = z.strictObject({
  schemaVersion: z.literal(MODEL_POLICY_SCHEMA_VERSION),
  settingsRevision: z.number().int().min(0),
  registryRevision: z.number().int().min(0),
  revision: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  accessStrategy: z.enum(["read-only", "adaptive", "always-full"]),
  modelPolicy: modelPolicyZod(),
  modelDescriptionOverrides: z.record(z.string(), z.string()),
  usePriorityServiceTier: z.boolean(),
  historyRetentionDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(0)]),
  projects: z.array(z.strictObject({
    id: z.string(),
    projectRef: z.string(),
    projectRevision: z.number().int().min(1),
    name: z.string(),
    nameKey: z.string(),
    cwd: z.string(),
    sortOrder: z.number().int(),
    createdAt: z.number(),
    updatedAt: z.number(),
    archivedAt: z.number().optional()
  })),
  uiLocalePreference: z.enum(UI_LOCALE_PREFERENCES),
  maxConcurrentJobs: z.number().int().positive(),
  showBridgeThreadsInCodexApp: z.boolean(),
  experimentalDirectResultDelivery: z.boolean()
});

const catalogModelOutputSchema = z.strictObject({
  experimentalSupportedTools: z.array(z.string()).optional(),
  id: z.string(),
  catalogId: z.string().optional(),
  displayName: z.string(),
  description: z.string().optional(),
  defaultReasoningEffort: z.string().optional(),
  supportedReasoningEfforts: z.array(
    z.strictObject({
      effort: z.string(),
      description: z.string().optional(),
      label: z.string().optional(),
      localizedDescription: z.string().optional(),
      descriptionSource: z.enum(["localized", "upstream", "fallback"]).optional()
    })
  ),
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  upgrade: z.string().optional(),
  upgradeInfo: z.record(z.string(), z.unknown()).optional(),
  supportsPersonality: z.boolean().optional(),
  defaultServiceTier: z.string().optional(),
  serviceTiers: z.array(z.strictObject({
    id: z.string(),
    name: z.string(),
    description: z.string().optional()
  })),
  inputModalities: z.array(z.string()),
  supportedInApi: z.boolean().optional()
});

const settingsViewOutputSchema = z.strictObject({
  historyPolicy: workHistoryPolicyOutputSchema.optional(),
  modelDescriptionHistoryModelIds: z.array(z.string()).optional(),
  settings: bridgeUserSettingsOutputSchema,
  operatorDefaults: bridgeUserSettingsOutputSchema,
  capabilities: z.strictObject({
    availableAccessStrategies: z.array(z.enum(["read-only", "adaptive", "always-full"])),
    availableUiLocalePreferences: z.array(z.enum(UI_LOCALE_PREFERENCES)),
    projectAvailability: z.array(z.strictObject({
      projectId: z.string(),
      name: z.string(),
      available: z.boolean(),
      archived: z.boolean()
    })),
    maxConcurrentJobs: z.number().int().positive(),
    defaultBackend: z.literal("app-server"),
    allowWorkspaceWrite: z.boolean(),
    allowDangerFullAccess: z.boolean(),
    operatorModelCeiling: z.array(modelChoiceZod()).nullable(),
    persistent: z.boolean()
  }),
  catalog: z.strictObject({
    source: z.string().nullable(),
    fetchedAt: z.string().nullable(),
    validatedAt: z.string().nullable(),
    fingerprint: z.string().nullable(),
    cached: z.boolean(),
    stale: z.boolean(),
    lastKnownGood: z.boolean(),
    validation: z.enum(["valid", "temporarily-unverified-with-last-known-good", "invalid"]),
    warning: z.string().nullable(),
    translationCoverage: z.strictObject({ missingEffortIds: z.array(z.string()) }),
    models: z.array(catalogModelOutputSchema)
  }),
  warnings: z.array(z.string()),
  scopeNotice: z.string(),
  presentation: z.strictObject({
    warnings: z.array(z.strictObject({
      key: z.string(),
      parameters: z.record(z.string(), z.union([z.string(), z.number()]))
    })),
    catalogWarning: z.strictObject({
      key: z.string(),
      parameters: z.record(z.string(), z.union([z.string(), z.number()]))
    }).nullable(),
    scopeNotice: z.strictObject({
      key: z.string(),
      parameters: z.record(z.string(), z.union([z.string(), z.number()]))
    })
  }).optional(),
  policyActivation: z.strictObject({
    policyRevision: z.number().int().min(0),
    executionPolicyActive: z.boolean(),
    descriptorProjectionUpdated: z.boolean(),
    developerModeRefreshRequired: z.boolean()
  })
});

export type SettingsView = z.infer<typeof settingsViewOutputSchema>;

const jobWaitOutputSchema = z.strictObject({
  waitFor: z.enum(["change", "terminal"]),
  waitedMs: z.number().int().min(0),
  timedOut: z.boolean(),
  changed: z.boolean()
});

const jobSemanticOutputSchema = z.strictObject({
  approvedFollowups: approvedFollowupsOutputSchema,
  runtime: opaqueJsonObjectOutputSchema.optional(),
  status: z.enum(ACTIVITY_JOB_STATUSES),
  terminal: z.boolean(),
  async: z.boolean(),
  delivery: z.enum(["status", "primary-content", "omitted", "none"]),
  replay: z.boolean(),
  jobId: z.string(),
  activityId: z.string(),
  agentId: z.string().nullable(),
  contextMode: z.enum(AGENT_CONTEXT_MODES).nullable(),
  backendKind: z.enum(["mcp-server", "app-server", "codex-sdk"]),
  threadId: z.string().nullable(),
  turnId: z.string().nullable(),
  versions: z.strictObject({
    job: z.number().int().min(1),
    activity: z.number().int().min(1).optional()
  }),
  operation: z.enum(["start", "continue"]),
  projectName: z.string().nullable(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  completionDeliveryPolicy: z.enum(["live-card", "direct-wait"]),
  executionAudit: compactExecutionAuditOutputSchema.nullable(),
  scopeId: z.string(),
  requestId: z.string(),
  bridgeSession: bridgeSessionOutputSchema,
  bridgeActivity: z.strictObject({
    activityId: z.string(),
    jobId: z.string(),
    agentId: z.string().nullable(),
    projectName: z.string().nullable(),
    dashboard: dashboardPresentationOutputSchema
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  cancelRequestedAt: z.string().nullable(),
  terminalOrigin: z.enum(JOB_TERMINAL_ORIGINS).nullable(),
  cancellation: opaqueJsonObjectOutputSchema.nullable(),
  health: z.enum([
    "running",
    "no-progress-observed",
    "liveness-unknown",
    "terminating",
    "termination-failed",
    "terminal",
    "worker-lost",
    "orphaned"
  ]),
  processLiveness: z.enum([
    "connected",
    "liveness-unknown",
    "worker-lost",
    "orphaned",
    "terminating",
    "termination-unconfirmed"
  ]),
  lastProgressAt: z.string(),
  idleMs: z.number().min(0),
  progressObserved: z.boolean(),
  lastProgress: z.strictObject({
    progress: z.number(),
    total: z.number().optional(),
    message: z.string().optional()
  }).optional(),
  staleAfterMs: z.number().int().positive(),
  wait: jobWaitOutputSchema.optional(),
  result: resultAvailabilityOutputSchema,
  error: structuredErrorOutputSchema.optional(),
  warnings: z.array(z.string()),
  nextActions: z.array(nextToolActionOutputSchema),
  message: z.string()
});

const statusCountsOutputSchema = z.strictObject({
  sessions: z.number().int().min(0),
  jobs: z.number().int().min(0),
  runningJobs: z.number().int().min(0),
  activities: z.number().int().min(0),
  agents: z.number().int().min(0),
  orphanedAgents: z.number().int().min(0)
});

const statusItemOutputSchema = z.strictObject({
  approvedFollowups: approvedFollowupsOutputSchema,
  inputs: z.strictObject({ cursor: z.string(), ordinaryQuestions: z.number().int().min(0), approvalRequests: z.number().int().min(0), readTool: z.literal("codex_status"), queryKind: z.literal("input") }).optional(),
  runtime: z.string().optional(),
  type: z.enum(["session", "job", "activity", "agent", "thread"]),
  id: z.string(),
  label: z.string().optional(),
  state: z.string().optional(),
  version: z.number().int().min(1).optional(),
  activityId: z.string().optional(),
  agentId: z.string().optional(),
  threadId: z.string().optional(),
  terminal: z.boolean().optional(),
  delivery: z.enum(["status", "primary-content", "omitted", "none"]).optional(),
  completionDeliveryPolicy: z.enum(["live-card", "direct-wait"]).optional(),
  completionEvidence: z.strictObject({
    jobRecord: z.enum(["active-last-known", "terminal-committed"]),
    ownerObservation: z.enum(["connected", "liveness-unknown", "worker-lost", "orphaned"]).nullable(),
    ownerTerminalResult: z.strictObject({
      origin: z.enum(JOB_TERMINAL_ORIGINS),
      // Date.now() is emitted as a fixed-width UTC ISO string. Keep the
      // model-visible schema small while validating that wire shape.
      observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }).nullable(),
    terminalOrigin: z.enum(JOB_TERMINAL_ORIGINS).nullable(),
    deliveryRecord: z.enum([
      "pending", "leased", "host-rejected", "host-accepted", "acceptance-unknown", "result-read"
    ]).nullable(),
    resultOffer: z.enum(["none", "direct-query", "completion-receipt", "both"]),
    activityLifecycle: z.enum(ACTIVITY_LIFECYCLES).nullable()
  }).optional(),
  replay: z.boolean().optional(),
  versions: z.strictObject({
    job: z.number().int().min(1),
    activity: z.number().int().min(1).nullable()
  }).optional(),
  execution: z.strictObject({
    backend: z.enum(["mcp-server", "app-server", "codex-sdk"]),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"])
  }).optional(),
  result: modelResultAvailabilityOutputSchema.optional(),
  answer: z.string().optional(),
  error: structuredErrorOutputSchema.optional(),
  wait: jobWaitOutputSchema.optional(),
  nextActions: z.array(modelNextActionOutputSchema).optional(),
  message: z.string().optional()
});

const codexStatusOutputSchema = z.strictObject({
  runtimes: z.array(z.string()).optional(),
  kind: z.enum(["overview", "page", "activity", "thread", "job"]),
  scope: z.strictObject({
    mode: z.enum(["all", "scoped", "policy-only"]),
    source: z.enum(["host-metadata", "explicit-compatibility"]).optional()
  }),
  counts: statusCountsOutputSchema,
  page: z.strictObject({
    collection: z.enum(["sessions", "jobs", "activities"]),
    offset: z.number().int().min(0),
    limit: z.number().int().positive(),
    returned: z.number().int().min(0),
    total: z.number().int().min(0),
    hasMore: z.boolean(),
    nextCursor: z.string().optional()
  }).optional(),
  items: z.array(statusItemOutputSchema),
  warnings: z.array(z.string())
});

const projectStatusOutputSchema = z.strictObject({
  kind: z.literal("project"),
  project: currentProjectSelectionZod().nullable(),
  error: structuredErrorOutputSchema.optional(),
  nextActions: z.array(modelNextActionOutputSchema)
});

const mutationOutputSchema = z.strictObject({
  kind: z.literal("mutation"),
  ok: z.boolean(),
  action: z.string(),
  code: z.string().optional(),
  agent: opaqueJsonObjectOutputSchema.optional(),
  activity: opaqueJsonObjectOutputSchema.optional(),
  job: opaqueJsonObjectOutputSchema.optional(),
  cancelledJobIds: z.array(z.string()).optional(),
  affectedJobIds: z.array(z.string()).optional(),
  collateralJobIds: z.array(z.string()).optional(),
  backgroundProcesses: z.array(z.strictObject({ processId: z.string() })).optional(),
  forceStop: nextToolActionOutputSchema.nullable().optional(),
  threadId: z.string().optional(),
  processId: z.string().optional(),
  activityId: z.string().optional(),
  agentId: z.string().optional(),
  terminated: z.boolean().optional(),
  alreadyReleased: z.boolean().optional(),
  detachedAssignment: opaqueJsonObjectOutputSchema.optional(),
  historyPreserved: z.boolean().optional(),
  deletionPerformed: z.boolean().optional(),
  policySource: z.literal("explicit-tool-input").optional(),
  codexOutputCanMutatePolicy: z.literal(false).optional(),
  promptOrAnswersPersisted: z.literal(false).optional(),
  promptPersistedByBridge: z.literal(false).optional(),
  steeringScope: z.literal("active-codex-turn-only").optional(),
  warning: z.string().optional(),
  warnings: z.array(z.string()),
  nextActions: z.array(nextToolActionOutputSchema)
});

const mutationTargetOutputSchema = z.strictObject({
  type: z.enum(["agent", "job", "activity"]),
  id: z.string(),
  state: z.string().optional(),
  version: z.number().int().min(1).optional()
});

const modelMutationBaseShape = {
  kind: z.literal("mutation"),
  ok: z.boolean(),
  action: z.string(),
  code: z.string().optional(),
  target: mutationTargetOutputSchema.optional(),
  warnings: z.array(z.string()),
  nextActions: z.array(modelNextActionOutputSchema)
};

const agentMutationOutputSchema = z.strictObject(modelMutationBaseShape);
const cancelMutationOutputSchema = z.strictObject(modelMutationBaseShape);
const activityUpdateMutationOutputSchema = z.strictObject({
  ...modelMutationBaseShape,
  affectedJobIds: z.array(z.string()),
  policySource: z.literal("explicit-tool-input"),
  codexOutputCanMutatePolicy: z.literal(false)
});
const activityCancelMutationOutputSchema = z.strictObject({
  ...modelMutationBaseShape,
  affectedJobIds: z.array(z.string()),
  policySource: z.literal("explicit-tool-input"),
  codexOutputCanMutatePolicy: z.literal(false)
});

const steeringResultCodes = [
  "JOB_NOT_ACTIVE",
  "STALE_JOB_VERSION",
  "STEERING_UNSUPPORTED",
  "JOB_SCOPE_MISMATCH",
  "DELIVERY_UNCERTAIN",
  "STEERING_REQUEST_CONFLICT"
] as const;

const compactSteeringJobOutputSchema = z.strictObject({
  jobId: z.string(),
  activityId: z.string(),
  agentId: z.string(),
  status: z.enum(ACTIVITY_JOB_STATUSES),
  version: z.number().int().min(1)
});

const codexSteerOutputSchema = z.strictObject({
  kind: z.literal("mutation"),
  ok: z.boolean(),
  action: z.literal("steer"),
  code: z.enum(steeringResultCodes).nullable(),
  job: compactSteeringJobOutputSchema.nullable(),
  promptPersistedByBridge: z.literal(false),
  steeringScope: z.literal("active-codex-turn-only"),
  delivery: z.strictObject({
    status: z.enum(["delivered", "not-delivered", "uncertain"])
  }),
  message: z.string(),
  warnings: z.array(z.string()),
  nextActions: z.array(modelNextActionOutputSchema)
});

const compactCatalogEffortOutputSchema = z.strictObject({
  id: z.string(),
  description: z.string().optional()
});

const compactCatalogServiceTierOutputSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().optional()
});

const compactCatalogModelOutputSchema = z.strictObject({
  questions: z.strictObject({ structuredAsync: z.enum(["unknown", "catalog-enabled", "not-advertised"]), asyncMessage: z.enum(["unknown", "catalog-enabled", "not-advertised"]), runtimeVerification: z.literal("required") }).optional(),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  descriptionSource: z.literal("user").optional().describe("Present when description is user-authored selection guidance; omitted for the installed Codex catalog description."),
  efforts: z.array(compactCatalogEffortOutputSchema),
  serviceTiers: z.array(compactCatalogServiceTierOutputSchema)
});

const codexModelsOutputSchema = z.strictObject({
  contractVersion: z.literal("2"),
  selectionMode: z.enum(["fixed", "automatic"]),
  source: z.string(),
  stale: z.boolean(),
  warning: z.string().nullable(),
  models: z.array(compactCatalogModelOutputSchema)
});

const skillReferenceOutputSchema = z.strictObject({
  skillId: z.string().min(1),
  source: z.literal(BRIDGE_SKILL_SOURCE),
  version: z.string().min(1)
});

const skillSummaryOutputSchema = skillReferenceOutputSchema.extend({
  name: z.string().min(1),
  description: z.string(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  enabled: z.boolean(),
  availability: z.enum(["available", "disabled"])
});

const bridgeSkillSearchOutputSchema = z.strictObject({
  kind: z.literal("skill-search"),
  skills: z.array(skillSummaryOutputSchema)
});

const bridgeSkillValueOutputSchema = skillSummaryOutputSchema.extend({
  content: z.string().min(1),
  files: z.array(z.strictObject({
    path: z.string().min(1),
    format: z.literal("markdown"),
    bytes: z.number().int().nonnegative(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })),
  format: z.literal("markdown"),
  legacy: z.boolean(),
  sourceSnapshot: z.literal("versioned-bridge-record"),
  warnings: z.array(z.enum(["archived", "legacy-structured"]))
});

const bridgeSkillReadOutputSchema = z.strictObject({
  kind: z.literal("skill"),
  skill: bridgeSkillValueOutputSchema
});

const bridgeSkillFileOutputSchema = z.strictObject({
  kind: z.literal("skill-file"),
  skill: skillSummaryOutputSchema,
  path: z.string().min(1),
  content: z.string(),
  format: z.literal("markdown"),
  bytes: z.number().int().nonnegative(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/)
});

const bridgeSkillVersionsOutputSchema = z.strictObject({
  kind: z.literal("skill-versions"),
  skillId: z.string().regex(/^bridge_[a-f0-9]{32}$/),
  source: z.literal(BRIDGE_SKILL_SOURCE),
  currentVersion: z.string().regex(/^[1-9]\d*$/),
  enabled: z.boolean(),
  versions: z.array(skillSummaryOutputSchema.extend({
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().min(1),
    format: z.literal("markdown"),
    legacy: z.boolean()
  }))
});

const bridgeSkillOutputSchema = z.union([
  bridgeSkillSearchOutputSchema,
  bridgeSkillReadOutputSchema,
  bridgeSkillFileOutputSchema,
  bridgeSkillVersionsOutputSchema
]);

const bridgeSkillManageOutputSchema = z.strictObject({
  kind: z.literal("skill-mutation"),
  action: z.enum(["create", "update", "create-package", "update-package", "restore", "set-enabled"]),
  requestId: z.string().uuid(),
  skill: skillSummaryOutputSchema,
  message: z.string().min(1)
});

const durationDiagnosticsOutputSchema = z.strictObject({
  count: z.number().int().min(0),
  p50Ms: z.number().min(0),
  p95Ms: z.number().min(0),
  maxMs: z.number().min(0)
});

const jobWaitDiagnosticsOutputSchema = z.strictObject({
  defaultWaitMs: z.number().int().positive(),
  exactStatusWaits: z.number().int().min(0),
  started: z.strictObject({
    total: z.number().int().min(0),
    change: z.number().int().min(0),
    terminal: z.number().int().min(0)
  }),
  sources: z.strictObject({
    modelStatus: z.number().int().min(0),
    dashboardCompletion: z.number().int().min(0),
    internal: z.number().int().min(0)
  }),
  completed: z.number().int().min(0),
  timedOut: z.number().int().min(0),
  waitedMs: durationDiagnosticsOutputSchema,
  wakes: z.strictObject({
    total: z.number().int().min(0),
    progress: z.number().int().min(0),
    terminal: z.number().int().min(0),
    stateChange: z.number().int().min(0)
  }),
  hostAborts: z.strictObject({
    total: z.number().int().min(0),
    modelStatus: z.number().int().min(0),
    dashboardCompletion: z.number().int().min(0),
    internal: z.number().int().min(0),
    recordedStatusWaitAborts: z.number().int().min(0)
  }),
  active: z.strictObject({
    total: z.number().int().min(0),
    modelStatus: z.number().int().min(0),
    dashboardCompletion: z.number().int().min(0),
    internal: z.number().int().min(0),
    jobs: z.array(z.strictObject({
      jobId: z.string(),
      total: z.number().int().min(0),
      change: z.number().int().min(0),
      terminal: z.number().int().min(0),
      modelStatus: z.number().int().min(0),
      dashboardCompletion: z.number().int().min(0),
      internal: z.number().int().min(0)
    }))
  }),
  maintenance: z.strictObject({
    pruneAndPersist: durationDiagnosticsOutputSchema,
    telemetryTransaction: durationDiagnosticsOutputSchema
  })
});

const diagnosticsOutputSchema = z.strictObject({
  kind: z.literal("diagnostics"),
  bridge: z.strictObject({
    runtimeName: z.string(),
    product: z.string(),
    build: opaqueJsonObjectOutputSchema,
    auth: z.enum(["bearer-token", "none"]),
    backend: z.enum(["mcp-server", "app-server", "codex-sdk"])
  }),
  storage: z.strictObject({
    backend: z.enum(["sqlite", "memory", "split-json"]),
    transactional: z.boolean(),
    schemaVersion: z.number().int().positive(),
    activityPersistent: z.boolean(),
    sessionPersistent: z.boolean(),
    settingsPersistent: z.boolean()
  }),
  scopeSecurity: z.strictObject({
    hmacKeyVersion: z.number().int().min(1),
    hmacRotation: z.string(),
    rawHostIdentifiersPersisted: z.literal(false),
    scopeIsAuthentication: z.literal(false)
  }),
  pool: z.strictObject({
    upstreamPoolSize: z.number().int().positive(),
    maxConcurrentJobs: z.number().int().positive(),
    hardLimit: z.number().int().positive(),
    retainedJobs: z.number().int().positive(),
    resultBytes: z.number().int().positive()
  }),
  upstream: z.strictObject({
    tools: z.unknown().nullable(),
    error: z.string().nullable()
  }),
  descriptorDiscovery: z.strictObject({
    epoch: z.number().int().min(0),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    activeBindings: z.number().int().min(0),
    notificationEligibleBindings: z.number().int().min(0),
    notificationQueued: z.boolean(),
    notificationAttempts: z.number().int().min(0),
    notificationErrors: z.number().int().min(0),
    lastNotificationEpoch: z.number().int().min(0).nullable(),
    lastNotificationAttemptAt: z.iso.datetime().nullable(),
    clientRelistObservations: z.number().int().min(0),
    currentEpochRelistedSessions: z.number().int().min(0),
    lastClientRelistedEpoch: z.number().int().min(0).nullable(),
    lastClientRelistedAt: z.iso.datetime().nullable(),
    lastObservedNotificationToRelistMs: z.number().int().min(0).nullable(),
    adoptionState: z.literal("unknown")
  }),
  performance: z.strictObject({
    stages: z.array(z.strictObject({
      name: z.string(),
      count: z.number().int().min(0),
      p50Ms: z.number().int().min(0),
      p95Ms: z.number().int().min(0),
      maxMs: z.number().int().min(0),
      requests: z.number().int().min(0),
      timeouts: z.number().int().min(0),
      cacheHits: z.number().int().min(0)
    })),
    jobWaits: jobWaitDiagnosticsOutputSchema,
    stateMaintenance: z.array(z.strictObject({
      slice: z.enum(STATE_MAINTENANCE_SLICES),
      startedAt: z.number().int().min(0),
      durationMs: z.number().min(0),
      changed: z.number().int().min(0),
      failed: z.boolean(),
      deferred: z.boolean()
    })),
    html: z.strictObject({
      dashboardBytes: z.number().int().min(0),
      dashboardBudgetBytes: z.number().int().positive(),
      settingsBytes: z.number().int().min(0),
      settingsBudgetBytes: z.number().int().positive()
    })
  }),
  forensics: z.strictObject({
    bridgeInstanceId: z.string(),
    startupWarnings: z.array(z.string()),
    settingsLoadWarnings: z.array(z.string())
  })
});

function toolOutputContract<Schema extends z.ZodType>(
  toolName: string,
  channel: AuthoritativeProjectionChannel,
  outputSchema: Schema,
  maxBytes: number,
  completeness: "summary-only" | "documented-support-level" | "primary-payload" = "summary-only",
  format: "plain-text" | "compact-json" = "plain-text"
): ToolResultContract<Schema> {
  const structuredMaxBytes = structuredByteCapFor(toolName);
  return defineToolResultContract({
    toolName,
    channel,
    outputSchema,
    structured: { maxBytes: structuredMaxBytes },
    privateMeta: { maxBytes: TOOL_STRUCTURED_BYTE_CAPS.app_only_hydration },
    compatibility: {
      channel: "text-protocol-compatibility",
      format,
      maxBytes,
      completeness
    }
  });
}

function structuredByteCapFor(toolName: string): number {
  if (toolName in TOOL_STRUCTURED_BYTE_CAPS) {
    return TOOL_STRUCTURED_BYTE_CAPS[
      toolName as keyof typeof TOOL_STRUCTURED_BYTE_CAPS
    ];
  }
  if (toolName === "mutation" || toolName === "app-only-mutation") {
    return TOOL_STRUCTURED_BYTE_CAPS.app_only_mutation;
  }
  if (
    toolName === "codex_ui_read" ||
    toolName === "codex_update_settings"
  ) {
    return TOOL_STRUCTURED_BYTE_CAPS.app_only_hydration;
  }
  throw new Error(`No structured-content byte cap is registered for ${toolName}.`);
}

const statusResultContract = toolOutputContract(
  "codex_status",
  "model-orchestrator-semantic",
  codexStatusOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_status,
  "documented-support-level"
);
const projectStatusResultContract = toolOutputContract(
  "codex_status", "model-orchestrator-semantic", projectStatusOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_status, "documented-support-level"
);
const dashboardModelResultContract = toolOutputContract(
  "codex_dashboard",
  "model-orchestrator-semantic",
  dashboardModelOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_dashboard
);
const dashboardAppResultContract = toolOutputContract(
  "codex_ui_read",
  "app-hydration",
  dashboardViewOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.app_only_hydration
);
const modelsResultContract = toolOutputContract(
  "codex_models",
  "model-orchestrator-semantic",
  codexModelsOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_models
);
const skillResultContract = toolOutputContract(
  "bridge_skill",
  "model-orchestrator-semantic",
  bridgeSkillOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.bridge_skill,
  "primary-payload",
  "compact-json"
);
const skillManageResultContract = toolOutputContract(
  "bridge_skill_manage",
  "model-orchestrator-semantic",
  bridgeSkillManageOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.bridge_skill_manage,
  "documented-support-level"
);
const settingsSnapshotResultContract = toolOutputContract(
  "codex_ui_read",
  "app-hydration",
  settingsViewOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.app_only_hydration
);
const settingsEditorResultContract = toolOutputContract(
  "codex_update_settings",
  "app-hydration",
  settingsViewOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.app_only_hydration
);
const modelMutationResultContracts = Object.freeze({
  codex_agent: toolOutputContract(
    "codex_agent",
    "model-orchestrator-semantic",
    agentMutationOutputSchema,
    TOOL_CONTENT_BYTE_CAPS.codex_agent,
    "documented-support-level"
  ),
  codex_cancel: toolOutputContract(
    "codex_cancel",
    "model-orchestrator-semantic",
    cancelMutationOutputSchema,
    TOOL_CONTENT_BYTE_CAPS.codex_cancel,
    "documented-support-level"
  ),
  codex_activity_update: toolOutputContract(
    "codex_activity_update",
    "model-orchestrator-semantic",
    activityUpdateMutationOutputSchema,
    TOOL_CONTENT_BYTE_CAPS.codex_activity_update,
    "documented-support-level"
  ),
  codex_activity_cancel: toolOutputContract(
    "codex_activity_cancel",
    "model-orchestrator-semantic",
    activityCancelMutationOutputSchema,
    TOOL_CONTENT_BYTE_CAPS.codex_activity_cancel,
    "documented-support-level"
  )
});
const steerResultContract = toolOutputContract(
  "codex_steer",
  "model-orchestrator-semantic",
  codexSteerOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_steer,
  "documented-support-level"
);
const appMutationResultContract = toolOutputContract(
  "app-only-mutation",
  "app-hydration",
  mutationOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.app_only_mutation
);
const taskStateResultContract = toolOutputContract(
  "codex_task",
  "model-orchestrator-semantic",
  codexTaskOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_task_state,
  "documented-support-level"
);
const taskErrorResultContract = toolOutputContract(
  "codex_task",
  "model-orchestrator-semantic",
  codexTaskOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_task_error,
  "documented-support-level"
);
const diagnosticsResultContract = toolOutputContract(
  "codex_diagnostics",
  "operator-diagnostic",
  diagnosticsOutputSchema,
  TOOL_CONTENT_BYTE_CAPS.codex_diagnostics
);

// These are JSON descriptor byte limits, measured after Zod emits JSON Schema
// 2020-12. They are intentionally separate from result payload byte caps.
export const MODEL_VISIBLE_OUTPUT_SCHEMA_BYTE_BUDGET = 64_000;
export const MODEL_VISIBLE_OUTPUT_SCHEMA_PER_TOOL_BYTE_BUDGET = 18_000;

export const MODEL_VISIBLE_OUTPUT_SCHEMAS = Object.freeze({
  codex_answer: CODEX_INPUT_MODEL_OUTPUT_SCHEMAS.codex_answer,
  codex_activity_update: activityUpdateMutationOutputSchema,
  codex_agent: agentMutationOutputSchema,
  codex_cancel: z.union([cancelMutationOutputSchema, activityCancelMutationOutputSchema]),
  codex_dashboard: dashboardModelOutputSchema,
  codex_models: codexModelsOutputSchema,
  bridge_skill: bridgeSkillOutputSchema,
  bridge_skill_manage: bridgeSkillManageOutputSchema,
  codex_settings: z.strictObject({ kind: z.literal("settings"), opened: z.literal(true) }),
  codex_status: z.union([codexStatusOutputSchema, CODEX_INPUT_MODEL_OUTPUT_SCHEMAS.status_input, projectStatusOutputSchema]),
  codex_steer: codexSteerOutputSchema,
  codex_task: codexTaskOutputSchema
});
const uiControlSummaryOutputSchema = z.strictObject({ kind: z.literal("control"), ready: z.literal(true) });
export const APP_PRIVATE_OUTPUT_SCHEMAS = Object.freeze({});
export const OPERATOR_OUTPUT_SCHEMAS = Object.freeze({
  codex_agent_recovery_detach: mutationOutputSchema, codex_diagnostics: diagnosticsOutputSchema
});
export const APP_ONLY_OUTPUT_SCHEMAS = Object.freeze({
  codex_ui_read: z.union([dashboardViewOutputSchema, dashboardHistoryDetailOutputSchema, settingsViewOutputSchema, modelDescriptionHistoryPageOutputSchema, uiControlSummaryOutputSchema]),
  codex_ui_completion: jobCompletionDeliveryOutputSchema,
  codex_ui_problem: problemActionResultSchema,
  codex_interaction_respond: mutationOutputSchema,
  codex_update_settings: settingsViewOutputSchema
});

export type ModelVisibleOutputToolName = keyof typeof MODEL_VISIBLE_OUTPUT_SCHEMAS;
export type AppOnlyOutputToolName = keyof typeof APP_ONLY_OUTPUT_SCHEMAS | keyof typeof APP_PRIVATE_OUTPUT_SCHEMAS | keyof typeof OPERATOR_OUTPUT_SCHEMAS;

export function validateModelVisibleStructuredOutput(
  toolName: ModelVisibleOutputToolName,
  value: unknown
): unknown {
  if (toolName === "codex_task") return validateTaskOutput(value);
  if (toolName === "codex_status") {
    if ((value as { kind?: unknown })?.kind === "codex-input") return CODEX_INPUT_MODEL_OUTPUT_SCHEMAS.status_input.parse(value);
    if ((value as { kind?: unknown })?.kind === "project") return projectStatusOutputSchema.parse(value);
    return validateStatusOutput(value);
  }
  if (toolName === "codex_steer") return validateSteerOutput(value);
  return MODEL_VISIBLE_OUTPUT_SCHEMAS[toolName].parse(value);
}

function validateSteerOutput(value: unknown): z.infer<typeof codexSteerOutputSchema> {
  const parsed = codexSteerOutputSchema.parse(value);
  if (parsed.ok) {
    if (parsed.code !== null || parsed.job === null || parsed.delivery.status !== "delivered") {
      throw new Error("Successful steering requires a delivered result, exact Job, and no error code.");
    }
    return parsed;
  }
  if (parsed.code === null || parsed.delivery.status === "delivered") {
    throw new Error("Failed steering requires an error code and a non-delivered status.");
  }
  if ((parsed.code === "DELIVERY_UNCERTAIN") !== (parsed.delivery.status === "uncertain")) {
    throw new Error("Steering delivery uncertainty must match its structured error code.");
  }
  return parsed;
}

function validateTaskOutput(value: unknown): z.infer<typeof codexTaskOutputSchema> {
  const parsed = codexTaskOutputSchema.parse(value);
  if (parsed.resultOmitted !== (parsed.resultAvailability === "omitted")) {
    throw new Error("Task result omission flag must match result availability.");
  }
  if (parsed.delivery === "primary-content" && parsed.resultAvailability !== "delivered") {
    throw new Error("Primary-content delivery requires a delivered result.");
  }
  const delivered = parsed.resultAvailability === "delivered";
  if (delivered !== (typeof parsed.answer === "string" && parsed.answer.length > 0)) {
    throw new Error("A delivered task result requires one model-authoritative answer.");
  }
  if (!delivered && parsed.answer !== null) {
    throw new Error("A non-delivered task result cannot expose a model-authoritative answer.");
  }
  if (parsed.answer !== null) validateModelPrimaryAnswerBytes(parsed.answer, "Task");
  return parsed;
}

function validateStatusOutput(value: unknown): z.infer<typeof codexStatusOutputSchema> {
  const parsed = codexStatusOutputSchema.parse(value);
  const jobs = parsed.items.filter((item) => item.type === "job");
  if (parsed.kind === "job") {
    if (parsed.items.length !== 1 || jobs.length !== 1) {
      throw new Error("An exact Job status result must contain exactly one Job item.");
    }
    const job = jobs[0]!;
    const delivered = job.result?.availability === "delivered";
    const hasAnswer = typeof job.answer === "string" && job.answer.length > 0;
    if (delivered !== hasAnswer) {
      throw new Error(
        "An exact delivered Job status requires one model-authoritative answer."
      );
    }
    if (!delivered && job.answer !== undefined) {
      throw new Error("A non-delivered exact Job status cannot expose an answer.");
    }
    if (job.answer !== undefined) validateModelPrimaryAnswerBytes(job.answer, "Exact Job status");
    return parsed;
  }

  for (const job of jobs) {
    if (job.answer !== undefined) {
      throw new Error("Summary status results cannot embed Job answer bodies.");
    }
    if (
      job.result?.availability === "delivered" &&
      !job.nextActions?.includes(exactJobAnswerRetrievalAction(job.id))
    ) {
      throw new Error(
        "A summary with a delivered Job must include its exact-Job answer retrieval action."
      );
    }
  }
  return parsed;
}

function validateModelPrimaryAnswerBytes(answer: string, context: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(answer), "utf8") - 2;
  if (bytes > MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES) {
    throw new Error(
      `${context} answer is ${bytes} JSON-encoded bytes, above its ${MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES}-byte contract.`
    );
  }
}

export function validateAppOnlyStructuredOutput(
  toolName: AppOnlyOutputToolName,
  value: unknown
): unknown {
  return ({ ...APP_ONLY_OUTPUT_SCHEMAS, ...APP_PRIVATE_OUTPUT_SCHEMAS, ...OPERATOR_OUTPUT_SCHEMAS })[toolName].parse(value);
}

type SessionDecision = {
  requestedMode: SessionMode;
  action: CodexJobOperation;
  reason:
    | "explicit-new"
    | "explicit-thread"
    | "activity-new"
    | "activity-compatible"
    | "activity-no-compatible"
    // Legacy persisted values retained for state compatibility.
    | "recent-compatible"
    | "compatible-session-busy"
    | "no-compatible-session";
  threadId?: string;
  handoff?: BackendHandoffAudit;
};

type BackendHandoffAudit = {
  sourceBackend: CodexBackendKind;
  targetBackend: CodexBackendKind;
  sourceThreadId: string;
  continuity: "explicit-summary-only";
  summarySha256: string;
};

type BackendHandoff = BackendHandoffAudit & {
  summary: string;
};

type CodexRouting = {
  mcpPrincipal?: string;
  approvedFollowups?: ApprovedFollowup[];
  followup?: FollowupReference;
  scopeId: string;
  requestId: string;
  requestHash: string;
  requestHashVersion: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
};

// Version 11 removes foreground/background from execution identity.
const CURRENT_TASK_REQUEST_HASH_VERSION = 11 as const;

type TaskProjectAdmission = {
  projectId: string;
  projectName: string;
  cwd: string;
};

const widgetInstanceIdSchema = scopeIdSchema().describe(
  "UUID generated once by the mounted Dashboard iframe. It is correlation-only; app visibility and exact control checks remain authoritative."
);

/** Dashboard controls carry only an opaque proof. */
const dashboardControlProofInputSchema = z.strictObject({
  kind: z.literal("dashboard"),
  token: z.string().min(1).max(32_768)
});
const userControlProofInputSchema = dashboardControlProofInputSchema;

function mountedWidgetInstanceId(
  args: { widgetInstanceId?: string },
  meta: unknown
): string | undefined {
  // MCP Apps does not normatively forward a host-side widget session id on
  // app-initiated tools/call requests. The Dashboard therefore provides its
  // own per-iframe correlation id; host metadata remains a compatibility
  // fallback where available.
  return args.widgetInstanceId || metadataString(meta, "openai/widgetSessionId");
}

type CompletionDeliveryPolicy = "live-card" | "direct-wait";

type CodexJob = {
  mcpPrincipal?: string;
  approvedFollowups?: ApprovedFollowup[];
  followup?: FollowupReference;
  executionReceipt?: boolean;
  /** Non-secret owner boundary captured when this execution was admitted. */
  authBoundary?: string;
  threadPersistence?: UpstreamWorkerAssignment["threadPersistence"];
  jobId: string;
  activityId: string;
  projectId?: string;
  projectName?: string;
  /** Caller-facing name+generation selection retained only for exact replay. */
  projectRequest?: RuntimeProjectSelection;
  agentId?: string;
  contextMode?: AgentContextMode;
  threadId?: string;
  backendKind: string;
  trackingState: "connected" | "liveness-unknown" | "worker-lost" | "orphaned";
  runtime?: UpstreamWorkerAssignment["runtime"];
  bridgeInstanceId?: string;
  workerId?: string;
  workerGeneration?: number;
  workerPid?: number;
  processGroupId?: number;
  upstreamRequestId?: string;
  terminalVersion?: number;
  operation: CodexJobOperation;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  version: number;
  cwd: string;
  sandbox: SandboxMode;
  scopeId: string;
  requestId: string;
  requestHash: string;
  requestHashVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  /** Immutable admission-time snapshot; later Settings changes affect only new Jobs. */
  completionDeliveryPolicy: CompletionDeliveryPolicy;
  sourceThreadId?: string;
  selectionKey?: string;
  executionDecision?: ExecutionDecision;
  exclusiveKeys: string[];
  sessionDecision: SessionDecision;
  status: CodexJobStatus;
  result?: ToolResult;
  resultBytes?: number;
  resultOmitted?: boolean;
  lastProgress?: Progress;
  publicEvents: CodexPublicEvent[];
  inputEvents?: CodexPublicEvent[];
  pendingInteractions: CodexPendingInteraction[];
  cancelRequestedAt?: number;
  cancellationIntentId?: string;
  terminalOrigin?: JobTerminalOrigin;
  terminationEscalated?: boolean;
  error?: string;
  promise: Promise<void>;
};

type PersistedCodexJob = Omit<CodexJob, "promise">;

type ProgressPersistenceSnapshot = {
  jobId: string;
  scopeId: string;
  projectKey: string;
  version: number;
  updatedAt: number;
  lastProgressAt: number;
  lastProgress?: Progress;
  pendingInteractions: CodexPendingInteraction[];
  publicEvent?: CodexPublicEvent;
};

export type ProgressPersistenceStatus = ScopeFairQueueStatus & {
  immediateBudget: number;
  immediateRemaining: number;
};

type CodexJobStartInput = Omit<
  CodexJob,
  | "jobId"
  | "authBoundary"
  | "activityId"
  | "agentId"
  | "contextMode"
  | "threadId"
  | "backendKind"
  | "trackingState"
  | "bridgeInstanceId"
  | "workerId"
  | "workerGeneration"
  | "workerPid"
  | "processGroupId"
  | "upstreamRequestId"
  | "terminalVersion"
  | "createdAt"
  | "updatedAt"
  | "lastProgressAt"
  | "lastProgress"
  | "publicEvents"
  | "pendingInteractions"
  | "cancelRequestedAt"
  | "cancellationIntentId"
  | "terminalOrigin"
  | "terminationEscalated"
  | "version"
  | "status"
  | "promise"
  | "result"
  | "resultBytes"
  | "resultOmitted"
  | "error"
  | "completionDeliveryPolicy"
> & {
  activityId?: string;
  agentId?: string;
  contextMode?: AgentContextMode;
  backendKind?: CodexBackendKind;
  completionDeliveryPolicy?: CompletionDeliveryPolicy;
};

export type CodexJobRegistryOptions = {
  authBoundary?: () => string | null;
  /** Verify the current owner before attaching persisted execution receipts. */
  recoveryAdmission?: () => Promise<void>;
  recoverExecutions?: boolean;
  maxConcurrentJobs?: number;
  ttlMs?: number;
  maxJobs?: number;
  maxResultBytes?: number;
  staleAfterMs?: number;
  stateStore?: BridgeStateStore;
  telemetry?: BridgeTelemetryService;
  /** Read-worker snapshot: load persisted state without recovery mutations. */
  projectionOnly?: boolean;
  allowedRoots?: string[];
};

type CodexJobWaitResult = {
  job: CodexJob;
  waitFor: CodexJobWaitMode;
  waitedMs: number;
  waitTimedOut: boolean;
  changed: boolean;
};

type CodexJobWaitSource = "model-status" | "dashboard-completion" | "internal";
type CodexJobWakeReason = "progress" | "terminal" | "state-change";
type ActiveJobWaitCounts = {
  change: number;
  terminal: number;
  modelStatus: number;
  dashboardCompletion: number;
  internal: number;
};

class BoundedDurationDiagnostics {
  private count = 0;
  private readonly samples: number[] = [];

  record(durationMs: number): void {
    this.count += 1;
    this.samples.push(Math.max(0, durationMs));
    if (this.samples.length > 256) this.samples.splice(0, this.samples.length - 256);
  }

  snapshot(): z.infer<typeof durationDiagnosticsOutputSchema> {
    const values = [...this.samples].sort((left, right) => left - right);
    const percentile = (fraction: number): number => {
      if (values.length === 0) return 0;
      return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] || 0;
    };
    const rounded = (value: number) => Math.round(value * 1_000) / 1_000;
    return {
      count: this.count,
      p50Ms: rounded(percentile(0.5)),
      p95Ms: rounded(percentile(0.95)),
      maxMs: rounded(values.at(-1) || 0)
    };
  }
}

class JobWaitDiagnostics {
  private readonly started = { change: 0, terminal: 0 };
  private readonly sources = { modelStatus: 0, dashboardCompletion: 0, internal: 0 };
  private completed = 0;
  private timedOut = 0;
  private readonly wakes = { progress: 0, terminal: 0, stateChange: 0 };
  private readonly hostAborts = { modelStatus: 0, dashboardCompletion: 0, internal: 0 };
  private readonly active = new Map<string, ActiveJobWaitCounts>();
  private readonly waitedMs = new BoundedDurationDiagnostics();
  readonly pruneAndPersist = new BoundedDurationDiagnostics();
  readonly telemetryTransaction = new BoundedDurationDiagnostics();

  begin(jobId: string, waitFor: CodexJobWaitMode, source: CodexJobWaitSource): void {
    this.started[waitFor] += 1;
    this.sources[this.sourceKey(source)] += 1;
    const counts = this.active.get(jobId) || {
      change: 0,
      terminal: 0,
      modelStatus: 0,
      dashboardCompletion: 0,
      internal: 0
    };
    counts[waitFor] += 1;
    counts[this.sourceKey(source)] += 1;
    this.active.set(jobId, counts);
  }

  finish(
    jobId: string,
    waitFor: CodexJobWaitMode,
    source: CodexJobWaitSource,
    outcome: {
      waitedMs: number;
      completed: boolean;
      timedOut: boolean;
      aborted: boolean;
      wakeReason?: CodexJobWakeReason;
    }
  ): void {
    this.waitedMs.record(outcome.waitedMs);
    if (outcome.completed) this.completed += 1;
    if (outcome.timedOut) this.timedOut += 1;
    if (outcome.aborted) this.hostAborts[this.sourceKey(source)] += 1;
    if (outcome.wakeReason) this.wakes[this.wakeKey(outcome.wakeReason)] += 1;

    const counts = this.active.get(jobId);
    if (!counts) return;
    counts[waitFor] = Math.max(0, counts[waitFor] - 1);
    const sourceKey = this.sourceKey(source);
    counts[sourceKey] = Math.max(0, counts[sourceKey] - 1);
    const total = counts.change + counts.terminal;
    if (total === 0) this.active.delete(jobId);
  }

  snapshot(recordedStatusWaitAborts: number): z.infer<typeof jobWaitDiagnosticsOutputSchema> {
    const activeJobs = [...this.active.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([jobId, counts]) => ({
        jobId,
        total: counts.change + counts.terminal,
        ...counts
      }));
    const active = activeJobs.reduce(
      (totals, entry) => ({
        total: totals.total + entry.total,
        modelStatus: totals.modelStatus + entry.modelStatus,
        dashboardCompletion: totals.dashboardCompletion + entry.dashboardCompletion,
        internal: totals.internal + entry.internal
      }),
      { total: 0, modelStatus: 0, dashboardCompletion: 0, internal: 0 }
    );
    const totalAborts = this.hostAborts.modelStatus +
      this.hostAborts.dashboardCompletion + this.hostAborts.internal;
    const totalWakes = this.wakes.progress + this.wakes.terminal + this.wakes.stateChange;
    return {
      defaultWaitMs: DEFAULT_CODEX_STATUS_WAIT_MS,
      exactStatusWaits: this.sources.modelStatus,
      started: {
        total: this.started.change + this.started.terminal,
        ...this.started
      },
      sources: { ...this.sources },
      completed: this.completed,
      timedOut: this.timedOut,
      waitedMs: this.waitedMs.snapshot(),
      wakes: { total: totalWakes, ...this.wakes },
      hostAborts: {
        total: totalAborts,
        ...this.hostAborts,
        recordedStatusWaitAborts
      },
      active: { ...active, jobs: activeJobs },
      maintenance: {
        pruneAndPersist: this.pruneAndPersist.snapshot(),
        telemetryTransaction: this.telemetryTransaction.snapshot()
      }
    };
  }

  private sourceKey(source: CodexJobWaitSource): keyof JobWaitDiagnostics["sources"] {
    return source === "model-status"
      ? "modelStatus"
      : source === "dashboard-completion"
        ? "dashboardCompletion"
        : "internal";
  }

  private wakeKey(reason: CodexJobWakeReason): keyof JobWaitDiagnostics["wakes"] {
    return reason === "state-change" ? "stateChange" : reason;
  }
}

type SteeringTerminalStatus = Extract<
  SteeringDeliveryRecord["status"],
  "delivered" | "not-delivered" | "uncertain"
>;

type SteeringMutationOutcome = {
  status: SteeringTerminalStatus;
  result: unknown;
};

type SteeringMutationFallbacks = {
  conflict: unknown;
  notDelivered: unknown;
  uncertain: unknown;
};

const ackPromiseConstructor=Promise;
const ackPromisePrototype=Promise.prototype;
const ackPromiseThen=Promise.prototype.then;
const ackPromiseSpecies=Object.getOwnPropertyDescriptor(Promise,Symbol.species)?.get;

export class CodexJobRegistry {
  private readonly authBoundary?: () => string | null;
  private readonly jobs = new Map<string, CodexJob>();
  private readonly jobsByAgent = new Map<string, Set<string>>();
  private readonly indexedJobAgent = new Map<string, string>();
  private readonly waiters = new Map<string, Set<(reason: CodexJobWakeReason) => void>>();
  private readonly terminalWaiters = new Map<string, Set<() => void>>();
  private activeJobObservationWaits = 0;
  private readonly lastWake = new Map<string, { version: number; reason: CodexJobWakeReason }>();
  private readonly scopeWaiters = new Map<string, Set<() => void>>();
  private readonly waitDiagnosticsTracker = new JobWaitDiagnostics();
  private readonly maxConcurrentJobs: number;
  private readonly ttlMs: number;
  private readonly maxJobs: number;
  private readonly maxResultBytes: number;
  private readonly staleAfterMs: number;
  private readonly stateStore?: BridgeStateStore;
  private readonly telemetry?: BridgeTelemetryService;
  private readonly projectionOnly: boolean;
  private readonly activityStore: BridgeStateStore;
  private readonly allowedRoots: string[];
  // HTTP requests and the native companion share one runtime admission gate.
  readonly runtimeAdmission: {
    acceptingNewJobs: boolean;
    pendingAdmissions: number;
    storageError?: BridgeStorageAdmissionError;
  } = { acceptingNewJobs: true, pendingAdmissions: 0 };
  private upstream?: CodexUpstream;
  private readonly recoverExecutions: boolean;
  private readonly recoveryAdmission?: () => Promise<void>;
  private recoverySessions?: SessionRegistry;
  private readonly recoveryJobs = new Set<string>();
  private recoveryStarted = false;
  private readonly terminations = new Map<
    string,
    { intentId: string; promise: Promise<CodexJob> }
  >();
  private readonly cancellationOperationsInFlight = new Map<
    string,
    { actionHash: string; promise: Promise<unknown> }
  >();
  private readonly steeringOperationsInFlight = new Map<
    string,
    { actionHash: string; promise: Promise<unknown> }
  >();
  // Raw steering input is needed transiently only to prevent Codex from
  // reflecting it into Bridge-owned progress, event, error, or Job-result
  // persistence. Keep it outside CodexJob so it is never serialized.
  private readonly steeringPromptRedactions = new Map<string, Set<string>>();
  private readonly interactionResponses = new Map<
    string,
    { responseHash: string; promise: Promise<CodexJob> }
  >();
  private readonly deferredSettlements = new Map<string, DeferredJobSettlement>();
  // Exact owner outcomes waiting for the existing Job terminal transaction.
  // This is observation only: it never advances the durable Job or releases
  // the owner's retained result before the transaction commits.
  private readonly pendingTerminalCommits = new WeakMap<
    CodexJob,
    { origin: JobTerminalOrigin; observedAt: number }
  >();
  private readonly deferredExecutions = new Map<
    string,
    { launch(): void; discard(): void }
  >();
  private readonly changeListeners = new Set<(
    reason?: CodexJobWakeReason, agentId?: string
  ) => void>();
  private threadController?: ThreadConnectionController;
  private maintenanceScheduler?: StateMaintenanceScheduler;
  private recoveryController?: AutomaticRecoveryController;
  private unsubscribeRecovery?: () => void;
  private projectedProjectRevision = -1;
  private retainedJobMaintenanceIterator?: IterableIterator<[string, CodexJob]>;
  private readonly retentionProtectedJobs = new Set<string>();
  private retainedJobTarget?: number;
  private retainedJobMaintenanceTimer?: NodeJS.Timeout;
  private stateMaintenanceClosed = false;
  private nonforcingPinned = false;
  private nonforcingUnknown = false;
  private nonforcingFenceComplete = false;
  private nonforcingFenceFailed = false;
  private readonly nonforcingConstructions = new Set<string>();
  private registryCallbacksInFlight = 0;
  private registryTransactionsInFlight = 0;
  private readonly unconfirmedJobCallbacks = new WeakSet<CodexJob>();
  private readonly executionAcknowledgements = new Map<CodexJob,{value?: unknown}>();
  private readonly nonforcingLateObservations = new Map<string, Array<{kind: string; value: unknown}>>();
  private nonforcingLateObservationCount = 0;

  get nonforcingShutdownPinned(): boolean {return this.nonforcingPinned;}

  /** Internal synchronous fence. It does not cancel Jobs or release writers. */
  pinNonforcingShutdown(): true {
    if (this.nonforcingPinned) {
      if (!this.nonforcingFenceComplete || this.nonforcingFenceFailed) throw new Error("NONFORCING_SHUTDOWN_PIN_UNCONFIRMED");
      return true;
    }
    this.nonforcingUnknown ||= this.stateMaintenanceClosed;
    this.nonforcingUnknown ||= this.registryTransactionsInFlight > 0;
    this.nonforcingUnknown ||= this.executionAcknowledgements.size > 0;
    this.nonforcingPinned = true;
    this.stateMaintenanceClosed = true;
    this.runtimeAdmission.acceptingNewJobs = false;
    for (const owner of [this.progressPersistenceQueue, this.threadController, this.recoveryController, this.maintenanceScheduler]) {
      if (!owner) continue;
      try {
        if (owner.pinNonforcingShutdown() !== true) this.nonforcingFenceFailed = true;
      } catch {this.nonforcingFenceFailed = true;}
    }
    if (this.progressPersistenceImmediateReset) clearImmediate(this.progressPersistenceImmediateReset);
    this.progressPersistenceImmediateReset = undefined;
    if (this.retainedJobMaintenanceTimer) clearTimeout(this.retainedJobMaintenanceTimer);
    this.retainedJobMaintenanceTimer = undefined;
    try {this.unsubscribeRecovery?.();} catch {this.nonforcingFenceFailed = true;}
    this.nonforcingFenceComplete = true;
    if (this.nonforcingFenceFailed) {
      this.nonforcingUnknown = true;
      throw new Error("NONFORCING_SHUTDOWN_PIN_UNCONFIRMED");
    }
    return true;
  }

  observeNonforcingExit(): ShutdownResult {
    if (!this.nonforcingPinned || !this.nonforcingFenceComplete || this.nonforcingFenceFailed || this.nonforcingUnknown || this.progressPersistenceQueue.nonforcingHistoryUncertain)
      return shutdownResult("uncertain");
    if (this.nonforcingConstructions.size) return shutdownResult("timeout",this.nonforcingConstructions.size);
    if (this.registryCallbacksInFlight + this.activeJobObservationWaits > 0)
      return shutdownResult("timeout",this.registryCallbacksInFlight + this.activeJobObservationWaits);
    const retained = this.deferredSettlements.size + this.deferredExecutions.size + this.terminations.size +
      this.cancellationOperationsInFlight.size + this.steeringOperationsInFlight.size + this.interactionResponses.size +
      this.nonforcingLateObservationCount + this.runtimeAdmission.pendingAdmissions;
    if (retained > 0 || this.progressPersistenceQueue.status().queued > 0) return shutdownResult("uncertain");
    const active = this.observedRunningCount();
    return combineShutdown([
      active > 0 ? shutdownResult("timeout", active) : shutdownResult("exited"),
      this.threadController?.observeNonforcingExit() ?? shutdownResult("exited"),
      this.recoveryController?.observeNonforcingExit() ?? shutdownResult("exited"),
      this.maintenanceScheduler?.observeNonforcingExit() ?? shutdownResult("exited")
    ]);
  }

  private assertNonforcingAdmission(): void {
    if (this.nonforcingPinned) throw new Error("NONFORCING_SHUTDOWN_PINNED");
  }

  private admittedData<T>(value: T): T {
    this.assertNonforcingAdmission();
    const captured = snapshotNonforcingData(value, () => this.nonforcingPinned);
    this.assertNonforcingAdmission();
    if (!captured.ok) {this.nonforcingUnknown = true;throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");}
    return captured.value;
  }

  private capturedExecutionError(original: unknown): {ok: true; error: Error} | {ok: false} {
    try {
      const isError = original instanceof Error;
      if (this.nonforcingPinned) return {ok:false};
      const terminalCommitFailed = original instanceof JobTerminalCommitError;
      if (this.nonforcingPinned) return {ok:false};
      let message: string | undefined;
      if (isError) {
        const field = Object.getOwnPropertyDescriptor(original,"message");
        if (this.nonforcingPinned || field && (!Object.hasOwn(field,"value") || typeof field.value !== "string")) return {ok:false};
        message = field?.value ?? "Error";
      } else if (original === null || original === undefined || ["string","number","boolean"].includes(typeof original))
        message = String(original);
      if (message === undefined) return {ok:false};
      const error = new Error(message);
      if (terminalCommitFailed) Object.setPrototypeOf(error,JobTerminalCommitError.prototype);
      return {ok:true,error};
    } catch {return {ok:false};}
  }

  private pinLateConstructedResource(owner: {pinNonforcingShutdown(): true}): boolean {
    if (!this.nonforcingPinned) return false;
    try {if (owner.pinNonforcingShutdown() !== true) this.nonforcingUnknown = true;}
    catch {this.nonforcingUnknown = true;}
    return true;
  }

  private retainNonforcingObservation(jobId: string, kind: string, value: unknown): void {
    if (this.nonforcingLateObservationCount >= 128) {this.nonforcingUnknown = true; return;}
    const retained = this.nonforcingLateObservations.get(jobId) ?? [];
    retained.push({kind, value});
    this.nonforcingLateObservations.set(jobId, retained);
    this.nonforcingLateObservationCount++;
  }
  private readonly progressPersistenceQueue: ScopeFairQueue<ProgressPersistenceSnapshot>;
  private readonly progressPersisted = new Map<
    string,
    { version: number; persistedAt: number }
  >();
  private progressPersistenceImmediateRemaining = PROGRESS_PERSISTENCE_IMMEDIATE_BUDGET;
  private progressPersistenceImmediateReset?: NodeJS.Immediate;

  configureAutomaticRecovery(options: ConstructorParameters<typeof AutomaticRecoveryController>[1]): void {
    this.assertNonforcingAdmission();
    if (this.projectionOnly) return;
    if (this.recoveryController || this.nonforcingConstructions.has("recovery")) return;
    this.nonforcingConstructions.add("recovery");
    try {
      this.recoveryController = new AutomaticRecoveryController(this.activityStore.automaticRecovery, options);
      if (this.pinLateConstructedResource(this.recoveryController)) return;
    } catch (error) {this.nonforcingUnknown = true;throw error;}
    finally {this.nonforcingConstructions.delete("recovery");}
    this.unsubscribeRecovery = this.subscribeChanges((reason, agentId) => {
      // Scope-only Dashboard notifications have no recovery identity. The
      // periodic keyset pass covers them without triggering a global survey.
      if (reason === "progress") return;
      if (agentId || reason) this.recoveryController?.schedule(agentId);
    });
    this.recoveryController.start();
  }

  sweepAutomaticRecovery(): Promise<void> { return this.recoveryController?.sweep() || Promise.resolve(); }

  configureThreadConnections(upstream: CodexUpstream, idleMs?: number): void {
    this.assertNonforcingAdmission();
    if (this.projectionOnly) return;
    if (this.threadController || this.nonforcingConstructions.has("thread")) return;
    this.nonforcingConstructions.add("thread");
    try {
      this.threadController = new ThreadConnectionController(this.activityStore.threadConnections, upstream, {
        idleMs, changed: () => this.publishRegistryChanges()
      });
      if (this.pinLateConstructedResource(this.threadController)) return;
    } catch (error) {this.nonforcingUnknown = true;throw error;}
    finally {this.nonforcingConstructions.delete("thread");}
    this.threadController.start();
  }

  configureStateMaintenance(intervalMs?: number): void {
    this.assertNonforcingAdmission();
    if (this.projectionOnly) return;
    if (this.maintenanceScheduler || this.stateMaintenanceClosed) return;
    const stateService = new InProcessOperationalStateService(this.activityStore);
    this.maintenanceScheduler = new StateMaintenanceScheduler(stateService, {
      intervalMs,
      changed: () => this.publishRegistryChanges(),
      shouldDefer: () => this.runtimeAdmission.pendingAdmissions > 0 || this.observedRunningCount() > 0,
      maxDeferMs: 30_000,
      command: slice => this.stateMaintenanceCommand(slice),
      completed: (command, result) => this.applyStateMaintenanceResult(command, result)
    });
    this.maintenanceScheduler.start();
    this.scheduleIdleRetainedJobMaintenance();
  }

  async closeThreadConnections(): Promise<void> {
    if (this.nonforcingPinned) {
      await this.recoveryController?.close();
      await this.threadController?.close();
      if (!this.observeNonforcingExit().exited) throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
      return;
    }
    this.stateMaintenanceClosed = true;
    this.progressPersistenceQueue.close();
    if (this.progressPersistenceImmediateReset) {
      clearImmediate(this.progressPersistenceImmediateReset);
      this.progressPersistenceImmediateReset = undefined;
    }
    this.unsubscribeRecovery?.();
    this.maintenanceScheduler?.close();
    if (this.retainedJobMaintenanceTimer) clearTimeout(this.retainedJobMaintenanceTimer);
    this.retainedJobMaintenanceTimer = undefined;
    await this.recoveryController?.close();
    await this.threadController?.close();
  }

  threadHandoff(threadId: string, action: "request" | "cancel" | "status"): ThreadConnectionRecord {
    this.assertNonforcingAdmission();
    const current = action === "request" ? this.threadController?.request(threadId)
      : action === "cancel" ? this.threadController?.cancel(threadId) : this.activityStore.threadConnections.get(threadId);
    if (!current) throw new Error("THREAD_HANDOFF_UNAVAILABLE: Connection management is not available for this conversation.");
    return current;
  }

  subscribeChanges(listener: (reason?: CodexJobWakeReason, agentId?: string) => void): () => void {
    this.assertNonforcingAdmission();
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  /** Internal application listener boundary; no MCP/native exposure. */
  publishApplicationChange(listener:()=>unknown):void {
    this.assertNonforcingAdmission();this.registryCallbacksInFlight++;
    try {
      const result=Reflect.apply(listener,undefined,[]);
      if(result!==undefined){this.nonforcingUnknown=true;this.retainNonforcingObservation('application-listener','listener-result',result);}
    }catch(error){this.nonforcingUnknown=true;this.retainNonforcingObservation('application-listener','listener-error',error);throw error;}
    finally{this.registryCallbacksInFlight--;}
  }
  /** Register first, then retain a returned cleanup capability if pin reenters. */
  registerApplicationSubscription(register:()=>unknown):(()=>void)|undefined {
    this.assertNonforcingAdmission();this.registryCallbacksInFlight++;
    try {
      const result=Reflect.apply(register,undefined,[]);
      if(this.nonforcingPinned || result!==undefined && typeof result!=='function') {
        this.nonforcingUnknown=true;this.retainNonforcingObservation('application-subscription','registration-result',result);
        throw new Error('STATE_APPLICATION_SUBSCRIPTION_UNCONFIRMED');
      }
      return result as (()=>void)|undefined;
    }catch(error){this.nonforcingUnknown=true;this.retainNonforcingObservation('application-subscription','registration-error',error);throw error;}
    finally{this.registryCallbacksInFlight--;}
  }
  releaseApplicationSubscriptions(subscriptions:Array<(()=>void)|undefined>):void {
    for(const unsubscribe of subscriptions) {
      if(!unsubscribe)continue;
      if(this.nonforcingPinned){this.retainNonforcingObservation('application-subscription','retained-unsubscribe',unsubscribe);continue;}
      this.publishApplicationChange(unsubscribe);
    }
  }

  private persistenceWarningShown = false;

  private recordPersistenceWarning(kind: string, error: unknown): void {
    if (this.nonforcingPinned) {this.retainNonforcingObservation("persistence",kind,error);return;}
    const captured = this.capturedExecutionError(error);
    if (!captured.ok || this.nonforcingPinned) {
      this.nonforcingUnknown = true;
      this.retainNonforcingObservation("persistence",kind,error);
      return;
    }
    if (!this.persistenceWarningShown) {
      console.error(`${kind}: ${captured.error.message}`);
      if (!this.nonforcingPinned) this.persistenceWarningShown = true;
    }
  }

  constructor(options: CodexJobRegistryOptions = {}) {
    this.authBoundary = options.authBoundary;
    const maxConcurrentJobs = options.maxConcurrentJobs ?? 30;
    if (
      !Number.isInteger(maxConcurrentJobs) ||
      maxConcurrentJobs < 1 ||
      maxConcurrentJobs > HARD_MAX_CONCURRENT_JOBS
    ) {
      throw new Error(
        `Codex job concurrency must be between 1 and ${HARD_MAX_CONCURRENT_JOBS}.`
      );
    }
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    const maxJobs = options.maxJobs ?? 100;
    if (!Number.isInteger(maxJobs) || maxJobs < maxConcurrentJobs) {
      throw new Error("Codex retained Job capacity must be an integer no lower than concurrency.");
    }
    this.maxJobs = maxJobs;
    this.maxResultBytes = options.maxResultBytes ?? 1024 * 1024;
    this.staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
    this.stateStore = options.stateStore;
    this.telemetry = options.telemetry;
    this.projectionOnly = options.projectionOnly === true;
    this.recoverExecutions = options.recoverExecutions === true;
    this.recoveryAdmission = options.recoveryAdmission;
    this.activityStore = options.stateStore || new BridgeStateStore({ file: ":memory:" });
    this.allowedRoots = options.allowedRoots || [];
    this.progressPersistenceQueue = new ScopeFairQueue<ProgressPersistenceSnapshot>({
      capacity: PROGRESS_PERSISTENCE_QUEUE_CAPACITY,
      perScopeCapacity: PROGRESS_PERSISTENCE_PER_PROJECT_CAPACITY,
      run: snapshot => this.persistDeferredProgress(snapshot)
    });
    this.load();
  }

  get persistent(): boolean {
    return Boolean(this.stateStore?.persistent);
  }

  get persistencePath(): string | null {
    return this.stateStore?.persistencePath || null;
  }

  get persistenceSchemaVersion(): number | null {
    return this.stateStore?.schemaVersion || null;
  }

  get bridgeInstanceId(): string | null {
    return this.stateStore?.bridgeInstanceId || null;
  }

  get activityPersistent(): boolean {
    return this.activityStore.persistent;
  }

  /** Internal composition hook for registry/admission transaction sharing. */
  get admissionStateStore(): BridgeStateStore {
    return this.activityStore;
  }

  get staleThresholdMs(): number {
    return this.staleAfterMs;
  }

  get size(): number {
    return this.jobs.size;
  }

  attachUpstream(upstream: CodexUpstream, sessions?: SessionRegistry): void {
    this.assertNonforcingAdmission();
    if (this.upstream && this.upstream !== upstream) {
      throw new Error("Codex job registry is already attached to another upstream.");
    }
    this.upstream = upstream;
    if (this.recoveryStarted || !this.recoverExecutions || !sessions || this.projectionOnly) return;
    this.recoveryStarted = true;
    this.recoverySessions = sessions;
    if (this.recoveryAdmission && (this.recoveryJobs.size > 0 ||
        [...this.jobs.values()].some(job => job.executionReceipt && isTerminalActivityJobStatus(job.status)))) {
      void this.recoveryAdmission().then(() => this.resumeAuthorizedRecoveries()).catch(() => {});
    } else {
      this.resumeAuthorizedRecoveries();
    }
  }

  /** A failed startup check leaves receipts dormant until a later successful admission. */
  resumeAuthorizedRecoveries(): void {
    if (this.nonforcingPinned) return;
    const upstream = this.upstream;
    const sessions = this.recoverySessions;
    if (!upstream || !sessions || !this.recoveryStarted || this.projectionOnly) return;
    const record = (job: CodexJob, threadId: string | undefined, lineage: { sessionId?: string; forkedFromThreadId?: string }) => {
      const agent = job.agentId ? this.getAgent(job.agentId) : undefined;
      if (!threadId || !agent || !job.executionDecision || !isCodexBackendKind(job.backendKind)) return;
      return recordAdmittedThread({ sessions, jobs: this, sessionDecision: job.sessionDecision,
        authBoundary: job.authBoundary,
        agent, threadId, scopeId: job.scopeId, cwd: job.cwd, sandbox: job.sandbox,
        ...(job.projectId && job.projectName ? { projectAdmission: { projectId: job.projectId, projectName: job.projectName } } : {}),
        selection: job.executionDecision.effectiveSelection, policyRevision: job.executionDecision.policyRevision,
        backendKind: job.backendKind, visibleInCodexApp: job.threadPersistence !== "ephemeral",
        contextMode: job.contextMode || "fresh", ...lineage });
    };
    for (const job of this.jobs.values()) {
      if (this.nonforcingPinned) return;
      if (job.executionReceipt && isTerminalActivityJobStatus(job.status)) {
        this.acknowledgeSettledExecution(job); continue;
      }
      if (!this.recoveryJobs.has(job.jobId)) continue;
      const recover = upstream.recoverExecution;
      if (this.nonforcingPinned) return;
      if (!recover) continue;
      const boundary = this.authBoundary?.();
      if (this.nonforcingPinned) return;
      if (this.authBoundary && job.authBoundary !== boundary) continue;
      this.recoveryJobs.delete(job.jobId);
      // A cancellation dispatch whose controller vanished is unconfirmed,
      // not proof of a stopped turn. Exact terminal replay settles the race.
      if (job.status === "terminating") job.status = "termination-failed";
      job.promise = (Reflect.apply(recover,upstream,[job.jobId,
        (progress: CodexProgress) => this.recordProgress(job, progress),
        (assignment: UpstreamWorkerAssignment) => {
          const captured = this.recordWorkerAssignment(job, assignment);
          if (captured && !this.nonforcingPinned) record(job, captured.threadId, captured);
        }]) as Promise<ToolResult>)
        .then(result => this.settleExecutionResult(job, result,
          value => record(job, extractThreadId(value), extractResultThreadLineage(value))))
        .catch(error => this.settleExecutionError(job, error))
        .finally(() => this.acknowledgeSettledExecution(job));
    }
  }

  private acknowledgeSettledExecution(job: CodexJob): void {
    if (this.nonforcingPinned || this.unconfirmedJobCallbacks.has(job) || this.executionAcknowledgements.has(job)) return;
    const observation: {value?: unknown} = {};
    this.executionAcknowledgements.set(job,observation);
    const failed = (error: unknown) => {
      this.nonforcingUnknown = true;
      this.unconfirmedJobCallbacks.add(job);
      this.retainNonforcingObservation(job.jobId,"execution-ack-error",error);
    };
    try {
      const assignment = this.jobAssignment(job);
      const currentBoundary = this.authBoundary?.();
      if (this.nonforcingPinned) return;
      if (this.authBoundary && job.authBoundary !== currentBoundary) {
        if (!assignment) return;
        const owns = this.upstream?.ownsRetainedResult;
        if (this.nonforcingPinned || typeof owns !== "function") return;
        const owned = Reflect.apply(owns,this.upstream,[job.jobId,assignment]);
        if (this.nonforcingPinned || owned !== true) return;
      }
      if (job.executionReceipt && isTerminalActivityJobStatus(job.status) && job.terminalOrigin) {
        const acknowledge = this.upstream?.acknowledgeExecution;
        if (this.nonforcingPinned) return;
        if (acknowledge) {
          observation.value = Reflect.apply(acknowledge,this.upstream,[job.jobId]);
          if (this.nonforcingPinned) return;
          if (observation.value !== undefined) {
            const promise = this.safeAcknowledgementPromise(observation.value);
            if (this.nonforcingPinned) return;
            if (!promise) {failed(observation.value);return;}
            Reflect.apply(ackPromiseThen,observation.value,[
              (value:unknown) => {
                if(value!==undefined){failed(value);return;}
                if (!this.nonforcingPinned) this.executionAcknowledgements.delete(job);
              },
              (error: unknown) => {failed(error);}
            ]);
            return;
          }
        }
      }
    } catch (error) {failed(error);throw error;}
    finally {
      // Outstanding native Promise ACKs keep their exact owner until resolution.
      if (!this.nonforcingPinned && !this.unconfirmedJobCallbacks.has(job) && observation.value === undefined)
        this.executionAcknowledgements.delete(job);
    }
  }

  private safeAcknowledgementPromise(value:unknown):boolean {
    try {
      if(!value || typeof value!=='object')return false;
      const own=Object.getOwnPropertyDescriptor(value,'constructor');
      if(this.nonforcingPinned || own)return false;
      const prototype=Object.getPrototypeOf(value);
      if(this.nonforcingPinned || prototype!==ackPromisePrototype)return false;
      const constructor=Object.getOwnPropertyDescriptor(ackPromisePrototype,'constructor');
      if(this.nonforcingPinned || constructor?.value!==ackPromiseConstructor || !Object.hasOwn(constructor,'value'))return false;
      const species=Object.getOwnPropertyDescriptor(ackPromiseConstructor,Symbol.species);
      return !this.nonforcingPinned && !!species && species.get===ackPromiseSpecies && species.set===undefined && !Object.hasOwn(species,'value');
    }catch{return false;}
  }

  private async settleExecutionResult(job: CodexJob, result: ToolResult, onComplete?: JobCompletionCallback): Promise<void> {
    return this.settleExecution(job, { kind: "resolved", result, onComplete });
  }

  private async settleExecutionError(job: CodexJob, error: unknown): Promise<void> {
    return this.settleExecution(job, { kind: "rejected", error });
  }

  private async settleExecution(job: CodexJob, settlement: DeferredJobSettlement): Promise<void> {
    const jobId=job.jobId;
    if (!this.nonforcingPinned && settlement.kind === "resolved") {
      const captured = snapshotNonforcingData(settlement.result, () => this.nonforcingPinned);
      if (!captured.ok) {
        this.nonforcingUnknown = true;
        if (!this.deferredSettlements.has(jobId)) this.deferredSettlements.set(jobId,settlement);
        else this.retainNonforcingObservation(jobId,"terminal-settlement",settlement);
        return;
      }
      const validated = CallToolResultSchema.safeParse(captured.value);
      if (!validated.success) {
        this.nonforcingUnknown = true;
        if (!this.deferredSettlements.has(jobId)) this.deferredSettlements.set(jobId,settlement);
        else this.retainNonforcingObservation(jobId,"terminal-settlement",settlement);
        return;
      }
      settlement = {...settlement,result:{...captured.value,content:validated.data.content}};
    }
    if (!this.nonforcingPinned && settlement.kind === "rejected") {
      const captured = this.capturedExecutionError(settlement.error);
      if (!captured.ok) {
        this.nonforcingUnknown = true;
        if (!this.deferredSettlements.has(jobId)) this.deferredSettlements.set(jobId,settlement);
        else this.retainNonforcingObservation(jobId,"terminal-settlement",settlement);
        return;
      }
      settlement = {...settlement,error:captured.error};
    }
    while (!this.stateMaintenanceClosed && !this.unconfirmedJobCallbacks.has(job)) {
      if (job.status === "terminating") {
        this.deferredSettlements.set(jobId, settlement);
        return;
      }
      try {
        if (settlement.kind === "resolved") this.settleResolvedJob(job, settlement.result, settlement.onComplete);
        else this.settleRejectedJob(job, settlement.error);
        this.pendingTerminalCommits.delete(job);
        return;
      }
      catch (error) {
        if (this.nonforcingPinned || this.unconfirmedJobCallbacks.has(job)) break;
        if (!job.executionReceipt || !(error instanceof JobTerminalCommitError)) throw error;
        if (settlement.kind === "resolved" && !this.pendingTerminalCommits.has(job)) {
          const turnStatus = extractResultTurnStatus(settlement.result);
          this.pendingTerminalCommits.set(job, {
            origin: turnStatus === "interrupted"
              ? "app-server-interrupted"
              : settlement.result.isError ? "upstream-failure" : "normal-completion",
            observedAt: Date.now()
          });
        }
        // Keep the exact outcome reserved at the owner until the DB commit
        // succeeds. A busy DB must not replace a completed turn's outcome.
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if (this.nonforcingPinned || this.unconfirmedJobCallbacks.has(job)) {
      if (!this.deferredSettlements.has(jobId)) this.deferredSettlements.set(jobId, settlement);
      else this.retainNonforcingObservation(jobId, "terminal-settlement", settlement);
      return;
    }
    this.pendingTerminalCommits.delete(job);
  }

  pendingTerminalCommit(job: CodexJob): { origin: JobTerminalOrigin; observedAt: number } | null {
    if (this.jobs.get(job.jobId) !== job || !job.executionReceipt || isTerminalActivityJobStatus(job.status)) return null;
    return this.pendingTerminalCommits.get(job) || null;
  }

  get(jobId: string): CodexJob | undefined {
    this.refreshProjectIdentities();
    return this.jobs.get(jobId);
  }

  list(limit = 20, offset = 0): CodexJob[] {
    this.refreshProjectIdentities();
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  listForScope(scopeId: string, limit = 20, offset = 0): CodexJob[] {
    return this.list(this.maxJobs)
      .filter((job) => job.scopeId === scopeId)
      .slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  }

  sizeForScope(scopeId: string): number {
    return [...this.jobs.values()].filter((job) => job.scopeId === scopeId).length;
  }

  runningCount(scopeId?: string): number {
    return this.observedRunningCount(scopeId);
  }

  /** Health observations must not trigger retention cleanup or SQLite writes. */
  observedRunningCount(scopeId?: string): number {
    return [...this.jobs.values()].filter(
      (job) => isActiveActivityJobStatus(job.status) && (!scopeId || job.scopeId === scopeId)
    ).length;
  }

  findRequest(scopeId: string, requestId: string, requestHash: string): CodexJob | undefined {
    const job = [...this.jobs.values()].find(
      (entry) => entry.scopeId === scopeId && entry.requestId === requestId
    );
    if (job && job.requestHashVersion >= 2 && job.requestHash !== requestHash) {
      throw new Error("requestId was already used for a different Codex task in this scope.");
    }
    if (job) this.assertCurrentJobOwner(job);
    return job;
  }

  private assertCurrentJobOwner(job: CodexJob): void {
    this.assertNonforcingAdmission();
    const boundary = this.authBoundary?.();
    this.assertNonforcingAdmission();
    if (this.authBoundary && job.authBoundary !== boundary)
      throw new Error("CODEX_AUTH_JOB_BOUNDARY: This Job belongs to another or unverified authentication connection.");
  }

  private jobAssignment(job: CodexJob): UpstreamWorkerAssignment | null {
    if (!isCodexBackendKind(job.backendKind) || !job.workerId ||
        job.workerGeneration === undefined || !job.upstreamRequestId || !job.threadId) return null;
    return { backendKind: job.backendKind, workerId: job.workerId,
      workerGeneration: job.workerGeneration, upstreamRequestId: job.upstreamRequestId,
      threadId: job.threadId };
  }

  /** Existing controls must still target the original live request after login changes. */
  private assertOriginalJobControl(job: CodexJob): void {
    this.assertNonforcingAdmission();
    const boundary = this.authBoundary?.();
    this.assertNonforcingAdmission();
    if (!this.authBoundary || job.authBoundary === boundary) return;
    const assignment = this.jobAssignment(job);
    if (isActiveActivityJobStatus(job.status) && job.trackingState === "connected" && assignment) {
      const owns = this.upstream?.ownsActiveExecution;
      this.assertNonforcingAdmission();
      if (typeof owns === "function") {
        const owned = Reflect.apply(owns,this.upstream,[job.jobId,assignment]);
        this.assertNonforcingAdmission();
        if (owned === true) return;
      }
    }
    throw new Error("CODEX_AUTH_JOB_BOUNDARY: This Job belongs to another or unverified authentication connection.");
  }

  private assertCancellationTargetOwner(target: { jobId?: string; activityId: string }): void {
    for (const job of this.jobs.values()) {
      if (target.jobId === job.jobId || !target.jobId && job.activityId === target.activityId) {
        this.assertOriginalJobControl(job);
      }
    }
  }

  peekRequest(scopeId: string, requestId: string): CodexJob | undefined {
    return [...this.jobs.values()].find(
      (entry) => entry.scopeId === scopeId && entry.requestId === requestId
    );
  }

  isThreadActive(threadId: string): boolean {
    const exclusiveKey = threadExclusiveKey(threadId);
    return [...this.jobs.values()].some(
      (job) => isActiveActivityJobStatus(job.status) && job.exclusiveKeys.includes(exclusiveKey)
    );
  }

  listForActivity(activityId: string): CodexJob[] {
    this.refreshProjectIdentities();
    return [...this.jobs.values()]
      .filter((job) => job.activityId === activityId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listForThread(threadId: string, scopeId?: string): CodexJob[] {
    this.refreshProjectIdentities();
    return [...this.jobs.values()]
      .filter((job) => job.threadId === threadId && (!scopeId || job.scopeId === scopeId))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  listForAgent(agentId: string): CodexJob[] {
    this.refreshProjectIdentities();
    return [...(this.jobsByAgent.get(agentId) || [])]
      .map(id => this.jobs.get(id))
      .filter((job): job is CodexJob => job !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Compare live observations without repeating a full retention sweep for
   * every Agent or probe completion. Projection/maintenance entry points prune
   * once; safety-sensitive lookups keep using get/listForAgent. */
  observedLatestJobForAgent(agentId: string): CodexJob | undefined {
    let latest: CodexJob | undefined;
    for (const id of this.jobsByAgent.get(agentId) || []) {
      const job = this.jobs.get(id);
      if (job && (!latest || job.createdAt >= latest.createdAt)) latest = job;
    }
    return latest;
  }

  private setIndexedJob(job: CodexJob): void {
    this.jobs.set(job.jobId, job);
    const previousAgent = this.indexedJobAgent.get(job.jobId);
    if (previousAgent && previousAgent !== job.agentId) {
      const ids = this.jobsByAgent.get(previousAgent);
      ids?.delete(job.jobId);
      if (ids?.size === 0) this.jobsByAgent.delete(previousAgent);
      this.indexedJobAgent.delete(job.jobId);
    }
    if (job.agentId) {
      const ids = this.jobsByAgent.get(job.agentId) || new Set<string>();
      ids.add(job.jobId);
      this.jobsByAgent.set(job.agentId, ids);
      this.indexedJobAgent.set(job.jobId, job.agentId);
    }
  }

  private deleteIndexedJob(jobId: string): void {
    this.jobs.delete(jobId);
    const agentId = this.indexedJobAgent.get(jobId);
    if (agentId) {
      const ids = this.jobsByAgent.get(agentId);
      ids?.delete(jobId);
      if (ids?.size === 0) this.jobsByAgent.delete(agentId);
      this.indexedJobAgent.delete(jobId);
    }
  }

  activityTransaction<T>(operation: () => T): T {
    this.assertNonforcingAdmission();
    this.registryTransactionsInFlight++;
    try {
      return this.activityStore.transaction(() => {
        this.assertNonforcingAdmission();
        const result = operation();
        this.assertNonforcingAdmission();
        return result;
      });
    } finally {this.registryTransactionsInFlight--;}
  }

  createActivity(input: CreateActivityInput): BridgeActivity {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    const activity = this.activityStore.createActivity(input);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  getActivity(activityId: string): BridgeActivity | undefined {
    return this.activityStore.getActivity(activityId);
  }

  getActivityProjectAdmission(activityId: string): ActivityProjectAdmission | undefined {
    return this.activityStore.getActivityProjectAdmission(activityId);
  }

  listActivities(scopeId: string, limit = 100, offset = 0): BridgeActivity[] {
    return this.activityStore.listActivities(scopeId, limit, offset);
  }

  listAllActivities(limit = 100, offset = 0): BridgeActivity[] {
    return this.activityStore.listActivities(undefined, limit, offset);
  }

  activityCount(scopeId?: string): number {
    return this.activityStore.countActivities(scopeId);
  }

  createAgent(input: { scopeId: string; agentName: string }): BridgeAgent {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    const agent = this.activityStore.createAgent(input);
    this.notifyScope(agent.scopeId, agent.agentId);
    return agent;
  }

  getAgent(agentId: string): BridgeAgent | undefined {
    return this.activityStore.getAgent(agentId);
  }

  getAgentForThread(threadId: string): BridgeAgent | undefined {
    return this.activityStore.getAgentForThread(threadId);
  }

  listAgents(scopeId: string, limit = 100, offset = 0): BridgeAgent[] {
    return this.activityStore.listAgents(scopeId, limit, offset);
  }

  listAllAgents(limit = 100, offset = 0): BridgeAgent[] {
    return this.activityStore.listAgents(undefined, limit, offset);
  }

  agentCount(scopeId?: string): number {
    return this.activityStore.countAgents(scopeId);
  }

  orphanedAgentCount(scopeId?: string): number {
    return this.activityStore.countAgentsByLifecycle("orphaned", scopeId);
  }

  listCurrentAgentThreads(): BridgeAgentThread[] {
    return this.activityStore.listCurrentAgentThreads();
  }

  currentAgentThread(agentId: string): BridgeAgentThread | undefined {
    return this.activityStore.currentAgentThread(agentId);
  }

  listAgentThreads(agentId: string): BridgeAgentThread[] {
    return this.activityStore.listAgentThreads(agentId);
  }

  listActivityAgentAssignments(activityId?: string, agentId?: string): ActivityAgentAssignment[] {
    return this.activityStore.listActivityAgentAssignments(activityId, agentId);
  }

  listScopeActivityAgentAssignments(scopeId: string): ActivityAgentAssignment[] {
    return this.activityStore.listScopeActivityAgentAssignments(scopeId);
  }

  assignAgent(input: {
    activityId: string;
    agentId: string;
    contextMode: AgentContextMode;
    role?: string;
  }): ActivityAgentAssignment {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    const assignment = this.activityStore.assignAgent(input);
    const agent = this.activityStore.getAgent(input.agentId);
    if (agent) this.notifyScope(agent.scopeId, agent.agentId);
    return assignment;
  }

  releaseAgentAssignment(activityId: string, agentId: string): ActivityAgentAssignment | undefined {
    this.assertNonforcingAdmission();
    const assignment = this.activityStore.releaseAgentAssignment(activityId, agentId);
    const agent = this.activityStore.getAgent(agentId);
    if (agent) this.notifyScope(agent.scopeId, agent.agentId);
    return assignment;
  }

  detachIdleAgentAssignment(input: {
    activityId: string;
    agentId: string;
    expectedAgentVersion: number;
  }) {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    const detached = this.activityStore.detachIdleAgentAssignment(input);
    this.notifyScope(detached.agent.scopeId, detached.agent.agentId);
    return detached;
  }

  linkAgentThread(input: {
    agentId: string;
    threadId: string;
    sessionId?: string;
    projectId?: string;
    projectName?: string;
    backendKind: string;
    cwd: string;
    sandbox: string;
    contextMode: AgentContextMode;
    forkedFromThreadId?: string;
  }): BridgeAgentThread {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    const thread = this.activityStore.linkAgentThread(input);
    this.notifyScope(thread.scopeId, input.agentId);
    return thread;
  }

  setAgentExecutionState(
    agentId: string,
    lifecycle: "idle" | "active" | "waiting-input" | "orphaned",
    options: { currentJobId?: string; orphanedReason?: string } = {}
  ): BridgeAgent {
    this.assertNonforcingAdmission();
    options = this.admittedData(options);
    const agent = this.activityStore.setAgentExecutionState(agentId, lifecycle, options);
    this.notifyScope(agent.scopeId, agent.agentId);
    return agent;
  }

  renameAgent(agentId: string, name: string): BridgeAgent {
    this.assertNonforcingAdmission();
    const agent = this.activityStore.renameAgent(agentId, name);
    this.notifyScope(agent.scopeId, agent.agentId);
    return agent;
  }

  getAgentMutation(scopeId: string, requestId: string): { actionHash: string; result: unknown } | undefined {
    return this.activityStore.getAgentMutation(scopeId, requestId);
  }

  acknowledgeHistoryIssue(jobId: string, scopeId: string): void {
    this.assertNonforcingAdmission();
    this.activityStore.workHistory.acknowledge(jobId);
    this.notifyScope(scopeId);
  }

  reviewHistoryIssues(targets: Array<{jobId:string;scopeId:string}>, acknowledged: boolean): void {
    this.assertNonforcingAdmission();
    targets = this.admittedData(targets);
    this.activityStore.transaction(() => {
      for (const target of targets) this.activityStore.workHistory.setAcknowledged(target.jobId, acknowledged);
    });
    for (const scope of new Set(targets.map(target => target.scopeId))) this.notifyScope(scope);
  }

  resolveHistoryRuntimeProblem(agent: BridgeAgent, revision: string): void {
    this.assertNonforcingAdmission();
    agent = this.admittedData(agent);
    this.activityStore.transaction(() => this.activityStore.workHistory.resolveRuntimeProblem(agent.agentId, revision));
    this.notifyScope(agent.scopeId, agent.agentId);
  }

  recordAgentMutation(scopeId: string, requestId: string, actionHash: string, result: unknown): void {
    this.assertNonforcingAdmission();
    result = this.admittedData(result);
    this.activityStore.recordAgentMutation(scopeId, requestId, actionHash, result);
  }

  getSteeringDelivery(
    scopeId: string,
    requestId: string
  ): SteeringDeliveryRecord | undefined {
    return this.activityStore.getSteeringDelivery(scopeId, requestId);
  }

  listSteeringDeliveries(scopeId?: string): SteeringDeliveryRecord[] {
    return this.activityStore.listSteeringDeliveries(scopeId);
  }

  markSteeringDeliveryDispatching(
    scopeId: string,
    requestId: string,
    actionHash: string
  ): SteeringDeliveryRecord {
    this.assertNonforcingAdmission();
    return this.activityStore.markSteeringDeliveryDispatching(
      scopeId,
      requestId,
      actionHash
    );
  }

  async runSteeringMutation(
    input: BeginSteeringDeliveryInput,
    fallbacks: SteeringMutationFallbacks,
    operation: () => Promise<SteeringMutationOutcome>
  ): Promise<unknown> {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    fallbacks = this.admittedData(fallbacks);
    const key = `${input.scopeId}\0${input.requestId}`;
    const active = this.steeringOperationsInFlight.get(key);
    if (active) {
      if (active.actionHash !== input.actionHash) return fallbacks.conflict;
      return active.promise;
    }

    const replay = this.getSteeringDelivery(input.scopeId, input.requestId);
    if (replay) {
      if (replay.actionHash !== input.actionHash) return fallbacks.conflict;
      if (replay.result !== undefined) return replay.result;
      const status: SteeringTerminalStatus = replay.status === "prepared"
        ? "not-delivered"
        : "uncertain";
      const result = status === "not-delivered"
        ? fallbacks.notDelivered
        : fallbacks.uncertain;
      if (replay.status === "prepared" || replay.status === "dispatching") {
        try {
          this.activityStore.completeSteeringDelivery(
            input.scopeId,
            input.requestId,
            input.actionHash,
            status,
            result
          );
        } catch {
          // The returned result remains fail-closed. A later exact replay sees
          // the same durable prepared/dispatching boundary and cannot resend.
        }
      }
      return result;
    }

    let prepared: SteeringDeliveryRecord;
    try {
      prepared = this.activityStore.beginSteeringDelivery(input);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("STEERING_REQUEST_CONFLICT:")) {
        return fallbacks.conflict;
      }
      throw error;
    }
    if (prepared.status !== "prepared") {
      if (prepared.actionHash !== input.actionHash) return fallbacks.conflict;
      if (prepared.result !== undefined) return prepared.result;
      return prepared.status === "dispatching" ? fallbacks.uncertain : fallbacks.notDelivered;
    }

    this.assertNonforcingAdmission();
    const promise = Promise.resolve()
      .then(() => {this.assertNonforcingAdmission(); return operation();})
      .then((outcome) => {
        if (this.nonforcingPinned) {this.retainNonforcingObservation(key, "steering-outcome", outcome); return fallbacks.uncertain;}
        const captured = snapshotNonforcingData(outcome, () => this.nonforcingPinned);
        if (!captured.ok) {
          this.nonforcingUnknown = true;
          this.retainNonforcingObservation(key,"steering-outcome",outcome);
          return fallbacks.uncertain;
        }
        outcome = captured.value;
        try {
          this.activityStore.completeSteeringDelivery(
            input.scopeId,
            input.requestId,
            input.actionHash,
            outcome.status,
            outcome.result
          );
          return outcome.result;
        } catch {
          if (outcome.status === "delivered") return fallbacks.uncertain;
          return outcome.result;
        }
      })
      .catch(() => {
        if (this.nonforcingPinned) return fallbacks.uncertain;
        const current = this.getSteeringDelivery(input.scopeId, input.requestId);
        const status: SteeringTerminalStatus = current?.status === "prepared"
          ? "not-delivered"
          : "uncertain";
        const result = status === "not-delivered"
          ? fallbacks.notDelivered
          : fallbacks.uncertain;
        try {
          this.activityStore.completeSteeringDelivery(
            input.scopeId,
            input.requestId,
            input.actionHash,
            status,
            result
          );
        } catch {
          // Preserve fail-closed delivery semantics even if the audit write is
          // unavailable; the durable non-terminal row prevents silent resend.
        }
        return result;
      });
    this.steeringOperationsInFlight.set(key, { actionHash: input.actionHash, promise });
    try {
      return await promise;
    } finally {
      if (!this.nonforcingPinned && this.steeringOperationsInFlight.get(key)?.promise === promise) {
        this.steeringOperationsInFlight.delete(key);
      }
    }
  }

  getCancellationOperation(
    scopeId: string,
    requestId: string
  ): CancellationOperationRecord | undefined {
    return this.activityStore.getCancellationOperation(scopeId, requestId);
  }

  listCancellationOperations(scopeId?: string): CancellationOperationRecord[] {
    return this.activityStore.listCancellationOperations(scopeId);
  }

  async runCancellationMutation(
    scopeId: string,
    requestId: string,
    actionHash: string,
    operation: () => Promise<unknown>
  ): Promise<unknown> {
    this.assertNonforcingAdmission();
    const key = `${scopeId}\0${requestId}`;
    const active = this.cancellationOperationsInFlight.get(key);
    if (active) {
      if (active.actionHash !== actionHash) {
        throw new Error(
          "CANCELLATION_REQUEST_CONFLICT: requestId is already executing a different cancellation payload in this scope."
        );
      }
      return active.promise;
    }
    const replay = this.getCancellationOperation(scopeId, requestId);
    if (replay) {
      if (replay.actionHash !== actionHash) {
        throw new Error(
          "CANCELLATION_REQUEST_CONFLICT: requestId was already used for a different cancellation payload in this scope."
        );
      }
      if (replay.status === "completed") return replay.result;
      if (replay.status === "failed") {
        throw new Error(cancellationFailureMessage(replay.result));
      }
      throw new Error(
        "CANCELLATION_OPERATION_INCOMPLETE: A durable intent exists without a recorded outcome; inspect authoritative status before using a new requestId."
      );
    }
    this.assertNonforcingAdmission();
    const promise = Promise.resolve()
      .then(() => {this.assertNonforcingAdmission(); return operation();})
      .catch((error) => {
        if (this.nonforcingPinned) throw error;
        const durable = this.getCancellationOperation(scopeId, requestId);
        if (durable?.status === "recorded") {
          for (const intent of this.listCancellationIntents({ scopeId, requestId })) {
            if (intent.status === "recorded" || intent.status === "dispatched") {
              this.setCancellationIntentStatus(intent.intentId, "failed");
            }
          }
          this.completeCancellationOperation(
            scopeId,
            requestId,
            {
              ok: false,
              code: "CANCELLATION_FAILED",
              message: boundedCancellationFailureMessage(error)
            },
            "failed"
          );
        }
        throw error;
      });
    this.cancellationOperationsInFlight.set(key, { actionHash, promise });
    try {
      return await promise;
    } finally {
      if (!this.nonforcingPinned && this.cancellationOperationsInFlight.get(key)?.promise === promise) {
        this.cancellationOperationsInFlight.delete(key);
      }
    }
  }

  beginCancellationOperation(input: BeginCancellationOperationInput): {
    operation: CancellationOperationRecord;
    intent: CancellationIntentRecord;
  } {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    this.assertCancellationTargetOwner(input.target);
    this.assertNonforcingAdmission();
    const result = this.activityStore.beginCancellationOperation(input);
    this.notifyScope(result.operation.scopeId);
    return result;
  }

  createCancellationIntent(input: CreateCancellationIntentInput): CancellationIntentRecord {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    this.assertCancellationTargetOwner(input.target);
    this.assertNonforcingAdmission();
    const intent = this.activityStore.createCancellationIntent(input);
    this.notifyScope(intent.scopeId);
    return intent;
  }

  getCancellationIntent(intentId: string): CancellationIntentRecord | undefined {
    return this.activityStore.getCancellationIntent(intentId);
  }

  setCancellationIntentStatus(
    intentId: string,
    status: "dispatched" | "succeeded" | "failed" | "no-op"
  ): CancellationIntentRecord {
    this.assertNonforcingAdmission();
    const intent = this.activityStore.setCancellationIntentStatus(intentId, status);
    this.notifyScope(intent.scopeId);
    return intent;
  }

  completeCancellationOperation(
    scopeId: string,
    requestId: string,
    result: unknown,
    status: "completed" | "failed" = "completed"
  ): CancellationOperationRecord {
    this.assertNonforcingAdmission();
    result = this.admittedData(result);
    return this.activityStore.completeCancellationOperation(
      scopeId,
      requestId,
      result,
      status
    );
  }

  listCancellationIntents(options: {
    scopeId?: string;
    requestId?: string;
    jobId?: string;
    activityId?: string;
  } = {}): CancellationIntentRecord[] {
    return this.activityStore.listCancellationIntents(options);
  }

  recordTransportObservation(input: Parameters<BridgeStateStore["recordTransportObservation"]>[0]) {
    if (this.nonforcingPinned) {this.retainNonforcingObservation("transport","transport",input);return undefined;}
    input = this.admittedData(input);
    try {
      return this.telemetry
        ? this.telemetry.recordTransportObservation(input, this.activityStore.bridgeInstanceId)
        : this.activityStore.recordTransportObservation(input);
    } catch (error) {
      if (process.env.CODEX_MCP_BRIDGE_DEBUG === "1") {
        console.error("Could not persist transport observation:", error);
      }
      return undefined;
    }
  }

  listTransportObservations(
    kind?: Parameters<BridgeStateStore["listTransportObservations"]>[0]
  ) {
    return this.telemetry
      ? this.telemetry.listTransportObservations(kind)
      : this.activityStore.listTransportObservations(kind);
  }

  waitDiagnostics(): z.infer<typeof jobWaitDiagnosticsOutputSchema> {
    return this.waitDiagnosticsTracker.snapshot(
      this.listTransportObservations("status-wait-aborted").length
    );
  }

  progressPersistenceStatus(): ProgressPersistenceStatus {
    return {
      ...this.progressPersistenceQueue.status(),
      immediateBudget: PROGRESS_PERSISTENCE_IMMEDIATE_BUDGET,
      immediateRemaining: this.progressPersistenceImmediateRemaining
    };
  }

  stateMaintenanceDiagnostics(): z.infer<typeof diagnosticsOutputSchema>["performance"]["stateMaintenance"] {
    return [...(this.maintenanceScheduler?.diagnostics() || [])];
  }

  getScopeVersion(scopeId: string): number {
    return this.activityStore.getScopeVersion(scopeId);
  }

  listActivityEvents(activityId: string) {
    return this.activityStore.listActivityEvents(activityId);
  }

  listJobEvents(jobId: string) {
    return this.activityStore.listJobEvents(jobId);
  }

  listPendingCompletionOutbox(scopeId: string, limit = 20) {
    return this.activityStore.listPendingCompletionOutbox(scopeId, limit);
  }

  listPendingCompletionActivityIds(scopeId: string): string[] {
    return this.activityStore.listPendingCompletionActivityIds(scopeId);
  }

  claimNativeCompletionNotifications(limit: number, leaseOwner: string) {
    return this.activityTransaction(() =>
      this.activityStore.listPendingNotifyCompletionOutbox(limit).flatMap((candidate) => {
        const record = this.activityStore.claimCompletionOutbox(
          candidate.outboxId,
          candidate.scopeId,
          leaseOwner
        );
        return record?.channel === "notify" ? [record] : [];
      })
    );
  }

  markNativeCompletionNotificationsDelivered(outboxIds: number[], leaseOwner: string) {
    const records = this.activityTransaction(() =>
      [...new Set(outboxIds)].sort((a, b) => a - b).map((outboxId) => {
        const record = this.activityStore.getCompletionOutbox(outboxId);
        if (!record || record.channel !== "notify") {
          throw new Error("Unknown native completion notification.");
        }
        return this.activityStore.markCompletionOutboxDelivered(
          record.outboxId,
          record.scopeId,
          leaseOwner
        );
      })
    );
    for (const scopeId of new Set(records.map((record) => record.scopeId))) {
      this.notifyScope(scopeId);
    }
    return records;
  }

  releaseNativeCompletionNotifications(outboxIds: number[], leaseOwner: string): void {
    const scopes = this.activityTransaction(() => {
      const affected = new Set<string>();
      for (const outboxId of [...new Set(outboxIds)].sort((a, b) => a - b)) {
        const record = this.activityStore.getCompletionOutbox(outboxId);
        if (!record || record.channel !== "notify") continue;
        this.activityStore.releaseCompletionOutbox(record.outboxId, record.scopeId, leaseOwner);
        affected.add(record.scopeId);
      }
      return affected;
    });
    for (const scopeId of scopes) this.notifyScope(scopeId);
  }

  setActivityPolicy(
    activityId: string,
    policy: {
      handoffPolicy?: ActivityHandoffPolicy;
      completionTrigger?: ActivityCompletionTrigger;
      kind?: ActivityKind;
    }
  ): BridgeActivity {
    this.assertNonforcingAdmission();
    policy = this.admittedData(policy);
    const activity = this.activityStore.setActivityPolicy(activityId, policy);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  sealActivity(activityId: string): BridgeActivity {
    this.assertNonforcingAdmission();
    const activity = this.activityStore.sealActivity(activityId);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  completeActivity(activityId: string, reason?: string): BridgeActivity {
    this.assertNonforcingAdmission();
    const activity = this.activityStore.completeActivity(activityId, reason);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  abandonActivity(activityId: string, reason?: string): BridgeActivity {
    this.assertNonforcingAdmission();
    const activity = this.activityStore.abandonActivity(activityId, reason);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  cancelActivity(activityId: string, reason?: string): BridgeActivity {
    this.assertNonforcingAdmission();
    const activity = this.activityStore.cancelActivity(activityId, reason);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  beginActivityTermination(activityId: string, reason?: string): BridgeActivity {
    this.assertNonforcingAdmission();
    const activity = this.activityStore.beginActivityTermination(activityId, reason);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  startActivityVerification(activityId: string): BridgeActivity {
    this.assertNonforcingAdmission();
    const activity = this.activityStore.startActivityVerification(activityId);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  passActivityVerification(
    activityId: string,
    evidence: ActivityVerificationEvidence
  ): BridgeActivity {
    this.assertNonforcingAdmission();
    evidence = this.admittedData(evidence);
    const activity = this.activityStore.passActivityVerification(activityId, evidence);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  failActivityVerification(activityId: string, reason: string): BridgeActivity {
    this.assertNonforcingAdmission();
    const activity = this.activityStore.failActivityVerification(activityId, reason);
    this.notifyScope(activity.scopeId);
    return activity;
  }

  start(
    input: CodexJobStartInput,
    run: (
      onProgress: (progress: CodexProgress) => void,
      onAssigned: (assignment: UpstreamWorkerAssignment) => void
    ) => Promise<ToolResult>,
    onComplete?: JobCompletionCallback,
    activeLimit = this.maxConcurrentJobs,
    rejectIfSelectionActive = false,
    onAssigned?: (assignment: UpstreamWorkerAssignment, job: CodexJob) => void,
    deferExecution = false
  ): CodexJob {
    this.assertNonforcingAdmission();
    input = this.admittedData(input);
    const replay = this.findRequest(input.scopeId, input.requestId, input.requestHash);
    if (replay) return replay;
    this.activityStore.threadConnections.assertAdmission(input.agentId, input.sessionDecision.threadId || input.sourceThreadId);
    if (!Number.isInteger(activeLimit) || activeLimit < 1 || activeLimit > this.maxConcurrentJobs) {
      throw new Error(`Invalid active Codex job limit: ${activeLimit}.`);
    }
    const running = [...this.jobs.values()].filter((job) => isActiveActivityJobStatus(job.status));
    if (running.length >= activeLimit) {
      throw new Error(`Too many Codex jobs are running. The configured limit is ${activeLimit}.`);
    }
    const conflictingKey = input.exclusiveKeys.find((key) =>
      running.some((job) => job.exclusiveKeys.includes(key))
    );
    if (conflictingKey?.startsWith("thread:")) {
      throw new Error("A Codex job is already running for this Codex thread.");
    }
    if (conflictingKey?.startsWith("agent:")) {
      throw new Error("AGENT_BUSY: This bridge Agent already has an active turn. Wait or choose another Agent.");
    }
    if (
      rejectIfSelectionActive &&
      input.selectionKey &&
      running.some((job) => job.selectionKey === input.selectionKey)
    ) {
      throw new Error(
        "A compatible Codex context is still starting or running for this Activity. Wait for it, or create another Agent with contextMode='fresh' for deliberate parallel work."
      );
    }
    if (this.retainedJobAdmissionReservations() >= this.maxJobs) {
      this.requestRetainedJobHeadroom();
      throw new Error(
        "JOB_RETENTION_CAPACITY: Retained Job capacity is reserved by active or not-yet-classified terminal work. Retry after foreground work settles and bounded maintenance catches up."
      );
    }
    const now = Date.now();
    const currentAuthBoundary = this.authBoundary?.();
    if (this.authBoundary && !currentAuthBoundary) {
      throw new Error("CODEX_AUTH_JOB_BOUNDARY: Confirm the current authentication owner before starting a Job.");
    }
    const supportsRecovery = this.upstream?.supportsExecutionRecovery;
    this.assertNonforcingAdmission();
    const executionReceipt = supportsRecovery ? Reflect.apply(supportsRecovery,this.upstream,[]) === true : false;
    this.assertNonforcingAdmission();
    const job: CodexJob = {
      ...input,
      ...(currentAuthBoundary ? { authBoundary: currentAuthBoundary } : {}),
      activityId: input.activityId || randomUUID(),
      threadId: input.sessionDecision.threadId,
      backendKind: input.backendKind || "app-server",
      trackingState: "liveness-unknown",
      bridgeInstanceId: this.activityStore.bridgeInstanceId,
      requestHashVersion: input.requestHashVersion || CURRENT_TASK_REQUEST_HASH_VERSION,
      completionDeliveryPolicy: input.completionDeliveryPolicy || "live-card",
      jobId: randomUUID(),
      executionReceipt,
      createdAt: now,
      updatedAt: now,
      lastProgressAt: now,
      version: 1,
      status: "running",
      publicEvents: [],
      pendingInteractions: [],
      promise: Promise.resolve()
    };
    job.approvedFollowups = issueApprovedFollowups(job.jobId, job.approvedFollowups);
    this.assertNonforcingAdmission();
    this.setIndexedJob(job);
    try {
      this.persistJob(job);
    } catch (error) {
      this.deleteIndexedJob(job.jobId);
      throw error;
    }
    const execute = () => Promise.resolve()
      .then(() => {
        this.assertNonforcingAdmission();
        return withExecutionIdentity(job.jobId, () => run(
          (progress) => this.recordProgress(job, progress),
          (assignment) => {
            const captured = this.recordWorkerAssignment(job, assignment);
            if (!captured || this.nonforcingPinned) return;
            if (!onAssigned) return;
            this.registryCallbacksInFlight++;
            try {
              const returned = Reflect.apply(onAssigned,undefined,[captured,job]);
              if (returned !== undefined) {
                this.nonforcingUnknown = true;
                this.unconfirmedJobCallbacks.add(job);
                this.retainNonforcingObservation(job.jobId,"assignment-callback-result",returned);
              }
            } catch (error) {
              this.nonforcingUnknown = true;
              this.unconfirmedJobCallbacks.add(job);
              this.retainNonforcingObservation(job.jobId,"assignment-callback-error",error);
            } finally {this.registryCallbacksInFlight--;}
          }
        ));
      })
      .then((result) => {
        if (job.status === "terminating") {
          this.deferredSettlements.set(job.jobId, { kind: "resolved", result, onComplete });
          return;
        }
        return this.settleExecutionResult(job, result, onComplete);
      })
      .catch((error: unknown) => {
        if (job.status === "terminating") {
          this.deferredSettlements.set(job.jobId, { kind: "rejected", error });
          return;
        }
        return this.settleExecutionError(job, error);
      }).finally(() => this.acknowledgeSettledExecution(job));
    if (deferExecution) {
      job.promise = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (operation?: () => Promise<void>) => {
          this.assertNonforcingAdmission();
          if (settled) return;
          settled = true;
          this.deferredExecutions.delete(job.jobId);
          if (operation) void operation().then(resolve, reject);
          else resolve();
        };
        this.deferredExecutions.set(job.jobId, {
          launch: () => finish(execute),
          discard: () => finish()
        });
      });
    } else {
      job.promise = execute();
    }
    return job;
  }

  activateDeferredExecution(jobId: string): void {
    this.assertNonforcingAdmission();
    const job = this.jobs.get(jobId);
    if (job) this.assertCurrentJobOwner(job);
    this.assertNonforcingAdmission();
    this.deferredExecutions.get(jobId)?.launch();
  }

  discardDeferredAdmission(jobId: string): void {
    this.assertNonforcingAdmission();
    const deferred = this.deferredExecutions.get(jobId);
    if (!deferred) return;
    deferred.discard();
    this.deferredSettlements.delete(jobId);
    this.steeringPromptRedactions.delete(jobId);
    this.deleteIndexedJob(jobId);
    this.progressPersistenceQueue.remove(snapshot => snapshot.jobId === jobId);
    this.progressPersisted.delete(jobId);
    this.lastWake.delete(jobId);
    this.retentionProtectedJobs.delete(jobId);
    this.scheduleIdleRetainedJobMaintenance();
  }

  private invokeCompletionCallback(job: CodexJob, result: ToolResult,
    callback?: JobCompletionCallback): (() => void) | undefined {
    this.assertNonforcingAdmission();
    if (!callback) return undefined;
    const jobId=job.jobId;
    this.registryCallbacksInFlight++;
    try {
      const returned = Reflect.apply(callback,undefined,[result,job]);
      if (returned === undefined) return undefined;
      if (typeof returned === "function") return returned;
      this.nonforcingUnknown = true;
      this.unconfirmedJobCallbacks.add(job);
      this.retainNonforcingObservation(jobId,"completion-callback-result",returned);
      throw new Error("STATE_COMPLETION_CALLBACK_UNCONFIRMED");
    } catch (error) {
      this.nonforcingUnknown=true;this.unconfirmedJobCallbacks.add(job);
      this.retainNonforcingObservation(jobId,'completion-callback-error',error);
      throw error;
    } finally {this.registryCallbacksInFlight--;}
  }

  private invokeTerminalUndo(job:CodexJob,undo:((()=>void)|undefined),jobId:string):void {
    if(!undo)return;
    if(this.nonforcingPinned){this.retainNonforcingObservation(jobId,'terminal-undo',undo);return;}
    this.registryCallbacksInFlight++;
    try {
      const result=Reflect.apply(undo,undefined,[]);
      if(result!==undefined) {
        this.nonforcingUnknown=true;this.unconfirmedJobCallbacks.add(job);
        this.retainNonforcingObservation(jobId,'terminal-undo-result',result);
      }
    }catch(error){
      this.nonforcingUnknown=true;this.unconfirmedJobCallbacks.add(job);
      this.retainNonforcingObservation(jobId,'terminal-undo-error',error);
    }finally{this.registryCallbacksInFlight--;}
  }

  private settleResolvedJob(
    job: CodexJob,
    result: ToolResult,
    onComplete?: JobCompletionCallback
  ): void {
    if (job.status !== "running" && job.status !== "termination-failed") return;
    const turnStatus = extractResultTurnStatus(result);
    if (turnStatus !== "interrupted" && result.isError) {
      this.settleUpstreamErrorJob(job, result, onComplete);
      return;
    }
    const retained = retainBoundedResult(
      result,
      this.maxResultBytes,
      job.sessionDecision,
      job.cwd,
      this.allowedRoots,
      this.steeringPromptsFor(job.jobId)
    );
    const jobId=job.jobId;
    let undo: (() => void) | undefined;
    try {
      const next = this.activityStore.transaction(() => {
        undo = this.invokeCompletionCallback(job,result,onComplete);
        this.assertNonforcingAdmission();
        const candidate: CodexJob = {
          ...job,
          threadId: job.sessionDecision.threadId,
          status: turnStatus === "interrupted" ? "interrupted" : "completed",
          terminalOrigin: turnStatus === "interrupted"
            ? "app-server-interrupted"
            : "normal-completion",
          cancellationIntentId: undefined,
          result: retained.result,
          resultBytes: retained.originalBytes,
          resultOmitted: retained.omitted,
          pendingInteractions: [],
          error: turnStatus === "interrupted"
            ? "The Codex App Server turn was interrupted before normal completion."
            : undefined,
          updatedAt: Date.now(),
          version: job.version + 1
        };
        this.persistJob(candidate, [], false);
        return candidate;
      });
      Object.assign(job, next);
      this.steeringPromptRedactions.delete(job.jobId);
      this.notify(job.jobId, "terminal");
      this.notifyScope(job.scopeId);
    } catch (error) {
      this.invokeTerminalUndo(job,undo,jobId);
      throw new JobTerminalCommitError(error);
    }
  }

  private settleUpstreamErrorJob(
    job: CodexJob,
    result: ToolResult,
    onComplete?: JobCompletionCallback
  ): void {
    const retained = retainBoundedResult(
      result,
      this.maxResultBytes,
      job.sessionDecision,
      job.cwd,
      this.allowedRoots,
      this.steeringPromptsFor(job.jobId)
    );
    const jobId=job.jobId;
    let undo: (() => void) | undefined;
    try {
      const next = this.activityStore.transaction(() => {
        // A failed turn can still have created or resumed a durable thread.
        // Keep the same callback in the atomic terminal transaction.
        undo = this.invokeCompletionCallback(job,result,onComplete);
        this.assertNonforcingAdmission();
        const candidate: CodexJob = {
          ...job,
          threadId: job.sessionDecision.threadId,
          status: "failed",
          terminalOrigin: "upstream-failure",
          cancellationIntentId: undefined,
          result: retained.result,
          resultBytes: retained.originalBytes,
          resultOmitted: retained.omitted,
          pendingInteractions: [],
          error: sanitizeTextForJob(
            toolResultErrorMessage(result),
            job.cwd,
            this.allowedRoots,
            this.steeringPromptsFor(job.jobId)
          ).slice(0, 4_000),
          updatedAt: Date.now(),
          version: job.version + 1
        };
        this.persistJob(candidate, [], false);
        return candidate;
      });
      Object.assign(job, next);
      this.steeringPromptRedactions.delete(job.jobId);
      this.notify(job.jobId, "terminal");
      this.notifyScope(job.scopeId);
    } catch (error) {
      this.invokeTerminalUndo(job,undo,jobId);
      throw new JobTerminalCommitError(error);
    }
  }

  private settleRejectedJob(job: CodexJob, error: unknown): void {
    if (job.status !== "running" && job.status !== "termination-failed") return;
    const terminalCommitFailed = error instanceof JobTerminalCommitError;
    const workerLost =
      error instanceof Error && error.message.startsWith("CODEX_WORKER_LOST:");
    const candidate: CodexJob = {
      ...job,
      status: workerLost ? "interrupted" : "failed",
      terminalOrigin: terminalCommitFailed
        ? undefined
        : workerLost
          ? "worker-loss"
          : "upstream-failure",
      trackingState: workerLost ? "worker-lost" : job.trackingState,
      cancellationIntentId: undefined,
      result: undefined,
      resultBytes: undefined,
      resultOmitted: undefined,
      pendingInteractions: [],
      error: sanitizeTextForJob(
        error instanceof Error ? error.message : String(error),
        job.cwd,
        this.allowedRoots,
        this.steeringPromptsFor(job.jobId)
      ).slice(0, 4_000),
      updatedAt: Date.now(),
      version: job.version + 1
    };
    try {
      this.activityStore.transaction(() => this.persistJob(candidate, [], false));
      Object.assign(job, candidate);
    } catch (commitError) {
      const failure = new JobTerminalCommitError(commitError);
      if (job.executionReceipt) throw failure;
      const fallback: CodexJob = {
        ...job,
        status: "failed",
        terminalOrigin: undefined,
        cancellationIntentId: undefined,
        result: undefined,
        resultBytes: undefined,
        resultOmitted: undefined,
        pendingInteractions: [],
        error: sanitizeTextForJob(
          failure.message,
          job.cwd,
          this.allowedRoots,
          this.steeringPromptsFor(job.jobId)
        ).slice(0, 4_000),
        updatedAt: Date.now(),
        version: job.version + 1
      };
      try {
        this.activityStore.transaction(() => this.persistJob(fallback, [], false));
      } catch {
        // The durable running receipt remains authoritative. Never publish a
        // terminal state from memory when neither the intended terminal nor
        // its explicit persistence-failure receipt could be committed.
        return;
      }
      Object.assign(job, fallback);
    }
    this.steeringPromptRedactions.delete(job.jobId);
    this.notify(job.jobId, "terminal");
    this.notifyScope(job.scopeId);
  }

  private flushDeferredSettlement(job: CodexJob): void {
    if (this.nonforcingPinned) return;
    const settlement = this.deferredSettlements.get(job.jobId);
    if (!settlement) return;
    this.deferredSettlements.delete(job.jobId);
    job.promise = this.settleExecution(job, settlement)
      .catch(error => this.settleExecutionError(job, error))
      .finally(() => this.acknowledgeSettledExecution(job));
  }

  terminationImpact(jobId: string): { targetJobId: string; affectedJobIds: string[]; collateralJobIds: string[] } {
    const job = this.get(jobId);
    if (!job) throw new Error("Unknown Codex job id. Read codex_status({}) for the current conversation and use an exact retained Job id.");
    if (!isActiveActivityJobStatus(job.status)) {
      return { targetJobId: jobId, affectedJobIds: [jobId], collateralJobIds: [] };
    }
    const affected = this.jobsForWorker(job);
    return {
      targetJobId: jobId,
      affectedJobIds: affected.map((entry) => entry.jobId),
      collateralJobIds: affected.filter((entry) => entry.jobId !== jobId).map((entry) => entry.jobId)
    };
  }

  async cancel(
    jobId: string,
    intent: CancellationIntentRecord,
    options: ForceTerminateOptions = {}
  ): Promise<CodexJob> {
    this.assertNonforcingAdmission();
    intent = this.admittedData(intent);
    options = this.admittedData(options);
    const job = this.jobs.get(jobId);
    if (job) this.assertOriginalJobControl(job);
    this.assertCancellationIntentForJob(jobId, intent);
    const existingTermination = this.terminations.get(jobId);
    if (existingTermination) {
      if (existingTermination.intentId !== intent.intentId) {
        throw new Error(
          "JOB_TERMINATION_IN_PROGRESS: This job is already terminating under another durable cancellation intent."
        );
      }
      return existingTermination.promise;
    }
    this.assertNonforcingAdmission();
    const operation = Promise.resolve().then(() => {
      this.assertNonforcingAdmission(); return this.forceTerminateJob(jobId, intent, options);
    }).finally(() => {
      if (!this.nonforcingPinned && this.terminations.get(jobId)?.promise === operation) {
        this.terminations.delete(jobId);
      }
    });
    this.terminations.set(jobId, { intentId: intent.intentId, promise: operation });
    return operation;
  }

  private assertCancellationIntentForJob(
    jobId: string,
    supplied: CancellationIntentRecord
  ): CancellationIntentRecord {
    if (!supplied || typeof supplied.intentId !== "string") {
      throw new Error(
        "CANCELLATION_PROVENANCE_REQUIRED: jobs.cancel requires an exact durable job cancellation intent."
      );
    }
    const intent = this.getCancellationIntent(supplied.intentId);
    if (
      !intent ||
      intent.intentId !== supplied.intentId ||
      intent.targetKind !== "job" ||
      intent.targetJobId !== jobId ||
      (intent.status !== "recorded" && intent.status !== "dispatched")
    ) {
      throw new Error(
        "CANCELLATION_PROVENANCE_REQUIRED: jobs.cancel requires an exact durable job cancellation intent."
      );
    }
    return intent;
  }

  async respondToInteraction(
    jobId: string,
    interactionId: string,
    response: CodexInteractionResponse
  ): Promise<CodexJob> {
    this.assertNonforcingAdmission();
    response = this.admittedData(response);
    const key = `${jobId}\0${interactionId}`;
    const responseHash = createHash("sha256").update(JSON.stringify(response)).digest("hex");
    this.assertNonforcingAdmission();
    const active = this.interactionResponses.get(key);
    if (active) {
      if (active.responseHash !== responseHash) {
        throw new Error("This Codex interaction is already resolving with a different response.");
      }
      return active.promise;
    }
    this.assertNonforcingAdmission();
    const promise = Promise.resolve().then(() => {
      this.assertNonforcingAdmission(); return this.resolveInteraction(jobId, interactionId, response);
    }).finally(() => {
      if (!this.nonforcingPinned && this.interactionResponses.get(key)?.promise === promise) {
        this.interactionResponses.delete(key);
      }
    });
    this.interactionResponses.set(key, { responseHash, promise });
    return promise;
  }

  interactionInput(interactionId: string): CodexInteractionInput | undefined {
    this.assertNonforcingAdmission();
    const upstream = this.upstream;
    const read = upstream?.interactionInput;
    this.assertNonforcingAdmission();
    if (!read) return undefined;
    const value = Reflect.apply(read,upstream,[interactionId]);
    this.assertNonforcingAdmission();
    return this.admittedData(value);
  }

  private async resolveInteraction(
    jobId: string,
    interactionId: string,
    response: CodexInteractionResponse
  ): Promise<CodexJob> {
    let job: CodexJob;
    let interaction: CodexPendingInteraction;
    let sendResponse: NonNullable<CodexUpstream["respondToInteraction"]>;
    try {
      const current = this.get(jobId);
      if (!current || !isActiveActivityJobStatus(current.status)) {
        throw new Error("The selected Codex job is not active.");
      }
      this.assertOriginalJobControl(current);
      if (this.authBoundary && current.authBoundary !== this.authBoundary() &&
          current.workerId && current.workerGeneration !== undefined &&
          !interactionId.startsWith(`${current.workerId}:${current.workerGeneration}:`)) {
        throw new Error("CODEX_AUTH_JOB_BOUNDARY: The interaction does not belong to the original worker generation.");
      }
      const pending = current.pendingInteractions.find((entry) => entry.interactionId === interactionId);
      if (!pending) throw new Error("Unknown or already resolved Codex interaction id for this job.");
      if (pending.kind === "user-input" && !response.answers) {
        throw new Error("This Codex interaction requires answers.");
      }
      if (pending.kind === "mcp-elicitation" && !response.elicitation) {
        throw new Error("This MCP elicitation requires an elicitation response.");
      }
      if (!isInputInteraction(pending) && !response.decision) {
        throw new Error("This Codex approval interaction requires a decision.");
      }
      if (response.decision && pending.availableDecisions &&
          !pending.availableDecisions.includes(response.decision)) {
        throw new Error("The selected decision is not available for this Codex approval request.");
      }
      const checkedUpstream = this.upstream;
      const respond = checkedUpstream?.respondToInteraction;
      this.assertNonforcingAdmission();
      if (!respond) throw new Error("The active Codex backend cannot accept interactions.");
      job = current;
      interaction = pending;
      sendResponse = (id, value) => Reflect.apply(respond,checkedUpstream,[id,value]);
    } catch (error) {
      throw new InteractionNotDispatchedError(error);
    }
    // Keep the checked upstream instance and interaction together. An error
    // from this call can mean the answer was sent; it must remain uncertain.
    this.assertNonforcingAdmission();
    await sendResponse(interactionId, response);
    this.assertNonforcingAdmission();
    job.pendingInteractions = job.pendingInteractions.filter((entry) => entry.interactionId !== interactionId);
    this.recordProgress(job, {
      progress: (job.lastProgress?.progress || 0) + 1,
      message: `${interaction.kind} resolved.`,
      event: {
        eventId: randomUUID(),
        type: isInputInteraction(interaction) ? "input-required" : "approval-required",
        phase: "completed",
        createdAt: Date.now(),
        summary: `${interaction.kind} resolved.`
      }
    });
    return job;
  }

  async steer(jobId: string, prompt: string): Promise<CodexJob> {
    this.assertNonforcingAdmission();
    const job = this.get(jobId);
    if (!job || job.status !== "running") throw new Error("The selected Codex job has no active turn to steer.");
    this.assertCurrentJobOwner(job);
    this.assertNonforcingAdmission();
    const steer = this.upstream?.steerThread;
    this.assertNonforcingAdmission();
    if (!backendSupports(job.backendKind, "supportsSteering") || !job.threadId || !steer) {
      throw new Error("Steering is available only for an active Codex App Server turn.");
    }
    this.rememberSteeringPrompt(job.jobId, prompt);
    try {
      this.assertNonforcingAdmission();
      await Reflect.apply(steer,this.upstream,[job.threadId, prompt]);
    } catch (error) {
      if (this.nonforcingPinned) {
        this.retainNonforcingObservation(job.jobId,"steering-error",error);
        throw new Error("NONFORCING_SHUTDOWN_UNCONFIRMED");
      }
      const captured = this.capturedExecutionError(error);
      if (!captured.ok || this.nonforcingPinned) {
        this.nonforcingUnknown = true;
        this.retainNonforcingObservation(jobId,"steering-error",error);
        throw new Error("STATE_CALLBACK_DATA_UNCONFIRMED");
      }
      // The dispatch boundary is uncertain to callers. Keep the redaction until
      // terminal state, and never reflect a prompt-bearing upstream error.
      throw new Error(
        redactSteeringPromptText(
          captured.error.message,
          this.steeringPromptsFor(job.jobId)
        )
      );
    }
    this.assertNonforcingAdmission();
    this.recordProgress(job, {
      progress: (job.lastProgress?.progress || 0) + 1,
      message: "Additional user guidance was sent to the active Codex turn.",
      event: {
        eventId: randomUUID(),
        type: "turn",
        phase: "updated",
        createdAt: Date.now(),
        summary: "Additional user guidance was sent to the active Codex turn."
      }
    });
    return job;
  }

  private rememberSteeringPrompt(jobId: string, prompt: string): void {
    const prompts = this.steeringPromptRedactions.get(jobId) || new Set<string>();
    prompts.add(prompt);
    this.steeringPromptRedactions.set(jobId, prompts);
  }

  private steeringPromptsFor(jobId: string): string[] {
    return [...(this.steeringPromptRedactions.get(jobId) || [])]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
  }

  async wait(
    jobId: string,
    waitFor: CodexJobWaitMode,
    waitMs: number,
    signal?: AbortSignal,
    source: CodexJobWaitSource = "internal"
  ): Promise<CodexJobWaitResult> {
    this.assertNonforcingAdmission();
    if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > MAX_CODEX_STATUS_WAIT_MS) {
      throw new Error(`waitMs must be an integer between 1 and ${MAX_CODEX_STATUS_WAIT_MS}.`);
    }
    const initial = this.get(jobId);
    if (!initial) throw new Error("Unknown Codex job id. Read codex_status({}) for the current conversation and use an exact retained Job id.");
    const startedAt = Date.now();
    const initialVersion = initial.version;
    let wakeReason: CodexJobWakeReason | undefined;
    this.waitDiagnosticsTracker.begin(jobId, waitFor, source);
    try {
      if (signal?.aborted) throw new Error("The status wait was cancelled by the host.");
      let current = initial;
      if (isActiveActivityJobStatus(current.status)) {
        const remaining = startedAt + waitMs - Date.now();
        if (remaining > 0) {
          wakeReason = waitFor === "terminal"
            ? await this.waitForTerminal(jobId, remaining, signal)
            : await this.waitForVersion(jobId, current.version, remaining, signal);
          // The public lookup above checked the project-registry revision once.
          // Waiting itself is an in-memory hot path with no retention writes.
          current = this.jobs.get(jobId) || current;
        }
      }
      const waitedMs = Math.max(0, Date.now() - startedAt);
      const waitTimedOut =
        isActiveActivityJobStatus(current.status) &&
        (waitFor === "terminal" || current.version === initialVersion);
      const result = {
        job: current,
        waitFor,
        waitedMs,
        waitTimedOut,
        changed: wakeReason !== undefined || current.version !== initialVersion
      };
      this.waitDiagnosticsTracker.finish(jobId, waitFor, source, {
        waitedMs,
        completed: true,
        timedOut: waitTimedOut,
        aborted: false,
        wakeReason
      });
      return result;
    } catch (error) {
      this.waitDiagnosticsTracker.finish(jobId, waitFor, source, {
        waitedMs: Math.max(0, Date.now() - startedAt),
        completed: false,
        timedOut: false,
        aborted: Boolean(signal?.aborted),
        wakeReason
      });
      throw error;
    }
  }

  async waitForInput(jobId: string, afterCursor?: string, waitMs = 0, signal?: AbortSignal) {
    this.assertNonforcingAdmission();
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_CODEX_STATUS_WAIT_MS) throw new Error("INPUT_WAIT_INVALID: Invalid bounded wait duration.");
    if (signal?.aborted) throw new Error("The input wait was cancelled by the host.");
    const started = Date.now(), deadline = started + waitMs;
    let job = this.get(jobId);
    if (!job) throw new Error("INPUT_JOB_UNAVAILABLE: Unknown Job.");
    const baseline = afterCursor || codexInputCursor(job);
    const hasInput = (job.inputEvents || []).length > 0 || job.pendingInteractions.length > 0;
    while (waitMs > 0 && job.status === "running" && codexInputCursor(job) === baseline && (afterCursor !== undefined || !hasInput)) {
      if (signal?.aborted) throw new Error("The input wait was cancelled by the host.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.waitForVersion(jobId, job.version, remaining, signal);
      job = this.get(jobId) || job;
    }
    return { ...codexInputSnapshot(job, afterCursor), waitedMs: Date.now() - started,
      timedOut: waitMs > 0 && job.status === "running" && codexInputCursor(job) === baseline && Date.now() >= deadline };
  }

  private recordProgress(job: CodexJob, progress: CodexProgress): void {
    if (this.nonforcingPinned) {this.retainNonforcingObservation(job.jobId, "progress", progress); return;}
    const captured = snapshotNonforcingData(progress, () => this.nonforcingPinned);
    if (!captured.ok || !isRecord(captured.value) || typeof captured.value.progress !== "number" || !Number.isFinite(captured.value.progress) ||
        captured.value.total !== undefined && (typeof captured.value.total !== "number" || !Number.isFinite(captured.value.total)) ||
        captured.value.message !== undefined && typeof captured.value.message !== "string") {
      this.nonforcingUnknown = true;this.unconfirmedJobCallbacks.add(job);this.retainNonforcingObservation(job.jobId,"progress",progress);return;
    }
    progress = captured.value;
    if (job.status !== "running" && job.status !== "termination-failed") return;
    const now = Date.now();
    const resumedFromTerminationFailure = job.status === "termination-failed";
    if (resumedFromTerminationFailure) {
      job.status = "running";
      job.error = undefined;
    }
    const steeringPrompts = this.steeringPromptsFor(job.jobId);
    job.lastProgress = sanitizeProgress(progress, steeringPrompts);
    const publicEvent = sanitizePublicEventForJob(
      sanitizePublicEvent(progress.event),
      job.cwd,
      this.allowedRoots,
      steeringPrompts
    );
    let resolvedInteractionId: string | undefined;
    let interaction: CodexPendingInteraction | undefined;
    if (publicEvent && job.publicEvents.some(event => event.eventId === publicEvent.eventId)) return;
    if (publicEvent) {
      if (isCodexInputEvent(publicEvent)) job.inputEvents = [...(job.inputEvents || []), publicEvent].slice(-40);
      job.publicEvents = [...job.publicEvents, publicEvent].slice(-200);
      resolvedInteractionId = typeof publicEvent.details?.resolvedInteractionId === "string"
        ? publicEvent.details.resolvedInteractionId
        : undefined;
      if (resolvedInteractionId) {
        job.pendingInteractions = job.pendingInteractions.filter(
          (entry) => entry.interactionId !== resolvedInteractionId
        );
      }
      const pendingInteraction = readPendingInteraction(publicEvent.details?.interaction);
      interaction = pendingInteraction;
      if (pendingInteraction) {
        job.pendingInteractions = [
          ...job.pendingInteractions.filter(
            (entry) => entry.interactionId !== pendingInteraction.interactionId
          ),
          pendingInteraction
        ].slice(-20);
      }
    }
    job.lastProgressAt = now;
    job.updatedAt = now;
    job.version += 1;
    this.notify(job.jobId, "progress");
    if (this.nonforcingPinned) return;
    const snapshot = this.progressSnapshot(job, publicEvent);
    if (publicEvent) {
      const critical = resumedFromTerminationFailure ||
        isCodexInputEvent(publicEvent) ||
        resolvedInteractionId !== undefined ||
        interaction !== undefined ||
        publicEvent.phase !== "updated" ||
        publicEvent.type === "error" ||
        publicEvent.type === "warning" ||
        publicEvent.type === "usage";
      if (critical || this.claimImmediateProgressPersistence()) {
        this.progressPersistenceQueue.remove(
          queued => queued.jobId === job.jobId && queued.version <= snapshot.version
        );
        this.persistProgressSnapshotBestEffort(snapshot);
      } else {
        this.progressPersistenceQueue.enqueue(snapshot.projectKey, snapshot);
      }
    } else if (
      resumedFromTerminationFailure ||
      now - (this.progressPersisted.get(job.jobId)?.persistedAt || job.createdAt) >=
        JOB_PROGRESS_PERSIST_INTERVAL_MS
    ) {
      if (resumedFromTerminationFailure || this.claimImmediateProgressPersistence()) {
        this.progressPersistenceQueue.remove(
          queued => queued.jobId === job.jobId && queued.version <= snapshot.version
        );
        this.persistProgressSnapshotBestEffort(snapshot);
      } else {
        this.progressPersistenceQueue.remove(
          queued => queued.jobId === job.jobId && queued.publicEvent === undefined
        );
        this.progressPersistenceQueue.enqueue(snapshot.projectKey, snapshot);
      }
    }
  }

  private recordWorkerAssignment(job: CodexJob, assignment: UpstreamWorkerAssignment): UpstreamWorkerAssignment | undefined {
    if (this.nonforcingPinned) {this.retainNonforcingObservation(job.jobId, "assignment", assignment); return;}
    const captured = snapshotNonforcingData(assignment, () => this.nonforcingPinned);
    if (!captured.ok || !isRecord(captured.value) || !isCodexBackendKind(captured.value.backendKind) ||
        typeof captured.value.workerId !== "string" || !captured.value.workerId ||
        !Number.isSafeInteger(captured.value.workerGeneration) || captured.value.workerGeneration < 0 ||
        captured.value.threadPersistence!==undefined && !['persistent','ephemeral','unknown'].includes(captured.value.threadPersistence) ||
        captured.value.runtime!==undefined && (!isRecord(captured.value.runtime) ||
          typeof captured.value.runtime.codex!=='string' || !captured.value.runtime.codex ||
          (['sdk','python'] as const).some(key=>captured.value.runtime![key]!==undefined && typeof captured.value.runtime![key]!=='string') ||
          captured.value.runtime.channel!==undefined && captured.value.runtime.channel!=='stable' ||
          (['requestedAuthMode','resolvedAuthMode'] as const).some(key=>captured.value.runtime![key]!==undefined &&
            !['chatgpt','api-key'].includes(captured.value.runtime![key]!))) ||
        (["workerPid","processGroupId"] as const).some(key => captured.value[key] !== undefined &&
          (!Number.isSafeInteger(captured.value[key]) || (captured.value[key] as number) <= 0)) ||
        (["upstreamRequestId","threadId","sessionId","forkedFromThreadId"] as const).some(key => captured.value[key] !== undefined &&
          (typeof captured.value[key] !== "string" || !captured.value[key]))) {
      this.nonforcingUnknown = true;this.unconfirmedJobCallbacks.add(job);this.retainNonforcingObservation(job.jobId,"assignment",assignment);return;
    }
    assignment = captured.value;
    if (job.status !== "running" && job.status !== "termination-failed") return;
    if (job.workerId && (job.workerId !== assignment.workerId || job.workerGeneration !== assignment.workerGeneration ||
        job.upstreamRequestId && assignment.upstreamRequestId && job.upstreamRequestId !== assignment.upstreamRequestId)) {
      job.pendingInteractions = [];
      job.inputEvents = [];
    }
    job.backendKind = assignment.backendKind;
    job.runtime = safeRuntimeMetadata(assignment.runtime);
    job.trackingState = "connected";
    job.workerId = assignment.workerId;
    job.workerGeneration = assignment.workerGeneration;
    job.workerPid = assignment.workerPid;
    job.threadPersistence = assignment.threadPersistence || job.threadPersistence;
    job.processGroupId = assignment.processGroupId;
    job.upstreamRequestId = assignment.upstreamRequestId;
    if (assignment.threadId) {
      job.threadId = assignment.threadId;
      job.sessionDecision.threadId = assignment.threadId;
    }
    job.updatedAt = Date.now();
    job.version += 1;
    this.persistJob(job);
    this.notify(job.jobId);
    return assignment;
  }

  private jobsForWorker(job: CodexJob): CodexJob[] {
    if (!job.workerId || job.workerGeneration === undefined) return [job];
    return [...this.jobs.values()].filter(
      (candidate) =>
        isActiveActivityJobStatus(candidate.status) &&
        candidate.backendKind === job.backendKind &&
        candidate.workerId === job.workerId &&
        candidate.workerGeneration === job.workerGeneration
    );
  }

  private async forceTerminateJob(
    jobId: string,
    suppliedIntent: CancellationIntentRecord,
    options: ForceTerminateOptions
  ): Promise<CodexJob> {
    this.assertNonforcingAdmission();
    const primaryIntent = this.assertCancellationIntentForJob(jobId, suppliedIntent);
    const target = this.get(jobId);
    if (!target) throw new Error("Unknown Codex job id. Read codex_status({}) for the current conversation and use an exact retained Job id.");
    this.assertOriginalJobControl(target);
    this.assertNonforcingAdmission();
    if (primaryIntent.scopeId !== target.scopeId || primaryIntent.targetActivityId !== target.activityId) {
      throw new Error("Cancellation intent scope or Activity no longer matches the target job.");
    }
    if (primaryIntent.expectedVersion !== target.version) {
      throw new Error(
        `Codex job version changed from ${primaryIntent.expectedVersion} to ${target.version}. Refresh status before force-stopping it.`
      );
    }
    if (isTerminalActivityJobStatus(target.status)) {
      this.setCancellationIntentStatus(primaryIntent.intentId, "no-op");
      return target;
    }
    const terminate = this.upstream?.forceTerminateWorker;
    this.assertNonforcingAdmission();
    if (!target.workerId || target.workerGeneration === undefined || !terminate) {
      target.status = "termination-failed";
      target.cancelRequestedAt ||= Date.now();
      target.cancellationIntentId = primaryIntent.intentId;
      target.error = "The bridge cannot identify a supervised worker process for this Codex job.";
      this.recordChange(target);
      this.setCancellationIntentStatus(primaryIntent.intentId, "failed");
      return target;
    }
    if (options.interruptOnly && (target.backendKind !== "app-server" || !target.upstreamRequestId || !backendSupports(target.backendKind, "supportsPreciseCancellation"))) {
      throw new Error("PRECISE_INTERRUPTION_REQUIRED: Automatic recovery requires the original App Server turn.");
    }
    const possibleAffected = options.interruptOnly ? [target] : this.jobsForWorker(target);
    const affectedIds = possibleAffected.map((job) => job.jobId).sort();
    const requestedIntentByJobId = new Map<string, CancellationIntentRecord>();
    for (const supplied of [primaryIntent, ...(options.requestedTargetIntents || [])]) {
      if (!supplied.targetJobId || requestedIntentByJobId.has(supplied.targetJobId)) continue;
      const intent = this.assertCancellationIntentForJob(supplied.targetJobId, supplied);
      const job = this.get(supplied.targetJobId);
      if (
        !job ||
        !affectedIds.includes(job.jobId) ||
        intent.scopeId !== primaryIntent.scopeId ||
        intent.requestId !== primaryIntent.requestId ||
        intent.cascadeId !== primaryIntent.cascadeId ||
        intent.expectedVersion !== job.version
      ) {
        throw new Error("Requested cancellation target intent no longer matches this worker impact set.");
      }
      requestedIntentByJobId.set(job.jobId, intent);
    }
    requestedIntentByJobId.set(target.jobId, primaryIntent);
    const acknowledged = [...(options.acknowledgeAffectedJobIds || [])].sort();
    if (affectedIds.length > 1 && JSON.stringify(acknowledged) !== JSON.stringify(affectedIds)) {
      throw new Error(
        `Force-stop will also interrupt jobs sharing this worker generation. Retry with acknowledgeAffectedJobIds=${JSON.stringify(affectedIds)} after showing one collateral/partial-change confirmation.`
      );
    }
    const impactIntentByJobId = new Map(requestedIntentByJobId);
    for (const job of possibleAffected) {
      if (impactIntentByJobId.has(job.jobId)) continue;
      const containment = this.createCancellationIntent({
        scopeId: primaryIntent.scopeId,
        requestId: primaryIntent.requestId,
        parentIntentId: primaryIntent.intentId,
        cascadeId: primaryIntent.cascadeId,
        source: "assignment-containment",
        toolName: primaryIntent.toolName,
        actionName: "interrupt-shared-worker",
        target: cancellationTargetForJob(job),
        expectedVersion: job.version,
        callerPresentation: primaryIntent.callerPresentation,
        ...(primaryIntent.widgetInstanceDigest && primaryIntent.cardGeneration
          ? {
              widgetProof: {
                instanceDigest: primaryIntent.widgetInstanceDigest,
                cardGeneration: primaryIntent.cardGeneration
              }
            }
          : {}),
        callerRequestDigest: primaryIntent.callerRequestDigest,
        reasonCode: "shared-worker-containment"
      });
      impactIntentByJobId.set(job.jobId, containment);
    }
    const now = Date.now();
    const initiallyTerminating = backendSupports(target.backendKind, "supportsPreciseCancellation") ? [target] : possibleAffected;
    this.activityTransaction(() => {
      for (const job of initiallyTerminating) {
        const intent = impactIntentByJobId.get(job.jobId);
        if (!intent) {
          throw new Error(
            "CANCELLATION_PROVENANCE_REQUIRED: A terminating job has no durable impact intent."
          );
        }
        job.status = "terminating";
        job.cancelRequestedAt ||= now;
        job.cancellationIntentId = intent.intentId;
        job.terminalOrigin = undefined;
        job.error = options.interruptOnly ? "Automatic recovery is retrying the previously requested interruption of this exact Codex turn."
          : backendSupports(target.backendKind, "supportsPreciseCancellation")
          ? "Force-stop is interrupting the exact Codex App Server turn; process-group termination is the automatic fallback."
          : "Force-stop is terminating the exact Codex worker process group.";
        this.recordChange(job);
      }
      for (const intent of impactIntentByJobId.values()) {
        if (intent.status === "recorded") {
          this.setCancellationIntentStatus(intent.intentId, "dispatched");
        }
      }
    });
    const assignment: UpstreamWorkerAssignment = {
      backendKind: isCodexBackendKind(target.backendKind) ? target.backendKind : "mcp-server",
      workerId: target.workerId,
      workerGeneration: target.workerGeneration,
      ...(target.workerPid !== undefined ? { workerPid: target.workerPid } : {}),
      ...(target.processGroupId !== undefined ? { processGroupId: target.processGroupId } : {}),
      ...(target.upstreamRequestId ? { upstreamRequestId: target.upstreamRequestId } : {})
    };
    try {
      this.assertNonforcingAdmission();
      const observedResult = await Reflect.apply(terminate,this.upstream,[
        assignment,
        cancellationTerminationCorrelation(primaryIntent),
        undefined,
        options.interruptOnly ? {interruptOnly:true} : undefined
      ]);
      this.assertNonforcingAdmission();
      const result = this.admittedData(observedResult);
      if (result.mode === "already-completed") {
        this.activityTransaction(() => {
          for (const job of initiallyTerminating) {
            job.status = "running";
            job.cancellationIntentId = undefined;
            job.error = undefined;
            this.recordChange(job);
          }
          for (const intent of impactIntentByJobId.values()) this.setCancellationIntentStatus(intent.intentId, "no-op");
        });
        for (const job of initiallyTerminating) {
          this.flushDeferredSettlement(job);
          this.acknowledgeSettledExecution(job);
        }
        return this.get(jobId) as CodexJob;
      }
      if (options.interruptOnly && (result.mode !== "turn-interrupt" || result.workerExited)) {
        throw new Error("PRECISE_INTERRUPTION_UNCONFIRMED: The backend did not confirm an isolated turn interruption.");
      }
      if (!result.exited) throw new Error("The Codex turn or worker process group remained active after force-stop.");
      const actuallyAffected = result.mode === "turn-interrupt" ? [target] : possibleAffected;
      this.activityTransaction(() => {
        for (const job of actuallyAffected) {
          const intent = impactIntentByJobId.get(job.jobId);
          if (!intent) {
            throw new Error(
              "CANCELLATION_PROVENANCE_REQUIRED: Worker impact has no durable cancellation correlation."
            );
          }
          this.deferredSettlements.delete(job.jobId);
          const explicitlyRequested = requestedIntentByJobId.has(job.jobId);
          job.status = explicitlyRequested ? "cancelled" : "interrupted";
          job.terminalOrigin = explicitlyRequested
            ? "explicit-cancellation"
            : "assignment-containment";
          job.cancellationIntentId = intent.intentId;
          job.terminationEscalated = result.escalated;
          job.pendingInteractions = [];
          job.trackingState = result.workerExited ? "worker-lost" : "connected";
          job.error =
            explicitlyRequested
              ? result.mode === "turn-interrupt"
                ? "The exact Codex App Server turn was interrupted. Partial filesystem changes may remain."
                : "The Codex worker was force-stopped. Partial filesystem changes may remain."
              : `The Codex job was interrupted because it shared worker ${target.workerId} generation ${target.workerGeneration} with force-stopped job ${target.jobId}.`;
          this.recordChange(job);
          this.setCancellationIntentStatus(intent.intentId, "succeeded");
        }
        const actuallyAffectedIds = new Set(actuallyAffected.map((job) => job.jobId));
        for (const [affectedJobId, intent] of impactIntentByJobId) {
          if (
            !actuallyAffectedIds.has(affectedJobId) &&
            intent.source === "assignment-containment"
          ) {
            this.setCancellationIntentStatus(intent.intentId, "no-op");
          }
        }
      });
      for (const job of actuallyAffected) this.acknowledgeSettledExecution(job);
    } catch (error) {
      if (this.nonforcingPinned) throw error;
      const captured = this.capturedExecutionError(error);
      if (!captured.ok || this.nonforcingPinned) {
        this.nonforcingUnknown = true;
        this.retainNonforcingObservation(jobId,"termination-error",error);
        throw error;
      }
      this.activityTransaction(() => {
        for (const job of initiallyTerminating) {
          job.status = "termination-failed";
          job.error = `Could not confirm Codex worker termination: ${captured.error.message}`;
          this.recordChange(job);
        }
        for (const intent of impactIntentByJobId.values()) {
          const current = this.getCancellationIntent(intent.intentId);
          if (current?.status === "recorded" || current?.status === "dispatched") {
            this.setCancellationIntentStatus(intent.intentId, "failed");
          }
        }
      });
      for (const job of initiallyTerminating) this.flushDeferredSettlement(job);
    }
    return this.get(jobId) as CodexJob;
  }

  private recordChange(job: CodexJob): void {
    this.assertNonforcingAdmission();
    job.updatedAt = Date.now();
    job.version += 1;
    this.notify(
      job.jobId,
      isTerminalActivityJobStatus(job.status) ? "terminal" : "state-change"
    );
    this.persistJobBestEffort(job);
    if (isTerminalActivityJobStatus(job.status)) {
      this.steeringPromptRedactions.delete(job.jobId);
    }
  }

  private waitForVersion(
    jobId: string,
    version: number,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<CodexJobWakeReason | undefined> {
    if (this.activeJobObservationWaits >= MAX_ACTIVE_JOB_OBSERVATION_WAITS) {
      return Promise.reject(new Error("JOB_WAIT_CAPACITY: Active Job observation waits are at capacity."));
    }
    this.activeJobObservationWaits += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const listeners = this.waiters.get(jobId) || new Set<(reason: CodexJobWakeReason) => void>();
      this.waiters.set(jobId, listeners);
      const finish = (reason?: CodexJobWakeReason, error?: Error) => {
        if (settled) return;
        settled = true;
        this.activeJobObservationWaits -= 1;
        clearTimeout(timer);
        listeners.delete(onChange);
        if (listeners.size === 0) this.waiters.delete(jobId);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(reason);
      };
      const onChange = (reason: CodexJobWakeReason) => {
        finish((this.jobs.get(jobId)?.version || version) !== version ? reason : undefined);
      };
      const onAbort = () => finish(undefined, new Error("The status wait was cancelled by the host."));
      const timer = setTimeout(() => finish(), waitMs);
      listeners.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      const currentVersion = this.jobs.get(jobId)?.version || version;
      if (currentVersion !== version) {
        const lastWake = this.lastWake.get(jobId);
        finish(lastWake?.version === currentVersion ? lastWake.reason : "state-change");
      }
      else if (signal?.aborted) onAbort();
    });
  }

  private waitForTerminal(
    jobId: string,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<CodexJobWakeReason | undefined> {
    if (this.activeJobObservationWaits >= MAX_ACTIVE_JOB_OBSERVATION_WAITS) {
      return Promise.reject(new Error("JOB_WAIT_CAPACITY: Active Job observation waits are at capacity."));
    }
    this.activeJobObservationWaits += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const listeners = this.terminalWaiters.get(jobId) || new Set<() => void>();
      this.terminalWaiters.set(jobId, listeners);
      const finish = (reason?: CodexJobWakeReason, error?: Error) => {
        if (settled) return;
        settled = true;
        this.activeJobObservationWaits -= 1;
        clearTimeout(timer);
        listeners.delete(onTerminal);
        if (listeners.size === 0) this.terminalWaiters.delete(jobId);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(reason);
      };
      const onTerminal = () => finish("terminal");
      const onAbort = () => finish(undefined, new Error("The status wait was cancelled by the host."));
      const timer = setTimeout(() => finish(), waitMs);
      listeners.add(onTerminal);
      signal?.addEventListener("abort", onAbort, { once: true });
      const current = this.jobs.get(jobId);
      if (current && isTerminalActivityJobStatus(current.status)) onTerminal();
      else if (signal?.aborted) onAbort();
    });
  }

  private notify(jobId: string, reason: CodexJobWakeReason = "state-change"): void {
    if (this.nonforcingPinned) return;
    const current = this.jobs.get(jobId);
    const effectiveReason = current && isTerminalActivityJobStatus(current.status)
      ? "terminal"
      : reason;
    if (current) this.lastWake.set(jobId, { version: current.version, reason: effectiveReason });
    this.publishRegistryChanges(effectiveReason,current?.agentId);
    for (const listener of [...(this.waiters.get(jobId) || [])]) {
      if (this.nonforcingPinned) return;
      listener(effectiveReason);
    }
    if (effectiveReason === "terminal") {
      for (const listener of [...(this.terminalWaiters.get(jobId) || [])]) {
        if (this.nonforcingPinned) return;
        listener();
      }
      if (this.nonforcingPinned) return;
      if (this.observedRunningCount() === 0) {
        this.scheduleIdleRetainedJobMaintenance();
      }
    }
  }

  private notifyScope(scopeId: string, agentId?: string): void {
    if (this.nonforcingPinned) return;
    this.publishRegistryChanges(undefined,agentId);
    for (const listener of [...(this.scopeWaiters.get(scopeId) || [])]) {
      if (this.nonforcingPinned) return;
      listener();
    }
  }

  private publishRegistryChanges(reason?: CodexJobWakeReason, agentId?: string): void {
    for (const listener of this.changeListeners) {
      if (this.nonforcingPinned) return;
      this.registryCallbacksInFlight++;
      try {
        const result = Reflect.apply(listener,undefined,[reason,agentId]);
        if (result !== undefined) {
          this.nonforcingUnknown = true;
          this.retainNonforcingObservation("listener","listener-result",result);
        }
      } catch (error) {
        this.nonforcingUnknown = true;
        this.retainNonforcingObservation("listener","listener-error",error);
        throw error;
      } finally {this.registryCallbacksInFlight--;}
    }
  }

  /**
   * Active Jobs reserve a retained slot because they can become terminal at
   * any time. Terminal Jobs count until a bounded maintenance pass either
   * removes them or confirms a durable retention protection.
   */
  private retainedJobAdmissionReservations(): number {
    let reservations = 0;
    for (const [jobId, job] of this.jobs) {
      if (
        isActiveActivityJobStatus(job.status) ||
        isTerminalActivityJobStatus(job.status) && !this.retentionProtectedJobs.has(jobId)
      ) {
        reservations++;
        if (reservations > this.maxJobs) break;
      }
    }
    return reservations;
  }

  private requestRetainedJobHeadroom(): void {
    const target = Math.max(0, this.maxJobs - 1);
    this.retainedJobTarget = Math.min(this.retainedJobTarget ?? target, target);
    this.scheduleIdleRetainedJobMaintenance();
  }

  private scheduleIdleRetainedJobMaintenance(delayMs = 0): void {
    if (
      this.stateMaintenanceClosed ||
      this.retainedJobMaintenanceTimer ||
      !this.maintenanceScheduler && this.retainedJobTarget === undefined
    ) return;
    this.retainedJobMaintenanceTimer = setTimeout(() => {
      this.retainedJobMaintenanceTimer = undefined;
      if (
        this.runtimeAdmission.pendingAdmissions > 0 ||
        this.observedRunningCount() > 0
      ) return;
      const sweep = this.maintenanceScheduler
        ? this.maintenanceScheduler.sweep("jobs")
        : Promise.resolve({ failed: false, changed: this.maintainRetainedJobs() });
      void sweep.then(observation => {
        if (
          this.retainedJobTarget !== undefined &&
          this.retainedJobAdmissionReservations() > this.retainedJobTarget
        ) {
          this.scheduleIdleRetainedJobMaintenance(observation?.failed ? 1_000 : 250);
        }
      }, () => this.scheduleIdleRetainedJobMaintenance(1_000));
    }, Math.max(0, delayMs));
    this.retainedJobMaintenanceTimer.unref();
  }

  /** Protect a small first slice before admission; the maintenance scheduler
   * continues classification and pruning after startup. This prevents restart
   * from synchronously checking every historical Job's protection authorities. */
  private classifyLoadedJobsAtStartup(): void {
    let inspected = 0;
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (!isTerminalActivityJobStatus(job.status)) continue;
      if (++inspected > 32) break;
      if (this.activityStore.retentionProtection(job.jobId, now, this.ttlMs).length > 0) {
        this.retentionProtectedJobs.add(job.jobId);
      }
    }
  }

  private load(): void {
    if (!this.stateStore) return;
    const stored = this.stateStore.listJobs();
    const changed = this.loadJobs(stored);
    for (const job of this.jobs.values()) {
      this.progressPersisted.set(job.jobId, {
        version: job.version,
        persistedAt: job.updatedAt
      });
    }
    if (this.projectionOnly) return;
    if (changed || this.jobs.size !== stored.length) {
      this.stateStore.replaceJobs(this.persistedJobs());
    }
  }

  private loadJobs(values: unknown[]): boolean {
    const now = Date.now();
    let changed = false;
    const valid = values
      .map(readPersistedJob)
      .filter((job): job is PersistedCodexJob => Boolean(job))
      .filter((job) => this.isAllowedCwd(job.cwd))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    const byRequest = new Map<string, PersistedCodexJob>();
    for (const job of valid) {
      byRequest.set(`${job.scopeId}\0${job.requestId}`, job);
    }
    const loaded = [...byRequest.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    if (loaded.length !== valid.length) changed = true;
    for (const persisted of loaded) {
      const job: CodexJob = { ...persisted, promise: Promise.resolve() };
      if (this.projectionOnly) {
        this.setIndexedJob(job);
        continue;
      }
      if (isActiveActivityJobStatus(job.status) && this.authBoundary && job.authBoundary !== this.authBoundary()) {
        // Keep the exact durable Job and its original execution receipt. A
        // different or unverified owner must neither recover nor ACK it.
        job.trackingState = "liveness-unknown";
        if (this.recoverExecutions && job.executionReceipt) this.recoveryJobs.add(job.jobId);
        this.setIndexedJob(job);
        continue;
      }
      if (isActiveActivityJobStatus(job.status) && this.recoverExecutions && job.executionReceipt) {
        job.trackingState = "liveness-unknown";
        this.recoveryJobs.add(job.jobId);
      } else if (isActiveActivityJobStatus(job.status)) {
        job.status = "interrupted";
        job.terminalOrigin = "bridge-restart";
        job.trackingState = "orphaned";
        job.pendingInteractions = [];
        job.error = "The bridge restarted before this Codex job reached a terminal state.";
        job.updatedAt = now;
        job.version += 1;
        changed = true;
      } else if (job.status === "completed" && job.result?.isError) {
        job.status = "failed";
        job.terminalOrigin = "upstream-failure";
        job.error = toolResultErrorMessage(job.result);
        job.result = undefined;
        job.resultBytes = undefined;
        job.resultOmitted = undefined;
        job.updatedAt = now;
        job.version += 1;
        changed = true;
      }
      this.setIndexedJob(job);
    }
    if (this.projectionOnly) return changed || loaded.length !== values.length;
    this.classifyLoadedJobsAtStartup();
    changed = changed || loaded.length !== values.length;
    return changed;
  }

  private persist(): void {
    const persisted = this.persistedJobs();
    if (this.stateStore) this.stateStore.replaceJobs(persisted);
    else this.activityStore.replaceJobs(persisted);
    const persistedAt = Date.now();
    this.progressPersistenceQueue.remove(() => true);
    for (const job of persisted) {
      this.progressPersisted.set(job.jobId, { version: job.version, persistedAt });
    }
    this.persistenceWarningShown = false;
  }

  private persistedJobs(): PersistedCodexJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ promise: _promise, ...job }) => job);
  }

  private persistJob(job: CodexJob, removed: string[] = [], notifyScope = true): void {
    this.assertNonforcingAdmission();
    const { promise: _promise, ...persisted } = job;
    this.activityStore.transaction(() => {
      this.activityStore.upsertJob(persisted);
      for (const jobId of removed) this.activityStore.deleteJob(jobId);
    });
    this.setIndexedJob(this.jobs.get(job.jobId) || job);
    const removedIds = new Set([job.jobId, ...removed]);
    this.progressPersistenceQueue.remove(snapshot => removedIds.has(snapshot.jobId));
    this.progressPersisted.set(job.jobId, {
      version: job.version,
      persistedAt: Date.now()
    });
    for (const jobId of removed) this.progressPersisted.delete(jobId);
    this.persistenceWarningShown = false;
    if (notifyScope) this.notifyScope(job.scopeId);
  }

  private persistJobBestEffort(job: CodexJob, removed: string[] = []): boolean {
    try {
      this.persistJob(job, removed);
      return true;
    } catch (error) {
      this.recordPersistenceWarning("Could not persist Codex job state",error);
      return false;
    }
  }

  private persistProgressSnapshotBestEffort(snapshot: ProgressPersistenceSnapshot): boolean {
    if (this.nonforcingPinned) {this.retainNonforcingObservation(snapshot.jobId, "progress-snapshot", snapshot); return false;}
    return snapshot.publicEvent
      ? this.persistTelemetrySnapshotBestEffort(snapshot)
      : this.persistProgressStateSnapshotBestEffort(snapshot);
  }

  private persistTelemetrySnapshotBestEffort(
    snapshot: ProgressPersistenceSnapshot
  ): boolean {
    const publicEvent = snapshot.publicEvent as CodexPublicEvent;
    try {
      const transactionStartedAt = performance.now();
      try {
        this.activityStore.recordJobTelemetryEvent(
          snapshot.jobId,
          `app-${publicEvent.type}-${publicEvent.phase}`,
          publicEvent,
          publicEvent.createdAt,
          publicEvent.type === "approval-required" || publicEvent.type === "input-required"
            ? publicEvent.phase === "waiting"
              ? "user"
              : publicEvent.phase === "completed"
                ? "codex"
                : undefined
            : undefined,
          {
            updatedAt: snapshot.updatedAt,
            version: snapshot.version,
            lastProgressAt: snapshot.lastProgressAt,
            lastProgress: snapshot.lastProgress,
            pendingInteractions: snapshot.pendingInteractions
          }
        );
      } finally {
        this.waitDiagnosticsTracker.telemetryTransaction.record(
          performance.now() - transactionStartedAt
        );
      }
      this.progressPersisted.set(snapshot.jobId, {
        version: snapshot.version,
        persistedAt: Date.now()
      });
      this.persistenceWarningShown = false;
      this.notifyScope(snapshot.scopeId);
      return true;
    } catch (error) {
      this.recordPersistenceWarning("Could not persist Codex job telemetry",error);
      return false;
    }
  }

  private persistProgressStateSnapshotBestEffort(
    snapshot: ProgressPersistenceSnapshot
  ): boolean {
    try {
      const scopeChanged = this.activityStore.updateJobProgressState(snapshot.jobId, {
        updatedAt: snapshot.updatedAt,
        version: snapshot.version,
        lastProgressAt: snapshot.lastProgressAt,
        lastProgress: snapshot.lastProgress,
        pendingInteractions: snapshot.pendingInteractions
      });
      this.progressPersisted.set(snapshot.jobId, {
        version: snapshot.version,
        persistedAt: Date.now()
      });
      this.persistenceWarningShown = false;
      if (scopeChanged) this.notifyScope(snapshot.scopeId);
      return true;
    } catch (error) {
      this.recordPersistenceWarning("Could not persist Codex job progress",error);
      return false;
    }
  }

  private progressSnapshot(
    job: CodexJob,
    publicEvent?: CodexPublicEvent
  ): ProgressPersistenceSnapshot {
    const projectRef = job.projectRequest && "projectRef" in job.projectRequest
      ? job.projectRequest.projectRef
      : undefined;
    return {
      jobId: job.jobId,
      scopeId: job.scopeId,
      projectKey: job.projectId
        ? `project:${job.projectId}`
        : projectRef
          ? `project-ref:${projectRef}`
          : `cwd:${job.cwd}`,
      version: job.version,
      updatedAt: job.updatedAt,
      lastProgressAt: job.lastProgressAt,
      ...(job.lastProgress ? { lastProgress: { ...job.lastProgress } } : {}),
      pendingInteractions: [...job.pendingInteractions],
      ...(publicEvent ? { publicEvent } : {})
    };
  }

  private claimImmediateProgressPersistence(): boolean {
    if (this.progressPersistenceImmediateRemaining <= 0) return false;
    this.progressPersistenceImmediateRemaining -= 1;
    if (!this.progressPersistenceImmediateReset) {
      this.progressPersistenceImmediateReset = setImmediate(() => {
        this.progressPersistenceImmediateReset = undefined;
        this.progressPersistenceImmediateRemaining = PROGRESS_PERSISTENCE_IMMEDIATE_BUDGET;
      });
      this.progressPersistenceImmediateReset.unref();
    }
    return true;
  }

  private persistDeferredProgress(snapshot: ProgressPersistenceSnapshot): void {
    const current = this.jobs.get(snapshot.jobId);
    if (!current || isTerminalActivityJobStatus(current.status)) return;
    const persisted = this.progressPersisted.get(snapshot.jobId);
    if (persisted && persisted.version >= snapshot.version) return;
    this.persistProgressSnapshotBestEffort(snapshot);
  }

  /** Explicit Job-retention command used by mutation boundaries and the
   * independent maintenance scheduler. Registry reads never enter this path. */
  maintainRetainedJobs(options: {
    maxInspected?: number;
    maxRemoved?: number;
    maxDurationMs?: number;
  } = {}): number {
    this.assertNonforcingAdmission();
    options = this.admittedData(options);
    const startedAt = performance.now();
    try {
      this.refreshProjectIdentities();
      try {
        const command = this.retainedJobMaintenanceCommand(options);
        const result = executeOperationalStateCommand(this.activityStore, command);
        return this.applyRetainedJobMaintenanceResult(command, result);
      } catch (error) {
        if (!this.nonforcingPinned) this.retainedJobMaintenanceIterator = undefined;
        this.recordPersistenceWarning("Could not persist Codex job pruning",error);
        return 0;
      }
    } finally {
      this.waitDiagnosticsTracker.pruneAndPersist.record(performance.now() - startedAt);
    }
  }

  private stateMaintenanceCommand(slice: (typeof STATE_MAINTENANCE_SLICES)[number]): OperationalStateCommand {
    return slice === "jobs"
      ? this.retainedJobMaintenanceCommand()
      : { operation: "maintain", slice };
  }

  private applyStateMaintenanceResult(
    command: OperationalStateCommand,
    result: OperationalStateResult
  ): void {
    if (command.slice === "jobs") this.applyRetainedJobMaintenanceResult(command, result);
  }

  private retainedJobMaintenanceCommand(options: {
    maxInspected?: number;
    maxRemoved?: number;
    maxDurationMs?: number;
  } = {}): OperationalJobRetentionCommand {
    const maxInspected = Math.max(1, Math.min(256, Math.floor(options.maxInspected ?? 64)));
    const maxRemoved = Math.max(1, Math.min(64, Math.floor(options.maxRemoved ?? 32)));
    const maxDurationMs = Math.max(1, Math.min(1_000, Math.floor(options.maxDurationMs ?? 10)));
    const deadline = performance.now() + maxDurationMs;
    this.retainedJobMaintenanceIterator ||= this.jobs.entries();
    const inspected: Array<[string, CodexJob]> = [];
    while (inspected.length < maxInspected) {
      if (inspected.length > 0 && performance.now() >= deadline) break;
      const next = this.retainedJobMaintenanceIterator.next();
      if (next.done) {
        this.retainedJobMaintenanceIterator = undefined;
        break;
      }
      const [jobId, job] = next.value;
      if (this.jobs.get(jobId) === job) inspected.push([jobId, job]);
    }

    const now = Date.now();
    const cutoffAt = now - this.ttlMs;
    const retentionTarget = Math.min(this.maxJobs, this.retainedJobTarget ?? this.maxJobs);
    const admissionReservations = this.retainedJobAdmissionReservations();
    const candidates = inspected
      .filter(([, job]) =>
        isTerminalActivityJobStatus(job.status) &&
        (
          job.updatedAt < cutoffAt ||
          admissionReservations > retentionTarget ||
          this.retentionProtectedJobs.has(job.jobId)
        )
      )
      .sort((left, right) =>
        left[1].updatedAt - right[1].updatedAt || left[0].localeCompare(right[0])
      )
      .map(([jobId, job]) => ({
        jobId,
        version: job.version,
        updatedAt: job.updatedAt,
        knownProtected: this.retentionProtectedJobs.has(jobId)
      }));
    return {
      operation: "maintain",
      slice: "jobs",
      now,
      cutoffAt,
      completionResultRecoveryMs: this.ttlMs,
      retentionTarget,
      admissionReservations,
      maxRemoved,
      maxDurationMs,
      candidates
    };
  }

  private applyRetainedJobMaintenanceResult(
    command: OperationalJobRetentionCommand,
    result: OperationalStateResult
  ): number {
    if (
      result.operation !== "maintain" ||
      result.slice !== "jobs" ||
      !result.jobRetention ||
      !Number.isSafeInteger(result.changed) ||
      result.changed < 0 ||
      !Array.isArray(result.jobRetention.classifications) ||
      result.jobRetention.classifications.length > command.candidates.length ||
      !Number.isSafeInteger(result.jobRetention.remainingAdmissionReservations) ||
      result.jobRetention.remainingAdmissionReservations < 0
    ) {
      throw new Error("STATE_RESULT_INVALID: Job retention result is missing its classification.");
    }
    const classifications = result.jobRetention.classifications;
    for (const [index, classification] of classifications.entries()) {
      const candidate = command.candidates[index];
      if (
        !candidate ||
        candidate.jobId !== classification.jobId ||
        candidate.version !== classification.version ||
        candidate.updatedAt !== classification.updatedAt ||
        candidate.knownProtected !== classification.knownProtected ||
        !["protected", "retained", "removed", "skipped"].includes(classification.disposition)
      ) {
        throw new Error("STATE_RESULT_INVALID: Job retention classification does not match its command.");
      }
    }
    if (result.changed !== classifications.filter(
      classification => classification.disposition === "removed"
    ).length) {
      throw new Error("STATE_RESULT_INVALID: Job retention change count does not match its classification.");
    }
    let removed = 0;
    for (const [index, classification] of classifications.entries()) {
      const candidate = command.candidates[index]!;
      const current = this.jobs.get(classification.jobId);
      if (
        !current ||
        current.version !== candidate.version ||
        current.updatedAt !== candidate.updatedAt ||
        !isTerminalActivityJobStatus(current.status)
      ) continue;
      if (classification.disposition === "protected") {
        this.retentionProtectedJobs.add(classification.jobId);
      } else if (classification.disposition !== "skipped") {
        this.retentionProtectedJobs.delete(classification.jobId);
      }
      if (classification.disposition !== "removed") continue;
      this.deleteIndexedJob(classification.jobId);
      this.progressPersistenceQueue.remove(
        snapshot => snapshot.jobId === classification.jobId
      );
      this.progressPersisted.delete(classification.jobId);
      this.lastWake.delete(classification.jobId);
      this.retentionProtectedJobs.delete(classification.jobId);
      removed += 1;
    }
    if (
      this.retainedJobTarget !== undefined &&
      this.retainedJobAdmissionReservations() <= this.retainedJobTarget
    ) this.retainedJobTarget = undefined;
    return removed;
  }

  private refreshProjectIdentities(): void {
    if (this.nonforcingPinned) return;
    const revision = this.activityStore.getProjectRegistryRevision();
    if (revision === this.projectedProjectRevision) return;
    const activities = new Map(
      this.activityStore.listActivityProjectIdentities().map((activity) => [
        activity.activityId,
        activity
      ])
    );
    for (const job of this.jobs.values()) {
      const activity = activities.get(job.activityId);
      if (!activity) {
        delete job.projectId;
        delete job.projectName;
        continue;
      }
      job.projectId = activity.projectId;
      job.projectName = activity.projectName;
    }
    this.projectedProjectRevision = revision;
  }

  private isAllowedCwd(cwd: string): boolean {
    if (this.allowedRoots.length === 0) return true;
    return this.allowedRoots.some((root) => isPathWithinRoot(cwd, root));
  }
}

type CardPerformanceSample = {
  durationMs: number;
  requests: number;
  timeouts: number;
  cacheHits: number;
};

export class CardPerformanceTracker {
  private readonly samples = new Map<string, CardPerformanceSample[]>();

  record(
    name: string,
    durationMs: number,
    counters: Partial<Omit<CardPerformanceSample, "durationMs">> = {}
  ): void {
    const entries = this.samples.get(name) || [];
    entries.push({
      durationMs: Math.max(0, Math.round(durationMs)),
      requests: counters.requests || 0,
      timeouts: counters.timeouts || 0,
      cacheHits: counters.cacheHits || 0
    });
    if (entries.length > 128) entries.splice(0, entries.length - 128);
    this.samples.set(name, entries);
  }

  snapshot(): Omit<
    z.infer<typeof diagnosticsOutputSchema>["performance"],
    "jobWaits" | "stateMaintenance"
  > {
    const percentile = (values: number[], fraction: number): number => {
      if (values.length === 0) return 0;
      return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] || 0;
    };
    return {
      stages: [...this.samples.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([name, samples]) => {
          const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
          return {
            name,
            count: samples.length,
            p50Ms: percentile(durations, 0.5),
            p95Ms: percentile(durations, 0.95),
            maxMs: durations.at(-1) || 0,
            requests: samples.reduce((total, sample) => total + sample.requests, 0),
            timeouts: samples.reduce((total, sample) => total + sample.timeouts, 0),
            cacheHits: samples.reduce((total, sample) => total + sample.cacheHits, 0)
          };
        }),
      html: {
        dashboardBytes: Buffer.byteLength(DASHBOARD_CARD_HTML, "utf8"),
        dashboardBudgetBytes: DASHBOARD_CARD_HTML_MAX_BYTES,
        settingsBytes: Buffer.byteLength(SETTINGS_CARD_HTML, "utf8"),
        settingsBudgetBytes: SETTINGS_CARD_HTML_MAX_BYTES
      }
    };
  }
}

// MCP sessions sharing one runtime also share in-flight app mutations. This
// closes the gap between a side effect and its durable replay record.
const appMutationOperations = new WeakMap<CodexJobRegistry, Map<string, {
  actionHash: string; promise: Promise<unknown>;
}>>();

export function registerBridgeTools(
  server: McpServer,
  config: BridgeConfig,
  upstream: CodexUpstream,
  sessions: SessionRegistry,
  jobs: CodexJobRegistry,
  modelCatalog: CodexModelCatalogProvider,
  userSettings: UserSettingsStore,
  scopeResolver: ScopeResolver,
  projectAvailability?: TaskProjectAvailabilityProjection,
  sharedCardPerformance?: CardPerformanceTracker,
  skillLibrary?: SkillLibrary,
  readProjection?: BridgeReadProjectionService,
  runtimeOptions: {
    onOperationFailure?: (error: unknown) => void;
    conformanceFixtures?: boolean;
    canAcceptNewJobs?: () => boolean;
  } = {}
): {
  applicationService: BridgeApplicationService;
  dispose(): void;
} {
  jobs.attachUpstream(upstream, sessions);
  // MCP 2026 list results must be deterministic. Register immutable card
  // resources in URI order; input tools do not add a resource.
  registerDashboardCardResource(server);
  const codexInputs = registerCodexInputTools(server, jobs, scopeResolver);
  registerSettingsCardResource(server);
  const cardPerformance = sharedCardPerformance || new CardPerformanceTracker();
  const effectiveSkillLibrary = skillLibrary || new SkillLibrary({
    directory: config.bridgeSkillsDirectory
  });
  const taskExecutionEnvelopeRef = () => userSettings.taskExecutionEnvelopeRef();
  // A modern HTTP request receives a fresh McpServer, while the task
  // descriptor itself is stable across mutable user settings. There is no
  // session-bound descriptor mutation or tools/list_changed recovery path.
  const publishTaskProjection = (_catalog?: CodexModelCatalogSnapshot) => ({
    descriptorProjectionUpdated: false,
    developerModeRefreshRequired: false
  });
  const runtimeAdmission = jobs.runtimeAdmission;
  const executionAcceptingNewJobs = () => runtimeOptions.canAcceptNewJobs?.() !== false;
  const acceptingNewJobs = () =>
    !jobs.nonforcingShutdownPinned && runtimeAdmission.acceptingNewJobs && runtimeAdmission.storageError === undefined &&
    executionAcceptingNewJobs();
  let testTaskReadStorageError =
    runtimeOptions.conformanceFixtures && process.env.NODE_ENV === "test" &&
      /^SQLITE_[A-Z0-9_]+$/u.test(
        process.env.CODEX_MCP_BRIDGE_TEST_TASK_READ_STORAGE_ERROR || ""
      )
      ? process.env.CODEX_MCP_BRIDGE_TEST_TASK_READ_STORAGE_ERROR
      : undefined;
  let backgroundProcessImpact: BridgeBackgroundProcessImpact = {
    state: "unknown",
    processes: 0,
    agents: 0,
    unknownAgents: 0
  };
  const runtimeAdmissionSnapshot = async (
    options: BridgeRuntimeSnapshotOptions = {}
  ): Promise<BridgeRuntimeAdmissionSnapshot> => {
    if (options.inspectBackgroundProcesses) {
      backgroundProcessImpact = await inspectBridgeBackgroundProcessImpact(jobs, upstream);
    }
    const memoryOnlyImpact = classifyMemoryOnlyThreadImpact(
      sessions.list(),
      (threadId, backendKind) => upstream.canResumeThread?.(threadId, backendKind) === true,
      threadId => jobs.admissionStateStore.threadConnections.hasUnfinishedWork(threadId)
    );
    const authSource = config.codexService?.environment.CODEX_MCP_BRIDGE_AUTH_SOURCE;
    const account = config.codexService?.cachedAccount("app-server");
    return {
      ...(config.codexService ? { authConnection: {
        source: authSource === "bridge-chatgpt" || authSource === "bridge-api" || authSource === "disconnected"
          ? authSource : "shared" as const,
        mode: account?.authMode || "unknown" as const,
        observedAt: account?.observedAt || null
      } } : {}),
      acceptingNewJobs: acceptingNewJobs(),
      activeJobs: jobs.runningCount(),
      pendingAdmissions: runtimeAdmission.pendingAdmissions,
      pendingInteractions: jobs.list(config.maxRetainedJobs).reduce((count, job) => count + job.pendingInteractions.length, 0),
      ...memoryOnlyImpact,
      backgroundProcessState: backgroundProcessImpact.state,
      backgroundProcesses: backgroundProcessImpact.processes,
      backgroundProcessAgents: backgroundProcessImpact.agents,
      backgroundProcessUnknownAgents: backgroundProcessImpact.unknownAgents
    };
  };
  const acquireRuntimeAdmission = (): (() => void) => {
    if (runtimeAdmission.storageError) {
      throw new Error(
        `STATE_STORAGE_UNAVAILABLE: Persistent state storage is ` +
        `${runtimeAdmission.storageError}; retry only after a confirmed state commit.`
      );
    }
    if (jobs.nonforcingShutdownPinned || !runtimeAdmission.acceptingNewJobs) {
      throw new Error(
        "BRIDGE_DRAINING: The app is preparing to stop or restart the bridge. " +
        "No new Codex work is being admitted; retry after the runtime is available."
      );
    }
    if (!executionAcceptingNewJobs()) {
      throw new Error(
        "EXECUTION_UNAVAILABLE: The isolated Codex execution service is not ready. " +
        "No Job was created; retry after execution readiness recovers."
      );
    }
    runtimeAdmission.pendingAdmissions += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!jobs.nonforcingShutdownPinned)
        runtimeAdmission.pendingAdmissions = Math.max(0, runtimeAdmission.pendingAdmissions - 1);
    };
  };
  type AccountObservation = {
    value: Awaited<ReturnType<NonNullable<BridgeConfig["codexService"]>["readAccount"]>>;
    failed: boolean;
  };
  const weeklyUsageFromAccount = (account: CodexAccountSnapshot | null): CodexWeeklyUsageView | null => {
    if (account?.authMode !== "chatgpt" || account.ownershipConflict ||
        account.usageObservedAt === null) return null;
    const window = account.windows.find(candidate =>
      candidate.limitId === "codex" && candidate.windowDurationMins === 10_080);
    if (!window || !Number.isFinite(account.usageObservedAt)) return null;
    const observedAt = new Date(account.usageObservedAt);
    if (!Number.isFinite(observedAt.getTime())) return null;
    const reset = window.resetsAt === null ? null : new Date(window.resetsAt * 1_000);
    return codexWeeklyUsageOutputSchema.parse({
      source: "codex-account-rate-limits",
      limitId: window.limitId,
      usedPercent: window.usedPercent,
      remainingPercent: window.remainingPercent,
      windowDurationMins: window.windowDurationMins,
      resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
      observedAt: observedAt.toISOString()
    });
  };
  const accountDisplayReads = new DisplayReadPool<AccountObservation>(1, () => notifyCardObservation(upstream));
  let accountCompletion: { revision: string; failed: boolean } | undefined;
  let lastVerifiedAccount: { revision: string; context: string | null } | undefined;
  const readAccountForDisplay = async () => {
    const service = config.codexService;
    if (!service) return { pending: false as const, value: { value: null, failed: false } };
    const revision = service.cacheRevision();
    const startingContext = service.accountDisplayContext();
    accountDisplayReads.invalidate(key => key !== revision);
    const read = accountDisplayReads.start(revision, async () => {
      try {
        const value = await service.readAccount(config.defaultBackend, true,
          startingContext === null);
        if (startingContext !== null && startingContext !== service.accountDisplayContext()) {
          return { value: null, failed: false };
        }
        return { value, failed: value === null ||
          value.authMode === "chatgpt" && value.usageStatus === "unavailable" };
      } catch { return { value: null, failed: true }; }
    }, (value, deferred) => {
      if (revision !== service.cacheRevision()) return;
      accountCompletion = { revision, failed: value.failed };
      if (deferred) notifyCardObservation(upstream);
    });
    const result = read ? await waitForDisplay(read, CARD_USAGE_TIMEOUT_MS) : { pending: true as const };
    // A replaced account is neither a current value nor a failure of the new one.
    return revision === service.cacheRevision() ? result
      : { pending: false as const, value: { value: null, failed: false } };
  };
  type AccountDisplayRead = Awaited<ReturnType<typeof readAccountForDisplay>>;
  const projectAccountForDisplay = (
    view: DashboardView,
    account?: AccountDisplayRead
  ): void => {
    const service = config.codexService;
    if (!service) {
      view.usageDisplayStatus = view.enrichment.usageTimedOut ? "timed-out"
        : view.enrichment.usageUnavailable ? "unavailable"
        : view.weeklyUsage ? "available"
        : view.enrichment.state === "enriched" ? "unavailable" : "checking";
      return;
    }
    const revision = service.cacheRevision();
    const displayContext = service.accountDisplayContext();
    let displayed = service.cachedAccount(config.defaultBackend);
    let currentRead = false;
    if (account) {
      if (account.pending) {
        view.enrichment.pendingReads = (view.enrichment.pendingReads || 0) + 1;
        view.enrichment.usageTimedOut = true;
      } else {
        if (account.value.value) {
          displayed = account.value.value;
          currentRead = true;
        }
        if (account.value.failed) view.enrichment.usageUnavailable = true;
      }
    } else {
      view.enrichment.pendingReads = (view.enrichment.pendingReads || 0) +
        accountDisplayReads.observePending(key => key === revision);
      if (accountCompletion?.revision === revision && accountCompletion.failed) {
        view.enrichment.usageUnavailable = true;
      }
    }
    const currentContext = service.accountDisplayContext();
    view.usageContext = currentContext;
    if (currentContext !== displayContext ||
        revision !== service.cacheRevision()) {
      displayed = null;
      currentRead = false;
      view.usageContext = null;
    }
    // A stable file identity may reuse a previous observation during refresh.
    // Keyring/auto has no such identity: only this completed account read may
    // put a number on the card, even if an upstream usage cache exists.
    if (view.usageContext === null && !currentRead) displayed = null;
    view.codexAccount = displayed;
    view.weeklyUsage = weeklyUsageFromAccount(displayed);
    if (currentRead && displayed) {
      lastVerifiedAccount = { revision, context: view.usageContext ?? null };
    }
    const identityChanged = Boolean(lastVerifiedAccount &&
      (lastVerifiedAccount.context !== null
        ? lastVerifiedAccount.context !== view.usageContext
        : lastVerifiedAccount.revision !== revision));
    view.usageDisplayStatus = account?.pending ? "timed-out"
      : account && !account.pending && account.value.failed && !currentRead ? "unavailable"
      : displayed?.authMode === "unknown" || displayed?.authenticated === false ? "signed-out"
      : displayed?.authMode === "api-key" ? "not-applicable"
      : displayed?.ownershipConflict ? "unavailable"
      : displayed?.authMode === "chatgpt" && displayed.usageStatus === "unavailable" ? "unavailable"
      : view.weeklyUsage ? currentRead ? "available" : "checking"
      : displayed?.authMode === "chatgpt" && currentRead ? "no-limit"
      : view.enrichment.usageUnavailable ? "unavailable"
      : identityChanged ? "switching" : "checking";
    const accountObservedAt = view.codexAccount?.usageObservedAt;
    if (typeof accountObservedAt === "number") {
      view.enrichment.oldestObservationAt = [
        view.enrichment.oldestObservationAt,
        new Date(accountObservedAt).toISOString()
      ].filter((date): date is string => Boolean(date)).sort()[0];
    }
  };
  const historyTarget = (rowKey: string) => {
    const agent = listAllDashboardAgents(jobs).find(candidate => dashboardRowKey(candidate.agentId) === rowKey);
    if (!agent) throw new Error("HISTORY_TARGET_CHANGED: Refresh the selected execution.");
    const job = jobs.admissionStateStore.workHistory.latestJob(agent.agentId);
    return {agent,job,revision:dashboardHistoryRevision(agent,job)};
  };
  const applicationService: BridgeApplicationService = {
    async skillLibrarySnapshot() {
      // The native library screen manages the same bridge-owned store as MCP.
      return effectiveSkillLibrary.search({ includeDisabled: true });
    },
    async readBridgeSkill(reference) {
      if (reference.source !== BRIDGE_SKILL_SOURCE) {
        throw new Error("SKILL_SOURCE_UNSUPPORTED: The native library can manage bridge-owned skills only.");
      }
      return effectiveSkillLibrary.read({ reference });
    },
    async readBridgeSkillFile(reference, filePath) {
      if (reference.source !== BRIDGE_SKILL_SOURCE) {
        throw new Error("SKILL_SOURCE_UNSUPPORTED: The native library can manage bridge-owned skills only.");
      }
      return effectiveSkillLibrary.readFile({ reference, path: filePath });
    },
    listBridgeSkillVersions(input) {
      return effectiveSkillLibrary.listBridgeSkillVersions(input);
    },
    createBridgeSkill(input) {
      return effectiveSkillLibrary.createBridgeSkill(input);
    },
    createBridgeSkillFromPackage(input) {
      return effectiveSkillLibrary.createBridgeSkillFromPackage(input);
    },
    updateBridgeSkill(input) {
      return effectiveSkillLibrary.updateBridgeSkill(input);
    },
    updateBridgeSkillFromPackage(input) {
      return effectiveSkillLibrary.updateBridgeSkillFromPackage(input);
    },
    restoreBridgeSkill(input) {
      return effectiveSkillLibrary.restoreBridgeSkill(input);
    },
    setBridgeSkillEnabled(input) {
      return effectiveSkillLibrary.setBridgeSkillEnabled(input);
    },
    deleteBridgeSkill(input) {
      return effectiveSkillLibrary.deleteBridgeSkill(input);
    },
    beginBridgeSkillPackageUpload() {
      return effectiveSkillLibrary.beginBridgeSkillPackageUpload();
    },
    appendBridgeSkillPackageUpload(input) {
      return effectiveSkillLibrary.appendBridgeSkillPackageUpload(input);
    },
    inspectBridgeSkillPackageUpload(uploadId) {
      return effectiveSkillLibrary.inspectBridgeSkillPackageUpload(uploadId);
    },
    async exportBridgeSkillPackage(reference) {
      const data = await effectiveSkillLibrary.exportBridgeSkillPackage(reference);
      return {
        fileName: `${reference.skillId}-v${reference.version}.zip`,
        mediaType: "application/zip" as const,
        bytes: data.byteLength,
        contentDigest: createHash("sha256").update(data).digest("hex"),
        data: data.toString("base64")
      };
    },
    async problemAction(rawInput, scopeId, source = "operator") {
      const input = problemActionSchema.parse(rawInput);
      const firstKey = input.targets[0]!.problemKey;
      const scope = scopeId || (["acknowledge", "unacknowledge"].includes(input.action)
        ? jobs.admissionStateStore.workHistory.problemJobs().find(job => job.problemKey === firstKey)?.scopeId
        : listAllDashboardAgents(jobs).find(agent => problemKey("runtime", agent.agentId) === firstKey)?.scopeId);
      if (!scope) throw new Error("PROBLEM_TARGET_CHANGED: Refresh the selected problems.");
      const digest = problemOperationDigest(input);
      return runIdempotentMutation(scope,input.requestId,digest,async () => {
        if (input.action === "acknowledge" || input.action === "unacknowledge") {
          const available = new Map(jobs.admissionStateStore.workHistory.problemJobs(scopeId).map(job => [job.problemKey,job]));
          const targets = input.targets.map(target => {
            const job = available.get(target.problemKey);
            if (!job || job.revision !== target.expectedRevision ||
              Boolean(job.acknowledgedAt) !== (input.action === "unacknowledge")) {
              throw new Error("PROBLEM_TARGET_CHANGED: Refresh the selected executions. No problems were changed.");
            }
            return job;
          });
          jobs.reviewHistoryIssues(targets,input.action === "acknowledge");
          return {ok:true,changed:targets.length};
        }
        const target = input.targets[0]!;
        const agent = listAllDashboardAgents(jobs,scopeId).find(agent => problemKey("runtime",agent.agentId) === target.problemKey);
        if (!agent) throw new Error("PROBLEM_TARGET_CHANGED: Refresh the selected runtime problem.");
        const requireCurrent = () => {
          const current = jobs.getAgent(agent.agentId);
          if (!current || dashboardRuntimeProblemIdentity(jobs,current).revision !== target.expectedRevision) {
            throw new Error("PROBLEM_TARGET_CHANGED: The work changed. Refresh before trying again.");
          }
          return current;
        };
        const current = requireCurrent();
        if (input.action === "retry-stop") {
          const job = current.currentJobId ? jobs.get(current.currentJobId) : undefined;
          if (!job || job.status !== "termination-failed") throw new Error("PROBLEM_TARGET_CHANGED: Only a failed termination can be retried here.");
          const impact = jobs.terminationImpact(job.jobId).affectedJobIds.slice().sort();
          if (JSON.stringify(impact) !== JSON.stringify(input.acknowledgeAffectedJobIds?.slice().sort())) {
            throw new Error("PROBLEM_STOP_IMPACT_CHANGED: Review every affected execution before retrying termination.");
          }
          return jobs.runCancellationMutation(job.scopeId,input.requestId,digest,async () => {
            requireCurrent();
            const {intent} = jobs.beginCancellationOperation({scopeId:job.scopeId,requestId:input.requestId,actionHash:digest,
              source,toolName:"dashboard.problem",actionName:"retry-stop",target:cancellationTargetForJob(job),
              expectedVersion:job.version,reasonCode:"problem-termination-retry"});
            await jobs.cancel(job.jobId,intent,{acknowledgeAffectedJobIds:input.acknowledgeAffectedJobIds});
            const result = {ok:true,changed:1};
            jobs.completeCancellationOperation(job.scopeId,input.requestId,result);
            return result;
          });
        }
        const thread = jobs.listAgentThreads(current.agentId).find(thread => thread.isCurrent);
        if (!thread || !backendSupports(thread.backendKind,"supportsThreadInspection")) {
          throw new Error("PROBLEM_INSPECTION_UNAVAILABLE: The current thread cannot be inspected.");
        }
        const latestJob = jobs.listForAgent(current.agentId).at(-1);
        const inspect = async (inspectLiveness: boolean) => {
          const candidate = {agentId:current.agentId,thread,stamp:dashboardRuntimeStamp(current,latestJob),inspectLiveness};
          const read = runtimeReadPool(upstream).start(`problem\0${current.agentId}\0${target.expectedRevision}\0${inspectLiveness}`,
            isCurrent => inspectDashboardRuntime(upstream,candidate,isCurrent), (result,deferred) => {
              if (jobs.getAgent(current.agentId)?.version !== current.version) return;
              const cache = dashboardRuntimeCaches.get(upstream) || new Map<string,DashboardRuntimeCacheEntry>();
              dashboardRuntimeCaches.set(upstream,cache);
              cacheDashboardRuntime(cache,candidate,result,deferred,jobs);
              notifyCardObservation(upstream);
            });
          const result = read ? await waitForDisplay(read,CARD_RUNTIME_BUDGET_MS) : {pending:true as const};
          if (result.pending || read?.invalidated) throw new Error("PROBLEM_INSPECTION_PENDING: Process inspection is still pending. Refresh to see its result.");
          return result.value.observation;
        };
        let observation = await inspect(true);
        if (observation.state === "orphaned") observation = await inspect(false);
        const fresh = requireCurrent();
        const activeJob = jobs.listForAgent(fresh.agentId).some(job => isActiveActivityJobStatus(job.status));
        if (fresh.lifecycle === "orphaned" && !fresh.currentJobId && !activeJob &&
          ["idle","not-loaded"].includes(observation.state) && observation.backgroundProcessState === "confirmed" && observation.backgroundProcessCount === 0) {
          // The second, non-loading inspection confirms that the missing
          // thread has no remaining work. Clear only this check's uncertainty;
          // the next fresh failed inspection sets it again.
          const cached = dashboardRuntimeCaches.get(upstream)?.get(dashboardRuntimeCacheKey(thread));
          if (cached?.stamp !== dashboardRuntimeStamp(fresh,latestJob) || cached.inspectedObservation !== observation) {
            throw new Error("PROBLEM_INSPECTION_CHANGED: A newer inspection replaced this result. Check the current runtime state again.");
          }
          cached.observation = observation;
          cached.unavailable = false;
          jobs.resolveHistoryRuntimeProblem(fresh,target.expectedRevision);
          jobs.admissionStateStore.automaticRecovery.observeRecheck(recheckRecoveryIdentity(jobs,fresh),false,Date.now(),"not-loaded-no-background");
          return {ok:true,changed:1};
        }
        return {ok:true,changed:0};
      }) as Promise<ProblemActionResult>;
    },
    async historyAction(input) {
      input = dashboardHistoryActionInput.parse(input);
      const initial = historyTarget(input.rowKey);
      const actionHash = createHash("sha256").update(JSON.stringify(["work-history",input])).digest("hex");
      return runIdempotentMutation(initial.agent.scopeId,input.requestId,actionHash,async () => {
        const requireCurrent = () => {
          const target = historyTarget(input.rowKey);
          if (target.revision !== input.expectedRevision) throw new Error("HISTORY_TARGET_CHANGED: Refresh the selected execution.");
          if (target.agent.currentJobId || ["active","waiting-input"].includes(target.agent.lifecycle)) {
            throw new Error("AGENT_BUSY: Finish the current work before changing this Agent's history state.");
          }
          return target;
        };
        const target = requireCurrent();
        if (!target.job) throw new Error("HISTORY_TARGET_CHANGED: Refresh the selected execution.");
        jobs.acknowledgeHistoryIssue(target.job.jobId, target.agent.scopeId);
        return {ok:true as const};
      }) as Promise<{ok:true}>;
    },
    async threadHandoff(input) {
      const agent = listAllDashboardAgents(jobs).find(candidate => dashboardRowKey(candidate.agentId) === input.rowKey);
      const thread = agent && jobs.listAgentThreads(agent.agentId).find(candidate => input.codexThreadUrl === `codex://threads/${candidate.threadId}` &&
        (input.action !== "request" || candidate.isCurrent));
      if (!agent || !thread || thread.backendKind !== "app-server" || input.codexThreadUrl !== `codex://threads/${thread.threadId}`) {
        throw new Error("THREAD_HANDOFF_TARGET_CHANGED: Refresh this Agent before continuing in Codex.");
      }
      const record = jobs.threadHandoff(thread.threadId, input.action);
      return { phase: record.phase, ...(record.reason !== undefined ? { reason: record.reason } : {}), requested: record.handoffRequested,
        canOpen: record.phase === "released" && Boolean(record.evidence) };
    },
    async claimNativeCompletionNotifications(input) {
      // Native alerts are a separate, explicit Activity channel. They never
      // stand in for the default live-card ChatGPT completion delivery.
      return jobs.claimNativeCompletionNotifications(input.limit ?? 10, input.leaseOwner)
        .flatMap((record) => record.channel === "notify"
          ? [nativeCompletionNotification({
              outboxId: record.outboxId,
              scopeId: record.scopeId,
              activityId: record.activityId,
              completionVersion: record.completionVersion,
              channel: "notify"
            })]
          : []);
    },
    async markNativeCompletionNotificationsDelivered(input) {
      jobs.markNativeCompletionNotificationsDelivered(input.outboxIds, input.leaseOwner);
    },
    async releaseNativeCompletionNotifications(input) {
      jobs.releaseNativeCompletionNotifications(input.outboxIds, input.leaseOwner);
    },
    subscribeChanges(listener) {
      if (jobs.nonforcingShutdownPinned) throw new Error("NONFORCING_SHUTDOWN_PINNED");
      const publish = (topic: "settings" | "dashboard" | "enrichment") => {
        if(!jobs.nonforcingShutdownPinned)jobs.publishApplicationChange(()=>Reflect.apply(listener,undefined,[topic]));
      };
      const subscriptions:Array<(()=>void)|undefined>=[];
      const register=(receiver:object,key:string,callback:()=>void)=>{
        const subscribe=(receiver as Record<string,unknown>)[key];
        if(jobs.nonforcingShutdownPinned)throw new Error('NONFORCING_SHUTDOWN_PINNED');
        if(subscribe===undefined)return undefined;
        if(typeof subscribe!=='function')throw new Error('STATE_APPLICATION_SUBSCRIPTION_UNCONFIRMED');
        return Reflect.apply(subscribe,receiver,[callback]);
      };
      try {
        for(const subscription of [
          ()=>jobs.subscribeChanges(()=>publish('dashboard')),
          ()=>register(userSettings,'subscribeChanges',()=>{publish('settings');publish('dashboard');}),
          ()=>register(modelCatalog,'subscribe',()=>publish('settings')),
          ()=>subscribeCardObservations(upstream,()=>publish('enrichment'))
        ])subscriptions.push(jobs.registerApplicationSubscription(subscription));
      }catch(error){jobs.releaseApplicationSubscriptions(subscriptions);throw error;}
      return ()=>jobs.releaseApplicationSubscriptions(subscriptions);
    },
    async dashboardSnapshot(options = {}) {
      const startedAt = Date.now();
      const accountRead = options.inspectRuntime ? readAccountForDisplay().catch(() => ({ pending: false as const, value: { value: null, failed: true } })) : undefined;
      const view = await buildDashboardView(
        jobs,
        upstream,
        modelCatalog,
        sessions,
        scopeResolver,
        config,
        userSettings.current,
        options.limit || 12,
        options.terminalOffset || 0,
        options.idleOffset || 0,
        options.inspectRuntime === true,
        undefined,
        undefined,
        options.scopeId,
        options.statusFilter,
        options.problems,
        options.includeHistory !== false
      );
      projectAccountForDisplay(view, accountRead ? await accountRead : undefined);
      const stage = view.enrichment.state === "enriched"
        ? "dashboard.enriched.total"
        : "dashboard.structural.db-projection";
      cardPerformance.record(stage, Date.now() - startedAt, {
        requests: view.enrichment.runtimeRequests,
        timeouts: view.enrichment.timeouts + (view.enrichment.usageTimedOut ? 1 : 0),
        cacheHits: view.enrichment.cacheHits
      });
      const serializationStartedAt = Date.now();
      for (const row of [...view.activeRows, ...view.terminalRows, ...view.idleRows, ...(view.statusRows || [])]) {
        const threadId = row.codexThreadUrl?.replace("codex://threads/", "");
        const connection = threadId ? jobs.admissionStateStore.threadConnections.get(threadId) : undefined;
        if (connection) row.handoff = { phase: connection.phase,
          ...(connection.reason !== undefined ? { reason: connection.reason } : {}),
          requested: connection.handoffRequested, canOpen: connection.phase === "released" && Boolean(connection.evidence) };
      }
      JSON.stringify(view);
      cardPerformance.record("dashboard.serialization", Date.now() - serializationStartedAt);
      return view;
    },
    async dashboardRuntimePlan(options = {}) {
      return buildDashboardRuntimePlan(
        jobs,
        upstream,
        modelCatalog,
        sessions,
        scopeResolver,
        config,
        userSettings.current,
        options.limit || 12,
        options.terminalOffset || 0,
        options.idleOffset || 0,
        options.scopeId,
        options.statusFilter,
        options.problems,
        options.includeHistory !== false
      );
    },
    async dashboardSnapshotWithEnrichment(options, projectedEnrichment) {
      const startedAt = Date.now();
      const view = await buildDashboardView(
        jobs,
        upstream,
        modelCatalog,
        sessions,
        scopeResolver,
        config,
        userSettings.current,
        options.limit || 12,
        options.terminalOffset || 0,
        options.idleOffset || 0,
        true,
        undefined,
        dashboardEnrichmentInput(projectedEnrichment),
        options.scopeId,
        options.statusFilter,
        options.problems,
        options.includeHistory !== false
      );
      cardPerformance.record("dashboard.enriched.read-projection", Date.now() - startedAt, {
        requests: view.enrichment.runtimeRequests,
        timeouts: view.enrichment.timeouts + (view.enrichment.usageTimedOut ? 1 : 0),
        cacheHits: view.enrichment.cacheHits
      });
      const serializationStartedAt = Date.now();
      for (const row of [
        ...view.activeRows,
        ...view.terminalRows,
        ...view.idleRows,
        ...(view.statusRows || [])
      ]) {
        const threadId = row.codexThreadUrl?.replace("codex://threads/", "");
        const connection = threadId
          ? jobs.admissionStateStore.threadConnections.get(threadId)
          : undefined;
        if (connection) {
          row.handoff = {
            phase: connection.phase,
            ...(connection.reason !== undefined ? { reason: connection.reason } : {}),
            requested: connection.handoffRequested,
            canOpen: connection.phase === "released" && Boolean(connection.evidence)
          };
        }
      }
      JSON.stringify(view);
      cardPerformance.record("dashboard.serialization", Date.now() - serializationStartedAt);
      return view;
    },
    async dashboardHistoryDetail(options) {
      const startedAt = Date.now();
      const detail = buildDashboardHistoryDetail(jobs, modelCatalog, options);
      cardPerformance.record("dashboard.history-detail.db-projection", Date.now() - startedAt, {
        requests: 0,
        timeouts: 0,
        cacheHits: 0
      });
      const serializationStartedAt = Date.now();
      JSON.stringify(detail);
      cardPerformance.record("dashboard.history-detail.serialization", Date.now() - serializationStartedAt);
      return detail;
    },
    async settingsSnapshot(options = {}) {
      const startedAt = Date.now();
      const view = await buildSettingsView(
        config,
        userSettings,
        modelCatalog,
        options.refreshModels || false
      );
      view.historyPolicy = jobs.admissionStateStore.workHistory.policy(userSettings.current.historyRetentionDays);
      const projectionStatus = publishTaskProjection(
        modelCatalog.getCachedCatalog?.({ backendKind: config.defaultBackend })
      );
      view.policyActivation.descriptorProjectionUpdated =
        projectionStatus.descriptorProjectionUpdated;
      view.policyActivation.developerModeRefreshRequired =
        projectionStatus.developerModeRefreshRequired;
      cardPerformance.record("settings.structural.db-projection", Date.now() - startedAt);
      const serializationStartedAt = Date.now();
      JSON.stringify(view);
      cardPerformance.record("settings.serialization", Date.now() - serializationStartedAt);
      return view;
    },
    async modelDescriptionHistory(input) {
      return userSettings.modelDescriptionHistory(input.modelId, input.beforeVersion);
    },
    updateSettings(input) {
      return applySettingsMutation(input);
    },
    runtimeSnapshot(options) {
      return runtimeAdmissionSnapshot(options);
    },
    runtimeHealth() {
      return {
        acceptingNewJobs: acceptingNewJobs(),
        activeJobs: jobs.observedRunningCount(),
        pendingAdmissions: runtimeAdmission.pendingAdmissions,
        progressPersistence: jobs.progressPersistenceStatus(),
        backgroundProcessState: backgroundProcessImpact.state,
        backgroundProcesses: backgroundProcessImpact.processes,
        backgroundProcessAgents: backgroundProcessImpact.agents,
        backgroundProcessUnknownAgents: backgroundProcessImpact.unknownAgents
      };
    },
    beginDrain(options) {
      runtimeAdmission.acceptingNewJobs = false;
      return runtimeAdmissionSnapshot(options);
    },
    cancelDrain() {
      if (!jobs.nonforcingShutdownPinned) runtimeAdmission.acceptingNewJobs = true;
      return runtimeAdmissionSnapshot();
    },
    pinNonforcingShutdown() {return jobs.pinNonforcingShutdown();},
    observeNonforcingExit() {return jobs.observeNonforcingExit();},
    setStorageAdmissionError(error) {
      runtimeAdmission.storageError = error;
    }
  };
  if (readProjection) {
    applicationService.dashboardSnapshot = async (options = {}) => {
      if (!options.inspectRuntime) {
        const view = await readProjection.dashboardSnapshot(options);
        projectAccountForDisplay(view);
        return view;
      }
      const accountRead = config.codexService
        ? readAccountForDisplay().catch(() => ({
            pending: false as const,
            value: { value: null, failed: true }
          }))
        : undefined;
      const plan = await readProjection.dashboardRuntimePlan(options);
      const projectedEnrichment = await enrichDashboardRuntimePlan(upstream, plan, undefined,
        !config.codexService);
      const view = await readProjection.dashboardSnapshotWithEnrichment(
        options,
        projectedEnrichment
      );
      projectAccountForDisplay(view, accountRead ? await accountRead : undefined);
      return view;
    };
    applicationService.dashboardHistoryDetail = options =>
      readProjection.dashboardHistoryDetail(options);
    applicationService.settingsSnapshot = options =>
      readProjection.settingsSnapshot(options);
  }
  const currentTaskAdmissionRef = (
    settings: BridgeUserSettings = userSettings.current,
    catalogFingerprint = admissionFingerprintForCatalog(
      modelCatalog.getCachedCatalog?.({ backendKind: config.defaultBackend })
    )
  ) => userSettings.executionPolicyRef(settings, catalogFingerprint);
  const mutationInFlight = appMutationOperations.get(jobs) || new Map<
    string, { actionHash: string; promise: Promise<unknown> }
  >();
  appMutationOperations.set(jobs, mutationInFlight);
  const runIdempotentMutation = async (
    scopeId: string,
    requestId: string,
    actionHash: string,
    operation: () => Promise<unknown>
  ): Promise<unknown> => {
    const replay = jobs.getAgentMutation(scopeId, requestId);
    if (replay) {
      if (replay.actionHash !== actionHash) {
        throw new Error("requestId was already used for a different mutation in this scope.");
      }
      return replay.result;
    }
    const key = `${scopeId}\0${requestId}`;
    const active = mutationInFlight.get(key);
    if (active) {
      if (active.actionHash !== actionHash) {
        throw new Error("requestId is already executing a different mutation in this scope.");
      }
      return active.promise;
    }
    const promise = Promise.resolve()
      .then(operation)
      .then((result) => {
        jobs.recordAgentMutation(scopeId, requestId, actionHash, result);
        return result;
      });
    mutationInFlight.set(key, { actionHash, promise });
    try {
      return await promise;
    } finally {
      if (mutationInFlight.get(key)?.promise === promise) mutationInFlight.delete(key);
    }
  };
  const runCancellationMutation = async (
    scopeId: string,
    requestId: string,
    actionHash: string,
    operation: () => Promise<unknown>
  ): Promise<unknown> => jobs.runCancellationMutation(
    scopeId,
    requestId,
    actionHash,
    operation
  );

  const controlProofs = uiControlProofs(jobs);
  const requireControlCard = (
    args: { scopeId?: string; widgetInstanceId?: string; card: z.infer<typeof userControlProofInputSchema>; jobId?: string; agentId?: string },
    meta: unknown
  ) => {
    const widgetSessionId = mountedWidgetInstanceId(args, meta);
    if (!widgetSessionId) throw new Error("MOUNTED_DASHBOARD_REQUIRED: Open the Dashboard work details before using a control.");
    const host = scopeResolver.resolve(meta as ToolCallMetadata, args.scopeId);
    const claims = controlProofs.require(args.card.token, widgetSessionId, host?.scopeId);
    if (claims.purpose === "history") throw new Error("UI_CONTROL_STALE: Open the work details before controlling execution.");
    const agent = jobs.getAgent(claims.agentId), activity = jobs.getActivity(claims.activityId);
    if (!agent || !activity || agent.scopeId !== claims.scopeId || activity.scopeId !== claims.scopeId ||
      activity.cardGeneration !== claims.generation ||
      (args.jobId !== undefined && args.jobId !== claims.jobId) ||
      (args.agentId !== undefined && args.agentId !== claims.agentId)) {
      throw new Error("UI_CONTROL_TARGET_CHANGED: Refresh the selected work details.");
    }
    // Domain handlers still check the exact current Job/Agent version and state
    // immediately before dispatch. Proof identity never grants model scope.
    return { scope: { scopeId: claims.scopeId }, widgetSessionId, claims };
  };
  const controlDetailInput = z.strictObject({ view: z.literal("control"), rowKey: z.string().regex(/^[a-f0-9]{32}$/),
    widgetInstanceId: widgetInstanceIdSchema, scopeId: scopeIdSchema().optional() });
  const readControl: ToolCallback<typeof controlDetailInput> = async (args, extra) => {
    const host = scopeResolver.resolve(extra.mcpReq._meta as ToolCallMetadata, args.scopeId);
    const agent = listAllDashboardAgents(jobs).find(agent => dashboardRowKey(agent.agentId) === args.rowKey);
    if (!agent) throw new Error("UI_CONTROL_UNAVAILABLE: The selected Agent is unavailable.");
    const ownedJobs = jobs.listForAgent(agent.agentId);
    const job = agent.currentJobId ? jobs.get(agent.currentJobId) : ownedJobs.at(-1);
    const activity = job && jobs.getActivity(job.activityId);
    if (!job || !activity || activity.scopeId !== agent.scopeId || job.scopeId !== agent.scopeId) {
      throw new Error("UI_CONTROL_UNAVAILABLE: No retained work is available for this Agent.");
    }
    const pendingInteractions = job.pendingInteractions
      .filter((interaction) => !ordinaryCodexQuestion(interaction))
      .slice(0, MAX_CODEX_INTERACTION_QUESTIONS);
    if (pendingInteractions.length === 0) {
      throw new Error("UI_CONTROL_UNAVAILABLE: This Agent has no pending response request.");
    }
    const initialVersion = agent.version, initialJobVersion = job.version;
    if (jobs.getAgent(agent.agentId)?.version !== initialVersion || jobs.get(job.jobId)?.version !== initialJobVersion) {
      throw new Error("UI_CONTROL_TARGET_CHANGED: Work changed while reading its details. Refresh the details.");
    }
    const claims: Omit<UiControlClaims, "version" | "expiresAt"> = {
      widgetInstanceId: args.widgetInstanceId, hostScopeId: host?.scopeId || null, scopeId: agent.scopeId,
      activityId: activity.activityId, generation: activity.cardGeneration, agentId: agent.agentId,
      agentVersion: agent.version, jobId: job.jobId, jobVersion: job.version
    };
    const card = { kind: "dashboard", token: controlProofs.issue(claims) };
    const detail = { kind: "control", rowKey: args.rowKey, agentId: agent.agentId, agentName: agent.agentName,
      agentVersion: agent.version, activityTitle: activity.title, projectName: job.projectName || null,
      conversationUrl: scopeResolver.conversationUrl(agent.scopeId), card,
      jobId: job.jobId, jobVersion: job.version, status: job.status,
      pendingInteractions: pendingInteractions.map(interaction => ({ ...interaction,
        ordinary: ordinaryCodexQuestion(interaction),
        ...(interaction.elicitation ? { elicitation: { ...interaction.elicitation, ...jobs.interactionInput(interaction.interactionId) } } : {}) })) };
    if (Buffer.byteLength(JSON.stringify(detail)) > 128 * 1024) throw new Error("UI_CONTROL_TOO_LARGE: The work details exceed the card limit.");
    return { content: [{ type: "text", text: "Work details loaded." }], structuredContent: { kind: "control", ready: true },
      _meta: { "codex/uiControl@1": detail } };
  };

  const reviewProofs = problemReviewProofs(jobs);
  const problemControlDetailInput = z.strictObject({view:z.literal("problem-control"),operation:problemOperationSchema,
    widgetInstanceId:widgetInstanceIdSchema,scopeId:scopeIdSchema().optional(),scope:z.enum(["conversation","all"])});
  const readProblemControl: ToolCallback<typeof problemControlDetailInput> = async (args,extra) => {
    const host = scopeResolver.resolve(extra.mcpReq._meta as ToolCallMetadata,args.scopeId);
    const widget = mountedWidgetInstanceId(args,extra.mcpReq._meta);
    if (!widget) throw new Error("MOUNTED_WIDGET_REQUIRED: Refresh the mounted problem list.");
    if (args.scope === "conversation" && !host) throw new Error("DASHBOARD_CONVERSATION_UNAVAILABLE: Reopen the card in its conversation.");
    const selectedScopeId = args.scope === "conversation" ? host!.scopeId : undefined;
    if (["acknowledge","unacknowledge"].includes(args.operation.action)) {
      const available = new Map(jobs.admissionStateStore.workHistory.problemJobs(selectedScopeId).map(job => [job.problemKey,job]));
      for (const target of args.operation.targets) {
        const job = available.get(target.problemKey);
        if (!job || job.revision !== target.expectedRevision || Boolean(job.acknowledgedAt) !== (args.operation.action === "unacknowledge")) {
          throw new Error("PROBLEM_TARGET_CHANGED: Refresh the selected executions.");
        }
      }
    } else {
      const target = args.operation.targets[0]!;
      const agent = listAllDashboardAgents(jobs,selectedScopeId).find(agent => problemKey("runtime",agent.agentId) === target.problemKey);
      if (!agent || dashboardRuntimeProblemIdentity(jobs,agent).revision !== target.expectedRevision) {
        throw new Error("PROBLEM_TARGET_CHANGED: Refresh the selected runtime problem.");
      }
      if (args.operation.action === "retry-stop") {
        const job = agent.currentJobId ? jobs.get(agent.currentJobId) : undefined;
        if (!job || job.status !== "termination-failed" ||
          JSON.stringify(jobs.terminationImpact(job.jobId).affectedJobIds.slice().sort()) !== JSON.stringify(args.operation.acknowledgeAffectedJobIds?.slice().sort())) {
          throw new Error("PROBLEM_STOP_IMPACT_CHANGED: Review the current termination impact.");
        }
      }
    }
    const operationDigest = problemOperationDigest(args.operation);
    const token = reviewProofs.issue({widgetInstanceId:widget,hostScopeId:host?.scopeId || null,selectedScopeId:selectedScopeId || null,operationDigest});
    return {content:[{type:"text",text:"Problem action ready."}],structuredContent:{kind:"control",ready:true},
      _meta:{"codex/problemControl@1":{token,operationDigest}}};
  };

  const skillReferenceInput = z.strictObject({
    skillId: z.string().regex(/^bridge_[a-f0-9]{32}$/).describe("Exact skill id returned by bridge_skill search."),
    source: z.literal(BRIDGE_SKILL_SOURCE).describe("Bridge-owned skill source returned by bridge_skill search."),
    version: z.string().regex(/^[1-9]\d*$/).describe("Exact bridge skill version returned by bridge_skill search.")
  });
  // Zod measures `.max()` in UTF-16 code units. Bound that representation,
  // then use the shared scalar counter that also defines the storage policy.
  const bridgeSkillNameInput = z.string().min(1)
    .max(BRIDGE_SKILL_LIMITS.nameMaxCharacters * 2)
    .refine((value) => hasAtMostUnicodeScalars(
      value, BRIDGE_SKILL_LIMITS.nameMaxCharacters, "Bridge skill name"
    ));
  const bridgeSkillDescriptionInput = z.string()
    .max(BRIDGE_SKILL_LIMITS.descriptionMaxCharacters * 2)
    .refine((value) => hasAtMostUnicodeScalars(
      value, BRIDGE_SKILL_LIMITS.descriptionMaxCharacters, "Bridge skill description"
    ));
  const bridgeSkillContentInput = z.string().min(1).max(BRIDGE_SKILL_LIMITS.contentMaxBytes)
    .refine((value) => Buffer.byteLength(value, "utf8") <= BRIDGE_SKILL_LIMITS.contentMaxBytes, {
      message: `Skill content must be at most ${BRIDGE_SKILL_LIMITS.contentMaxBytes} UTF-8 bytes.`
    })
    .refine((value) => !value.includes("\u0000"), { message: "Skill content cannot contain NUL characters." });
  const bridgeSkillFilePathInput = z.string().min(1).max(BRIDGE_SKILL_LIMITS.filePathMaxBytes)
    .describe("Logical relative .md or .markdown path returned by bridge_skill. Never use a host filesystem path.");
  const bridgeSkillFileInput = z.strictObject({
    path: bridgeSkillFilePathInput,
    content: z.string().max(BRIDGE_SKILL_LIMITS.fileMaxBytes)
      .refine((value) => Buffer.byteLength(value, "utf8") <= BRIDGE_SKILL_LIMITS.fileMaxBytes, {
        message: `Skill file must be at most ${BRIDGE_SKILL_LIMITS.fileMaxBytes} UTF-8 bytes.`
      })
      .refine((value) => !value.includes("\u0000"), { message: "Skill file cannot contain NUL characters." })
  });
  const bridgeSkillInput = z.discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("search"),
      query: z.string().max(BRIDGE_SKILL_LIMITS.searchQueryMaxBytes)
        .refine((value) => Buffer.byteLength(value, "utf8") <= BRIDGE_SKILL_LIMITS.searchQueryMaxBytes, {
          message: `Search text must be at most ${BRIDGE_SKILL_LIMITS.searchQueryMaxBytes} UTF-8 bytes.`
        })
        .optional()
        .describe("Task, goal, or procedure to search for. Omit to list available skills."),
      limit: z.number().int().min(1).max(100).optional()
    }),
    z.strictObject({
      operation: z.literal("read"),
      skill: skillReferenceInput
    }),
    z.strictObject({
      operation: z.literal("read-file"),
      skill: skillReferenceInput,
      path: bridgeSkillFilePathInput
    }),
    z.strictObject({
      operation: z.literal("versions"),
      skillId: z.string().regex(/^bridge_[a-f0-9]{32}$/).describe("Bridge skill id whose immutable version history should be listed.")
    })
  ]);
  const bridgeSkillManageInput = z.discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("create"),
      requestId: scopeIdSchema().describe("Unique UUID for this logical bridge skill mutation. Reuse only for an exact retry."),
      name: bridgeSkillNameInput,
      description: bridgeSkillDescriptionInput.optional().describe("Optional discovery summary. Content remains the complete skill body."),
      content: bridgeSkillContentInput.describe("Complete free-form Markdown skill content. The bridge preserves it without adding frontmatter or splitting sections."),
      files: z.array(bridgeSkillFileInput).max(BRIDGE_SKILL_LIMITS.fileMaxCount).optional()
        .describe("Optional independent Markdown files in the same immutable skill version. Paths are logical relative paths.")
    }),
    z.strictObject({
      operation: z.literal("create-package"),
      requestId: scopeIdSchema().describe("Unique UUID for this logical bridge skill mutation. Reuse only for an exact retry."),
      name: bridgeSkillNameInput,
      description: bridgeSkillDescriptionInput.optional(),
      uploadId: scopeIdSchema().describe("Expiring upload id supplied by a trusted binary-upload adapter after ZIP inspection."),
      mainPath: bridgeSkillFilePathInput.describe("Exact inspected Markdown path selected as the skill content."),
      includePaths: z.array(bridgeSkillFilePathInput).min(1).max(BRIDGE_SKILL_LIMITS.fileMaxCount).optional()
    }),
    z.strictObject({
      operation: z.literal("update"),
      requestId: scopeIdSchema().describe("Unique UUID for this logical bridge skill mutation. Reuse only for an exact retry."),
      skillId: z.string().regex(/^bridge_[a-f0-9]{32}$/).describe("Exact bridge-origin skill id."),
      expectedVersion: z.string().regex(/^[1-9]\d*$/).describe("Current version read before this mutation. A successful update creates the next immutable version."),
      name: bridgeSkillNameInput.optional(),
      description: bridgeSkillDescriptionInput.optional(),
      content: bridgeSkillContentInput.optional(),
      files: z.strictObject({
        upsert: z.array(bridgeSkillFileInput).max(BRIDGE_SKILL_LIMITS.fileMaxCount).optional(),
        remove: z.array(bridgeSkillFilePathInput).max(BRIDGE_SKILL_LIMITS.fileMaxCount).optional()
      }).optional().describe("Atomic attachment changes applied with the skill content and metadata update.")
    }).refine((value) => value.name !== undefined || value.description !== undefined || value.content !== undefined || value.files !== undefined, {
      message: "Provide at least one field to update."
    }),
    z.strictObject({
      operation: z.literal("update-package"),
      requestId: scopeIdSchema().describe("Unique UUID for this logical bridge skill mutation. Reuse only for an exact retry."),
      skillId: z.string().regex(/^bridge_[a-f0-9]{32}$/),
      expectedVersion: z.string().regex(/^[1-9]\d*$/),
      uploadId: scopeIdSchema().describe("Expiring upload id supplied by a trusted binary-upload adapter after ZIP inspection."),
      mainPath: bridgeSkillFilePathInput.nullable().describe("Select replacement skill content, or null to import all inspected Markdown as attachments."),
      includePaths: z.array(bridgeSkillFilePathInput).min(1).max(BRIDGE_SKILL_LIMITS.fileMaxCount).optional()
    }),
    z.strictObject({
      operation: z.literal("restore"),
      requestId: scopeIdSchema().describe("Unique UUID for this logical bridge skill mutation. Reuse only for an exact retry."),
      skillId: z.string().regex(/^bridge_[a-f0-9]{32}$/),
      expectedVersion: z.string().regex(/^[1-9]\d*$/).describe("Current version read before this mutation."),
      sourceVersion: z.string().regex(/^[1-9]\d*$/).describe("Historical immutable version to copy into a new current version.")
    }),
    z.strictObject({
      operation: z.literal("set-enabled"),
      requestId: scopeIdSchema().describe("Unique UUID for this logical bridge skill mutation. Reuse only for an exact retry."),
      skillId: z.string().regex(/^bridge_[a-f0-9]{32}$/),
      expectedVersion: z.string().regex(/^[1-9]\d*$/).describe("Current version read before this mutation."),
      enabled: z.boolean().describe("False archives the skill from Bridge discovery while preserving immutable history.")
    })
  ]);
  server.registerTool(
    "bridge_skill",
    {
      title: "Find and Read Bridge Skills",
      description:
        "Find and read reusable bridge-owned Markdown skills. Search by goal, read an exact immutable version to get its content and file inventory, then use read-file only for relevant attached Markdown. Reading never starts Codex, executes a script, or changes permissions.",
      inputSchema: bridgeSkillInput,
      outputSchema: bridgeSkillOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      if (args.operation === "search") {
        const result = await effectiveSkillLibrary.search({
          query: args.query,
          limit: args.limit
        });
        const structured = bridgeSkillSearchOutputSchema.parse({ kind: "skill-search", ...result });
        return contractedToolResult(
          skillResultContract,
          result,
          structured,
          { content: bridgeSkillPrimaryContent(structured) }
        );
      }

      if (args.operation === "versions") {
        const result = await effectiveSkillLibrary.listBridgeSkillVersions({ skillId: args.skillId });
        const structured = bridgeSkillVersionsOutputSchema.parse({ kind: "skill-versions", ...result });
        return contractedToolResult(
          skillResultContract,
          result,
          structured,
          { content: bridgeSkillPrimaryContent(structured) }
        );
      }

      if (args.operation === "read-file") {
        const result = await effectiveSkillLibrary.readFile({ reference: args.skill as SkillReference, path: args.path });
        const structured = bridgeSkillFileOutputSchema.parse(result);
        return contractedToolResult(
          skillResultContract,
          result,
          structured,
          { content: bridgeSkillPrimaryContent(structured) }
        );
      }

      const result = await effectiveSkillLibrary.read({ reference: args.skill as SkillReference });
      const { skill: summary, ...body } = result;
      const structured = bridgeSkillReadOutputSchema.parse({ kind: "skill", skill: { ...summary, ...body } });
      return contractedToolResult(
        skillResultContract,
        result,
        structured,
        { content: bridgeSkillPrimaryContent(structured) }
      );
    }
  );

  server.registerTool(
    "bridge_skill_manage",
    {
      title: "Manage a Bridge Skill",
      description:
        "Create, version, restore, or archive a bridge-owned free-form Markdown skill and its optional Markdown file tree. Every mutation requires a requestId for exact retries. Content and file updates are atomic and append-only: prior versions remain immutable.",
      inputSchema: bridgeSkillManageInput,
      outputSchema: bridgeSkillManageOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => {
      const skill = args.operation === "create"
        ? await effectiveSkillLibrary.createBridgeSkill({
            requestId: args.requestId,
            name: args.name,
            description: args.description,
            content: args.content,
            files: args.files
          })
        : args.operation === "create-package"
          ? await effectiveSkillLibrary.createBridgeSkillFromPackage({
              requestId: args.requestId,
              name: args.name,
              description: args.description,
              uploadId: args.uploadId,
              mainPath: args.mainPath,
              includePaths: args.includePaths
            })
        : args.operation === "update"
          ? await effectiveSkillLibrary.updateBridgeSkill({
              requestId: args.requestId,
              skillId: args.skillId,
              expectedVersion: args.expectedVersion,
              ...(args.name === undefined ? {} : { name: args.name }),
              ...(args.description === undefined ? {} : { description: args.description }),
              ...(args.content === undefined ? {} : { content: args.content }),
              ...(args.files === undefined ? {} : { files: args.files })
            })
          : args.operation === "update-package"
            ? await effectiveSkillLibrary.updateBridgeSkillFromPackage({
                requestId: args.requestId,
                skillId: args.skillId,
                expectedVersion: args.expectedVersion,
                uploadId: args.uploadId,
                mainPath: args.mainPath,
                includePaths: args.includePaths
              })
          : args.operation === "restore"
            ? await effectiveSkillLibrary.restoreBridgeSkill({
                requestId: args.requestId,
                skillId: args.skillId,
                expectedVersion: args.expectedVersion,
                sourceVersion: args.sourceVersion
              })
            : await effectiveSkillLibrary.setBridgeSkillEnabled({
                requestId: args.requestId,
                skillId: args.skillId,
                expectedVersion: args.expectedVersion,
                enabled: args.enabled
              });
      const action = args.operation;
      const structured = bridgeSkillManageOutputSchema.parse({
        kind: "skill-mutation",
        action,
        requestId: args.requestId,
        skill,
        message: action === "create" || action === "create-package"
          ? `Created bridge skill ${JSON.stringify(skill.name)} at version ${skill.version}.`
          : action === "update" || action === "update-package"
            ? `Created version ${skill.version} of bridge skill ${JSON.stringify(skill.name)}.`
            : action === "restore"
              ? `Restored historical content as version ${skill.version} of bridge skill ${JSON.stringify(skill.name)}.`
              : skill.enabled
                ? `Enabled bridge skill ${JSON.stringify(skill.name)}.`
                : `Archived bridge skill ${JSON.stringify(skill.name)}; immutable history remains readable.`
      });
      return contractedToolResult(
        skillManageResultContract,
        structured,
        structured,
        { text: structured.message }
      );
    }
  );

  const codexDashboardInput = z.strictObject({
    scopeId: scopeIdSchema()
      .optional()
      .describe("Conversation UUID for hosts that do not supply scoped MCP metadata."),
    scope: z.enum(["conversation", "all"]).optional().describe(
      "Open a conversation-scoped Dashboard when the host identifies this conversation, or open all retained work."
    ),
    jobId: z.string().uuid().optional().describe(
      "Exact asynchronous Job from a codex_task Dashboard render action. It may be used only with scope='conversation'."
    ),
    presentationRef: z.string().regex(/^[a-f0-9]{64}$/).optional().describe(
      "Non-authorizing correlation reference paired with jobId by a codex_task Dashboard render action."
    )
  }).superRefine((value, context) => {
    if (Boolean(value.jobId) !== Boolean(value.presentationRef)) {
      context.addIssue({
        code: "custom",
        path: value.jobId ? ["presentationRef"] : ["jobId"],
        message: "jobId and presentationRef must be supplied together."
      });
    }
  });
  const dashboardSnapshotInput = z.strictObject({
    problems: problemQuerySchema.optional(),
    scopeId: scopeIdSchema().optional(),
    statusFilter: z.enum(DASHBOARD_STATUS_FILTERS).optional().describe(
      "Select the current three-category overview and filter its rows. Counts cover the full selected conversation scope before filtering and pagination."
    ),
    widgetInstanceId: widgetInstanceIdSchema.optional(),
    scope: z.enum(["auto", "conversation", "all"]).optional().describe(
      "Initial auto selects this conversation when it has Activity or Job records; conversation and all retain an explicit selection."
    ),
    limit: z.number().int().min(5).max(50).optional(),
    terminalOffset: z.number().int().min(0).max(1_000_000_000).optional(),
    idleOffset: z.number().int().min(0).max(1_000_000_000).optional(),
    enrich: z.boolean().optional().describe(
      "Request bounded runtime and weekly-usage enrichment after the default structural snapshot."
    ),
    includeHistory: z.boolean().optional().describe(
      "Include paged run history. Current cards omit it until the user opens history."
    )
  });
  const dashboardHistoryDetailInput = z.strictObject({
    view: z.literal("dashboard-history"),
    rowKey: z.string().regex(/^[0-9a-f]{32}$/),
    widgetInstanceId: widgetInstanceIdSchema,
    scopeId: scopeIdSchema().optional(),
    scope: z.enum(["conversation", "all"])
  });
  const jobCompletionIdentityInput = {
    jobId: z.string().uuid(),
    presentationRef: z.string().regex(/^[a-f0-9]{64}$/),
    widgetInstanceId: widgetInstanceIdSchema
  } as const;
  const jobCompletionReceiptInput = z.string().regex(/^completion-[a-f0-9]{64}$/);
  const jobCompletionDeliveryInput = z.discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("wait"),
      ...jobCompletionIdentityInput,
      waitMs: z.number().int().min(1).max(10_000).optional()
    }),
    z.strictObject({
      operation: z.literal("accepted"),
      ...jobCompletionIdentityInput,
      receipt: jobCompletionReceiptInput
    }),
    z.strictObject({
      operation: z.literal("rejected"),
      ...jobCompletionIdentityInput,
      receipt: jobCompletionReceiptInput,
      error: z.string().max(500).optional()
    }),
    z.strictObject({
      operation: z.literal("uncertain"),
      ...jobCompletionIdentityInput,
      receipt: jobCompletionReceiptInput
    }),
    z.strictObject({
      operation: z.literal("release"),
      ...jobCompletionIdentityInput,
      receipt: jobCompletionReceiptInput
    })
  ]);

  server.registerTool(
    "codex_dashboard",
    {
      title: `${PRODUCT_INFO.displayName} Codex Status`,
      description:
        "Open the Codex status card. It starts with this conversation when it has Activity or Job records, including completed history; otherwise it shows all conversations. For a codex_task result that supplies a Dashboard render action, call this tool immediately with its scope, jobId, and presentationRef before replying; that scoped render mounts the automatic Dashboard in that conversation. The user can switch between this conversation and all work in the card.",
      inputSchema: codexDashboardInput,
      outputSchema: dashboardModelOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: dashboardCardToolMetadata()
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      // The card can open without host identity and start in the all-work view.
      // Supplied metadata must still be validated before returning the opener.
      const scope = scopeResolver.resolve(_meta as ToolCallMetadata, args.scopeId);
      if (args.scope === "conversation" && !scope) {
        throw new Error("DASHBOARD_CONVERSATION_UNAVAILABLE: Reopen the Dashboard in its conversation.");
      }
      const presentationJob = args.jobId
        ? (() => {
            if (args.scope !== "conversation" || !scope) {
              throw new Error(
                "DASHBOARD_AUTOMATIC_PRESENTATION_UNAVAILABLE: Render the Dashboard in the originating conversation."
              );
            }
            const job = jobs.get(args.jobId);
            if (!job || job.scopeId !== scope.scopeId) {
              throw new Error(
                "DASHBOARD_AUTOMATIC_PRESENTATION_UNAVAILABLE: The requested work is unavailable in this conversation."
              );
            }
            if (args.presentationRef !== dashboardPresentationRef(job)) {
              throw new Error(
                "DASHBOARD_AUTOMATIC_PRESENTATION_UNAVAILABLE: Refresh the exact Dashboard render action for this Job."
              );
            }
            return job;
          })()
        : undefined;
      const automaticPresentation = Boolean(presentationJob);
      const completionDeliveryRoute = presentationJob?.completionDeliveryPolicy;
      const summary = presentationJob
        ? presentationJob.completionDeliveryPolicy === "direct-wait"
          ? "The originating conversation Dashboard is open for this Codex job; experimental direct-result delivery remains owned by the bounded status wait."
          : "The originating conversation Dashboard is open for this Codex job."
        : args.scope === "conversation"
        ? "The Codex status card is open for this conversation."
        : "The Codex status card is open. The card loads current retained work, starting with this conversation when it has records and otherwise showing all conversations.";
      return contractedToolResult(dashboardModelResultContract, {}, {
        kind: "dashboard", scope: "bridge-wide", readOnly: true,
        statusSource: "codex-runtime-only", summary
      }, { text: summary }, { appHydration: {
        "openai/locale": resolvePreferredUiLocale(userSettings.current.uiLocalePreference,
          metadataString(_meta, "openai/locale") || metadataString(_meta, "webplus/i18n")),
        "codex/dashboardOpen@1": {
          scope: automaticPresentation ? "conversation" : args.scope || "auto",
          automatic: automaticPresentation,
          ...(automaticPresentation
            ? {
                presentationRef: args.presentationRef,
                completionDeliveryRoute: completionDeliveryRoute!
              }
            : {})
        }
      } });
    }
  );

    const readDashboard: ToolCallback<typeof dashboardSnapshotInput> = async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      const widgetInstanceId = mountedWidgetInstanceId(args, _meta);
      if (!widgetInstanceId) {
        throw new Error(
          "MOUNTED_WIDGET_REQUIRED: Refresh the mounted Codex status card before retrying."
        );
      }
      // Status reads can use the personal all-work view without host identity.
      // An explicit conversation selection must retain its scope. Supplied
      // metadata is still validated, including on cross-client restoration.
      const openingScope = scopeResolver.resolve(_meta as ToolCallMetadata, args.scopeId);
      const conversationHasWork = Boolean(openingScope &&
        jobs.admissionStateStore.hasDashboardWork(openingScope.scopeId));
      const mode = args.scope === "conversation" || args.scope === "auto" && conversationHasWork
        ? "conversation" : "all";
      if (mode === "conversation" && !openingScope) {
        throw new Error("DASHBOARD_CONVERSATION_UNAVAILABLE: This host did not identify the opening conversation. Select all work or reopen the status card.");
      }
      const view = await applicationService.dashboardSnapshot({
        problems: args.problems,
        scopeId: mode === "conversation" ? openingScope!.scopeId : undefined,
        statusFilter: args.statusFilter,
        limit: args.limit || 12,
        terminalOffset: args.terminalOffset || 0,
        idleOffset: args.idleOffset || 0,
        inspectRuntime: args.enrich !== false,
        includeHistory: args.includeHistory !== false
      });
      if (args.scope !== undefined) {
        view.filter = { mode, conversationAvailable: Boolean(openingScope), conversationHasWork };
      }
      return dashboardViewResult(
        view,
        metadataString(_meta, "openai/locale") || metadataString(_meta, "webplus/i18n"),
        dashboardAppResultContract
      );
    };

    const readDashboardHistoryDetail: ToolCallback<typeof dashboardHistoryDetailInput> = async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      if (!mountedWidgetInstanceId(args, _meta)) {
        throw new Error("MOUNTED_WIDGET_REQUIRED: Refresh the mounted Codex status card before retrying.");
      }
      const openingScope = scopeResolver.resolve(_meta as ToolCallMetadata, args.scopeId);
      if (args.scope === "conversation" && !openingScope) {
        throw new Error("DASHBOARD_CONVERSATION_UNAVAILABLE: Reopen the card in its conversation.");
      }
      if (!applicationService.dashboardHistoryDetail) {
        throw new Error("DASHBOARD_HISTORY_DETAIL_UNSUPPORTED: Refresh the Codex status card.");
      }
      const detail = await applicationService.dashboardHistoryDetail({
        rowKey: args.rowKey,
        scopeId: args.scope === "conversation" ? openingScope!.scopeId : undefined
      });
      return {
        content: [{ type: "text", text: "Execution history loaded." }],
        structuredContent: detail
      };
    };

  const statusJobIdInput = z.string().trim().min(1).max(200)
    .describe("Exact job id returned by codex_task.");
  const statusJobWaitForInput = z.enum(["change", "terminal"])
    .describe("Wait for the next change or a terminal state.");
  const statusJobWaitMsInput = z.number().int().min(1).max(MAX_CODEX_STATUS_WAIT_MS).optional()
    .describe(`Bounded wait duration; defaults to ${DEFAULT_CODEX_STATUS_WAIT_MS} milliseconds.`);
  const statusActivityQueryInput = z.strictObject({
    kind: z.literal("activity"),
    id: scopeIdSchema().describe("Exact Activity id in the current conversation scope.")
  });
  const statusThreadQueryInput = z.strictObject({
    kind: z.literal("thread"),
    id: z.string().trim().min(1).max(200)
      .describe("Exact Codex thread id in the current conversation scope.")
  });
  const statusPageQueryInput = z.strictObject({
    kind: z.literal("page"),
    collection: z.enum(["sessions", "jobs", "activities"]),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().trim().min(1).max(200).optional()
  });
  const statusJobQueryInput = z.strictObject({
    kind: z.literal("job"),
    id: statusJobIdInput,
    waitFor: statusJobWaitForInput.optional(),
    waitMs: statusJobWaitMsInput
  }).refine(
    (query) => query.waitMs === undefined || query.waitFor !== undefined,
    "waitFor is required whenever waitMs is sent."
  ).describe("Read one exact Job or its minimal expired-result admission receipt, optionally waiting for a change or terminal state.");
  const statusRequestQueryInput = z.strictObject({
    kind: z.literal("request"),
    requestId: scopeIdSchema().describe(
      "Logical codex_task requestId. Use this after an admission response is lost to recover the one existing Job without starting another execution."
    ),
    waitFor: statusJobWaitForInput.optional(),
    waitMs: statusJobWaitMsInput
  }).refine(
    (query) => query.waitMs === undefined || query.waitFor !== undefined,
    "waitFor is required whenever waitMs is sent."
  ).describe("Resolve one exact Job or minimal expired-result admission receipt by its scope-bound logical requestId.");
  const statusCompletionQueryInput = z.strictObject({
    kind: z.literal("completion"),
    receipt: z.string().regex(/^completion-[a-f0-9]{64}$/).describe(
      "Opaque receipt supplied by the live Dashboard completion message. The authenticated conversation scope remains authoritative."
    )
  }).describe("Read the exact retained terminal Job selected by a live Dashboard completion receipt.");
  const statusInputQueryInput = z.strictObject({
    kind: z.literal("input"),
    ...codexInputs.questionInputSchema.shape
  });
  const statusProjectQueryInput = z.strictObject({
    kind: z.literal("project"),
    name: projectNameInput().describe("Exact user-visible project name. Reads its current selector without executing Codex or opening a card.")
  });
  const codexStatusQueryInput = z.union([
    statusJobQueryInput,
    statusRequestQueryInput,
    statusCompletionQueryInput,
    statusInputQueryInput,
    statusActivityQueryInput,
    statusThreadQueryInput,
    statusPageQueryInput,
    statusProjectQueryInput
  ]);
  const codexStatusInput = z.strictObject({
    query: codexStatusQueryInput.optional(),
    scopeId: scopeIdSchema()
      .optional()
      .describe("Conversation UUID for hosts that do not supply scoped MCP metadata.")
  });

  server.registerTool(
    "codex_status",
    {
      title: `${PRODUCT_INFO.displayName} Status`,
      description:
        "Read project selectors and Codex work state, ordinary questions, and results in the current conversation. Exact Job change/terminal waits are bounded reads; a terminal wait wakes only for terminal lifecycle state, not ordinary progress, and an aborted or timed-out read never cancels the Job. A Job marked completionDeliveryPolicy='direct-wait' requires repeated bounded terminal waits on that same exact Job until terminal; never replace it after a timeout, inspect the exact Job's supplied input action after every non-terminal return before waiting again, and stop at any new approval or user-input boundary. For the default live-card policy, a mounted originating Dashboard already watches terminal completion, so do not keep a parallel terminal wait solely to trigger the same completion delivery; manual exact reads remain supported. An authenticated exact Job or request query records only that the server offered a retained result; it does not prove GPT received the result and does not settle or cancel live-card delivery. For an automatic live-card completion message, call query kind='completion' with its opaque receipt; that response is also offer evidence, the authenticated conversation scope is still required, and the receipt never authorizes cross-conversation access.",
      inputSchema: codexStatusInput,
      outputSchema: MODEL_VISIBLE_OUTPUT_SCHEMAS.codex_status,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      const signal = extra.mcpReq.signal;
      const query = args.query;
      if (query?.kind === "input") {
        const { kind, ...input } = query;
        return codexInputs.readInput(input, extra);
      }
      const jobQuery = query?.kind === "job" || query?.kind === "request" ? query : undefined;
      const completionQuery = query?.kind === "completion" ? query : undefined;
      const activityQuery = query?.kind === "activity" ? query : undefined;
      const threadQuery = query?.kind === "thread" ? query : undefined;
      const pageQuery = query?.kind === "page" ? query : undefined;
      const scopeResolution = scopeResolver.resolve(_meta as ToolCallMetadata, args.scopeId);
      const scopeId = scopeResolution?.scopeId;
      if (query?.kind === "project") {
        if (!scopeId) throw new Error("Project lookup requires conversation metadata or an explicit scopeId.");
        return projectStatusResult(query.name, userSettings);
      }
      if (pageQuery && !scopeId) {
        throw new Error(
          "Status pagination requires conversation metadata or an explicit scopeId."
        );
      }
      if (jobQuery?.waitMs && !jobQuery.waitFor) {
        throw new Error("waitMs requires waitFor='change' or waitFor='terminal'.");
      }
      if (completionQuery) {
        const authenticatedScope = scopeResolver.resolve(
          _meta as ToolCallMetadata,
          undefined
        );
        if (!authenticatedScope || authenticatedScope.source !== "host-metadata") {
          throw new Error(
            "Completion lookup requires authenticated ChatGPT conversation metadata; an explicit scopeId is not authorization."
          );
        }
        const completionScopeId = authenticatedScope.scopeId;
        const delivery = jobs.admissionStateStore.getJobCompletionDeliveryByReceipt(
          completionQuery.receipt,
          completionScopeId
        );
        const job = delivery ? jobs.get(delivery.jobId) : undefined;
        if (
          !delivery ||
          !job ||
          job.scopeId !== completionScopeId ||
          !isTerminalActivityJobStatus(job.status)
        ) {
          throw scopedHandleUnavailable("job");
        }
        const structured = {
          kind: "job" as const,
          ...formatJobStatus(job, jobs.staleThresholdMs, undefined, userSettings.current, jobs),
          completionEvidence: exactJobCompletionEvidence(job, jobs),
          inputs: {
            cursor: codexInputCursor(job),
            ordinaryQuestions: job.pendingInteractions.filter(ordinaryCodexQuestion).length,
            approvalRequests: job.pendingInteractions.filter(q => !ordinaryCodexQuestion(q)).length,
            readTool: "codex_status" as const,
            queryKind: "input" as const
          }
        };
        const result = statusToolResult(
          compactStatusProjection(structured),
          job,
          config.maxJobResultBytes
        );
        jobs.admissionStateStore.recordJobCompletionResultOffer({
          scopeId: completionScopeId,
          source: "completion-receipt",
          receipt: completionQuery.receipt
        });
        return result;
      }
      if (jobQuery) {
        if (!scopeId) {
          throw new Error(
            "Job lookup requires conversation metadata or an explicit scopeId."
          );
        }
        const initial = jobQuery.kind === "job"
          ? jobs.get(jobQuery.id)
          : jobs.peekRequest(scopeId, jobQuery.requestId);
        if (!initial || initial.scopeId !== scopeId) {
          const receipt = jobs.admissionStateStore.getArchivedJobAdmissionReceipt(scopeId, jobQuery);
          if (!receipt) throw scopedHandleUnavailable("job");
          const completed = receipt.status === "completed";
          const structured = compactStatusProjection({
            kind: "job",
            jobId: receipt.jobId,
            status: receipt.status,
            terminal: true,
            replay: true,
            delivery: completed ? "omitted" : "none",
            result: {
              availability: completed ? "omitted" : "unavailable",
              bytes: null,
              omitted: completed
            },
            scopeView: { mode: "scoped", source: scopeResolution?.source },
            message:
              "This exact request was admitted and reached a terminal state. Its result body is no longer retained; do not start a replacement for the same logical work. A new logical turn needs its own requestId and must remain within the user's authorization."
          });
          return contractedToolResult(
            statusResultContract,
            receipt,
            structured,
            { text: statusCompatibilityText(structured) }
          );
        }
        let wait: CodexJobWaitResult | undefined;
        if (jobQuery.waitFor) {
          let observedAbort = false;
          const onAbort = () => {
            if (observedAbort) return;
            observedAbort = true;
            jobs.recordTransportObservation({
              kind: "status-wait-aborted",
              scopeId: initial.scopeId,
              jobId: initial.jobId,
              activityId: initial.activityId,
              toolName: "codex_status",
              callerRequestDigest: correlationDigest("mcp-request", extra.mcpReq.id),
              reasonCode: "host-aborted-read-wait"
            });
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
          try {
            wait = await jobs.wait(
              initial.jobId,
              jobQuery.waitFor,
              jobQuery.waitMs ?? DEFAULT_CODEX_STATUS_WAIT_MS,
              signal,
              "model-status"
            );
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
        }
        const job = wait?.job || initial;
        const structured = {
          kind: "job" as const,
          ...formatJobStatus(job, jobs.staleThresholdMs, wait, userSettings.current, jobs),
          completionEvidence: exactJobCompletionEvidence(job, jobs),
          inputs: { cursor: codexInputCursor(job), ordinaryQuestions: job.pendingInteractions.filter(ordinaryCodexQuestion).length, approvalRequests: job.pendingInteractions.filter(q => !ordinaryCodexQuestion(q)).length, readTool: "codex_status", queryKind: "input" }
        };
        const projection = compactStatusProjection(structured);
        const result = statusToolResult(
          projection,
          job,
          config.maxJobResultBytes
        );
        const deliveredResult = projection.items.find(
          (item) => item.type === "job" && item.id === job.jobId
        )?.result?.availability === "delivered";
        if (scopeResolution?.source === "host-metadata" && deliveredResult) {
          // Constructing a same-conversation tool response is not evidence that
          // ChatGPT received it. Record the offer for audit, but never consume
          // the pending live-card delivery or steal its lease.
          jobs.admissionStateStore.recordJobCompletionResultOffer({
            scopeId,
            source: "direct-job-query",
            jobId: job.jobId
          });
        }
        return result;
      }
      if (activityQuery) {
        if (!scopeId) {
          throw new Error("Activity lookup requires conversation metadata or an explicit scopeId.");
        }
        const activity = jobs.getActivity(activityQuery.id);
        if (!activity || activity.scopeId !== scopeId) throw scopedHandleUnavailable("activity");
        const childJobs = jobs.listForActivity(activity.activityId);
        const structured = {
          kind: "activity" as const,
          activity: formatActivitySummary(activity),
          agents: [...new Set(
            jobs.listActivityAgentAssignments(activity.activityId).map((assignment) => assignment.agentId)
          )].flatMap((agentId) => {
            const agent = jobs.getAgent(agentId);
            return agent ? [formatAgentSummary(agent, jobs)] : [];
          }),
          agentAssignments: jobs.listActivityAgentAssignments(activity.activityId),
          threads: [...new Set(childJobs.map((job) => job.threadId).filter(Boolean))],
          jobs: childJobs.map((job) => formatJobStatus(job, jobs.staleThresholdMs, undefined, userSettings.current, jobs)),
          events: jobs.listActivityEvents(activity.activityId).slice(-100),
          uiRequired: false
        };
        return contractedToolResult(
          statusResultContract,
          { activity, childJobs },
          compactStatusProjection(structured),
          { text: statusCompatibilityText(structured) }
        );
      }
      if (threadQuery) {
        if (!scopeId) {
          throw new Error("Thread lookup requires conversation metadata or an explicit scopeId.");
        }
        const trackedSession = sessions.get(threadQuery.id);
        const relatedJobs = jobs.listForThread(threadQuery.id, scopeId);
        const sessionVisible = trackedSession && trackedSession.scopeId === scopeId;
        if (!sessionVisible && relatedJobs.length === 0) throw scopedHandleUnavailable("thread");
        const activities = [...new Set(relatedJobs.map((job) => job.activityId))]
          .map((activityId) => jobs.getActivity(activityId))
          .filter((activity): activity is BridgeActivity => Boolean(activity));
        const structured = {
          kind: "thread" as const,
          threadId: threadQuery.id,
          agent: jobs.getAgentForThread(threadQuery.id)
            ? formatAgentSummary(jobs.getAgentForThread(threadQuery.id) as BridgeAgent, jobs)
            : null,
          session: sessionVisible
            ? {
                ...formatSessionSummary(trackedSession),
                resumeAvailability:
                  upstream.canResumeThread?.(trackedSession.threadId, trackedSession.backendKind) === false
                    ? "unavailable-after-worker-restart"
                    : upstream.canResumeThread?.(trackedSession.threadId, trackedSession.backendKind) === true
                      ? "available"
                      : "unknown"
              }
            : null,
          activities: activities.map(formatActivitySummary),
          jobs: relatedJobs.map((job) => ({
            ...formatJobStatus(job, jobs.staleThresholdMs, undefined, userSettings.current, jobs),
            events: jobs.listJobEvents(job.jobId).slice(-100)
          })),
          turns: relatedJobs.map((job) => ({
            jobId: job.jobId,
            turnId: appServerTurnId(job) || null,
            backendKind: job.backendKind,
            status: job.status,
            createdAt: new Date(job.createdAt).toISOString(),
            updatedAt: new Date(job.updatedAt).toISOString()
          })),
          uiRequired: false
        };
        return contractedToolResult(
          statusResultContract,
          { trackedSession, relatedJobs },
          compactStatusProjection(structured),
          { text: statusCompatibilityText(structured) }
        );
      }

      const preferences = userSettings.current;
      const sessionPage = pageQuery?.collection === "sessions" ? pageQuery : undefined;
      const jobPage = pageQuery?.collection === "jobs" ? pageQuery : undefined;
      const activityPage = pageQuery?.collection === "activities" ? pageQuery : undefined;
      const sessionLimit = sessionPage?.limit ?? 10;
      const sessionOffset = sessionPage?.cursor
        ? decodePageCursor(sessionPage.cursor, "sessions")
        : 0;
      const jobLimit = jobPage?.limit ?? Math.min(Math.max(20, preferences.maxConcurrentJobs), 100);
      const jobOffset = jobPage?.cursor ? decodePageCursor(jobPage.cursor, "jobs") : 0;
      const activityLimit = activityPage?.limit ?? 30;
      const activityOffset = activityPage?.cursor
        ? decodePageCursor(activityPage.cursor, "activities")
        : 0;
      const visibleSessions = scopeId ? sessions.listForScope(scopeId, sessionLimit, sessionOffset) : [];
      const visibleJobs = scopeId ? jobs.listForScope(scopeId, jobLimit, jobOffset) : [];
      const visibleActivities = scopeId ? jobs.listActivities(scopeId, activityLimit, activityOffset) : [];
      const visibleAgents = scopeId ? jobs.listAgents(scopeId, 100, 0) : [];
      const scopedSessionCount = scopeId ? sessions.sizeForScope(scopeId) : 0;
      const scopedJobCount = scopeId ? jobs.sizeForScope(scopeId) : 0;
      const scopedRunningCount = scopeId ? jobs.runningCount(scopeId) : 0;
      const scopedActivityCount = scopeId ? jobs.activityCount(scopeId) : 0;
      const scopedAgentCount = scopeId ? jobs.agentCount(scopeId) : 0;
      const scopedOrphanedAgentCount = scopeId ? jobs.orphanedAgentCount(scopeId) : 0;
      const statusScopeView = scopeResolution
        ? {
            mode: "scoped" as const,
            scopeId,
            source: scopeResolution.source,
            keyVersion: scopeResolution.keyVersion,
            explicitInputIgnored: scopeResolution.explicitInputIgnored
          }
        : {
            mode: "policy-only" as const,
            hostMetadataOrScopeRequiredForDetails: true
          };
      const scopeCounts = {
        sessions: scopedSessionCount,
        jobs: scopedJobCount,
        runningJobs: scopedRunningCount,
        activities: scopedActivityCount,
        agents: scopedAgentCount,
        orphanedAgents: scopedOrphanedAgentCount
      };
      const pagination = {
        sessions: pageSummary("sessions", sessionOffset, sessionLimit, visibleSessions.length, scopedSessionCount),
        jobs: pageSummary("jobs", jobOffset, jobLimit, visibleJobs.length, scopedJobCount),
        activities: pageSummary("activities", activityOffset, activityLimit, visibleActivities.length, scopedActivityCount)
      };
      const sessionRows = visibleSessions.map((session) => ({
        ...formatSessionSummary(session),
        resumeAvailability:
          upstream.canResumeThread?.(session.threadId, session.backendKind) === false
            ? "unavailable-after-worker-restart"
            : upstream.canResumeThread?.(session.threadId, session.backendKind) === true
              ? "available"
              : "unknown"
      }));
      const jobRows = visibleJobs.map((job) => formatJobSummary(job, jobs.staleThresholdMs));
      const activityRows = visibleActivities.map((activity) => ({
        ...formatActivitySummary(activity),
        threadIds: [...new Set(jobs.listForActivity(activity.activityId).map((job) => job.threadId).filter(Boolean))],
        jobIds: jobs.listForActivity(activity.activityId).map((job) => job.jobId)
      }));
      if (pageQuery) {
        const collection = pageQuery.collection;
        const structured = {
          kind: "page" as const,
          query: { kind: "page", collection },
          scopeView: statusScopeView,
          scopeCounts,
          pagination: pagination[collection],
          items: collection === "sessions"
            ? sessionRows
            : collection === "jobs"
              ? jobRows
              : activityRows
        };
        return contractedToolResult(
          statusResultContract,
          { collection, visibleSessions, visibleJobs, visibleActivities },
          compactStatusProjection(structured),
          { text: statusCompatibilityText(structured) }
        );
      }
      const structured = {
        kind: "overview" as const,
        ...(config.runtimeStatusResolver ? { runtimes: await config.runtimeStatusResolver().catch(() => ["Runtime status unavailable; saved selections were preserved."]) } : {}),
        scopeView: statusScopeView,
        scopeCounts,
        pagination,
        warnings: [...config.startupWarnings, ...userSettings.loadWarnings],
        sessions: sessionRows,
        jobs: jobRows,
        activities: activityRows,
        agents: visibleAgents.map((agent) => ({
          ...formatAgentSummary(agent, jobs),
          currentThread: formatAgentThreadSummary(
            jobs.listAgentThreads(agent.agentId).find((thread) => thread.isCurrent)
          ),
          threadHistory: jobs.listAgentThreads(agent.agentId).map(formatAgentThreadSummary),
          activityAssignments: jobs.listActivityAgentAssignments(undefined, agent.agentId)
        }))
      };
      return contractedToolResult(
        statusResultContract,
        { visibleSessions, visibleJobs, visibleActivities, visibleAgents },
        compactStatusProjection(structured),
        { text: statusCompatibilityText(structured) }
      );
    }
  );

  if (config.enableRecoveryTools) server.registerTool(
    "codex_diagnostics",
    {
      title: `${PRODUCT_INFO.displayName} Operator Diagnostics`,
      description:
        "App-only operator diagnostics for build, authentication mode, storage, scope HMAC, pool limits, upstream inventory, descriptor notification/re-list observations, bounded card-stage and exact-Job wait statistics, waiter counts, storage-path latency, HTML byte budgets, and forensic warnings. A notification or re-list observation never claims descriptor adoption. Routine model status and unauthenticated health checks intentionally exclude this data.",
      inputSchema: z.strictObject({}),
      outputSchema: diagnosticsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private"
      }
    },
    async () => {
      let upstreamTools: unknown = null;
      let upstreamError: string | null = null;
      try {
        upstreamTools = await upstream.listTools();
      } catch (error) {
        upstreamError = error instanceof Error ? error.message : String(error);
      }
      const persistencePaths = [sessions.persistencePath, jobs.persistencePath, userSettings.persistencePath];
      const sharedPersistencePath =
        persistencePaths[0] && persistencePaths.every((entry) => entry === persistencePaths[0])
          ? persistencePaths[0]
          : null;
      const persistenceBackend = sharedPersistencePath === config.stateDatabaseFile
        ? "sqlite" as const
        : persistencePaths.every((entry) => entry === null)
          ? "memory" as const
          : "split-json" as const;
      const structured = {
        kind: "diagnostics" as const,
        bridge: {
          runtimeName: PRODUCT_INFO.runtimeName,
          product: PRODUCT_INFO.displayName,
          build: BRIDGE_BUILD_INFO,
          auth: config.token && !config.noAuth ? "bearer-token" as const : "none" as const,
          backend: config.defaultBackend
        },
        storage: {
          backend: persistenceBackend,
          transactional: persistenceBackend === "sqlite",
          schemaVersion: jobs.persistenceSchemaVersion,
          activityPersistent: jobs.activityPersistent,
          sessionPersistent: sessions.persistent,
          settingsPersistent: userSettings.persistent
        },
        scopeSecurity: {
          hmacKeyVersion: scopeResolver.keyVersion,
          hmacRotation: scopeResolver.rotationPolicy,
          rawHostIdentifiersPersisted: false as const,
          scopeIsAuthentication: false as const
        },
        pool: {
          upstreamPoolSize: config.upstreamPoolSize,
          maxConcurrentJobs: userSettings.current.maxConcurrentJobs,
          hardLimit: config.maxConcurrentJobs,
          retainedJobs: config.maxRetainedJobs,
          resultBytes: config.maxJobResultBytes
        },
        upstream: { tools: upstreamTools, error: upstreamError },
        descriptorDiscovery: {
          epoch: 0,
          fingerprint: null,
          activeBindings: 0,
          notificationEligibleBindings: 0,
          notificationQueued: false,
          notificationAttempts: 0,
          notificationErrors: 0,
          lastNotificationEpoch: null,
          lastNotificationAttemptAt: null,
          clientRelistObservations: 0,
          currentEpochRelistedSessions: 0,
          lastClientRelistedEpoch: null,
          lastClientRelistedAt: null,
          lastObservedNotificationToRelistMs: null,
          adoptionState: "unknown" as const
        },
        performance: {
          ...cardPerformance.snapshot(),
          jobWaits: jobs.waitDiagnostics(),
          stateMaintenance: jobs.stateMaintenanceDiagnostics()
        },
        forensics: {
          bridgeInstanceId: jobs.bridgeInstanceId,
          startupWarnings: [
            ...config.startupWarnings,
            ...config.developerStartupWarnings
          ],
          settingsLoadWarnings: userSettings.loadWarnings
        }
      };
      return contractedToolResult(
        diagnosticsResultContract,
        structured,
        structured,
        {
          text: upstreamError
            ? `Diagnostics collected; upstream inventory failed: ${upstreamError}`
            : "Diagnostics collected, including upstream inventory."
        }
      );
    }
  );

  const codexAgentRuntimeOperationInput = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("archive") }),
    z.strictObject({ kind: z.literal("restore") }),
    z.strictObject({
      kind: z.literal("rename"),
      name: z.string().trim().min(1).max(80).describe("New human-friendly Agent display name.")
    })
  ]);
  const codexAgentInput = z.strictObject({
    scopeId: scopeIdSchema().optional()
      .describe("Conversation UUID for hosts that do not supply scoped MCP metadata."),
    requestId: scopeIdSchema().describe("Unique UUID for this logical Agent mutation and its exact retries."),
    agentId: scopeIdSchema().describe("Immutable Agent routing id in the current conversation scope."),
    operation: codexAgentRuntimeOperationInput
  });
  server.registerTool(
    "codex_agent",
    {
      title: "Rename Codex Agent",
      description:
        "Rename a Codex Agent in this conversation while preserving its identity, context, and work history.",
      inputSchema: codexAgentInput,
      outputSchema: agentMutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: { "openai/widgetAccessible": true }
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      const action = args.operation.kind;
      if (action !== "rename") {
        return { ...mutationToolResult({ ok: false, action, code: "AGENT_ARCHIVE_REMOVED",
          warning: "Agent archive and restore are not supported. Agent history does not occupy executor receipt slots; archiving is not a retention recovery action.",
          nextActions: [guidance("Use runtime diagnostics to inspect execution receipts and pending acknowledgements. Agent management supports rename only.")]
        }, "model", "codex_agent"), isError: true };
      }
      const agentName = args.operation.name;
      const scope = scopeResolver.require(
        _meta as ToolCallMetadata,
        args.scopeId,
        "Codex Agent management"
      );
      const agent = jobs.getAgent(args.agentId);
      if (!agent || agent.scopeId !== scope.scopeId) throw scopedHandleUnavailable("agent");
      const actionHash = createHash("sha256")
        .update(JSON.stringify({
          agentId: args.agentId,
          action,
          agentName
        }))
        .digest("hex");
      const replay = jobs.getAgentMutation(scope.scopeId, args.requestId);
      if (replay) {
        if (replay.actionHash !== actionHash) {
          throw new Error("requestId was already used for a different Agent mutation in this scope.");
        }
        return mutationToolResult(replay.result, "model", "codex_agent");
      }
      const result = jobs.activityTransaction(() => {
        const updated = jobs.renameAgent(agent.agentId, agentName);
        const mutationResult = {
          ok: true,
          action,
          agent: formatAgentSummary(updated, jobs),
          historyPreserved: true,
          deletionPerformed: false
        };
        jobs.recordAgentMutation(scope.scopeId, args.requestId, actionHash, mutationResult);
        return mutationResult;
      });
      return mutationToolResult(result, "model", "codex_agent");
    }
  );

  if (config.enableRecoveryTools) server.registerTool(
    "codex_agent_recovery_detach",
    {
      title: "Recovery Detach Codex Agent",
      description:
        "Release one exact idle Agent assignment for operator-authorized recovery. This capability is disabled by default, rejects active or waiting Agents inside the same state transaction, and never stops a running job.",
      inputSchema: z.strictObject({
        scopeId: scopeIdSchema().optional()
          .describe("Exact conversation scope for compatibility/admin MCP hosts without ChatGPT session metadata."),
        requestId: scopeIdSchema().describe("Unique UUID for this exact recovery mutation and its retries."),
        agentId: scopeIdSchema().describe("Exact bridge-managed Agent id."),
        activityId: scopeIdSchema().describe("Exact active Activity assignment to release."),
        expectedAgentVersion: z.number().int().min(1)
          .describe("Authoritative Agent version observed immediately before recovery detach.")
      }),
      outputSchema: mutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private"
      }
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      if (!config.enableRecoveryTools) {
        throw new Error(
          "RECOVERY_OPERATION_DISABLED: The operator must explicitly enable recovery tools before detaching an Agent assignment."
        );
      }
      const scope = scopeResolver.require(
        _meta as ToolCallMetadata,
        args.scopeId,
        "Codex Agent recovery detach"
      );
      const actionHash = createHash("sha256")
        .update(JSON.stringify({
          action: "recovery-detach",
          agentId: args.agentId,
          activityId: args.activityId,
          expectedAgentVersion: args.expectedAgentVersion
        }))
        .digest("hex");
      const result = jobs.activityTransaction(() => {
        const replay = jobs.getAgentMutation(scope.scopeId, args.requestId);
        if (replay) {
          if (replay.actionHash !== actionHash) {
            throw new Error("requestId was already used for a different Agent mutation in this scope.");
          }
          return replay.result;
        }
        const agent = jobs.getAgent(args.agentId);
        if (!agent || agent.scopeId !== scope.scopeId) throw scopedHandleUnavailable("agent");
        const detached = jobs.detachIdleAgentAssignment({
          activityId: args.activityId,
          agentId: args.agentId,
          expectedAgentVersion: args.expectedAgentVersion
        });
        const mutationResult = {
          ok: true,
          action: "recovery-detach",
          agent: formatAgentSummary(detached.agent, jobs),
          detachedAssignment: detached.assignment,
          alreadyReleased: detached.alreadyReleased,
          historyPreserved: true,
          deletionPerformed: false
        };
        jobs.recordAgentMutation(scope.scopeId, args.requestId, actionHash, mutationResult);
        return mutationResult;
      });
      return mutationToolResult(result, "app");
    }
  );

  const codexCancelTargetInput = z.strictObject({
    requestId: scopeIdSchema(),
    target: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("job"), id: z.string().trim().min(1).max(200) }),
      z.strictObject({ kind: z.literal("activity"), id: scopeIdSchema() })
    ]), expectedVersion: z.number().int().min(1)
      .describe("Authoritative Job or Activity version observed immediately before cancellation."),
    reason: z.string().trim().min(1).max(CANCELLATION_REASON_MAX_LENGTH).describe(
      "Short user-facing reason for this explicit cancellation. Do not include private reasoning, raw prompts, secrets, or unnecessary file contents."
    ),
    acknowledgeAffectedJobIds: z.array(z.string().trim().min(1).max(200))
      .max(HARD_MAX_CONCURRENT_JOBS)
      .optional()
      .describe("Exact affected-job list confirmed when a worker is shared.")
  });

  server.registerTool(
    "codex_cancel",
    {
      title: "Force-stop Codex Work",
      description:
        "Force-stop a Codex Job or whole Activity in this conversation. Cancellation is confirmed only after execution stops; filesystem changes are not rolled back.",
      inputSchema: codexCancelTargetInput,
      outputSchema: z.union([cancelMutationOutputSchema, activityCancelMutationOutputSchema]),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input, extra) => {
      if (input.target.kind === "activity") {
        const { target, ...args } = input;
        return cancelActivity({ ...args, activityId: target.id }, extra, "codex_cancel");
      }
      const args = (() => { const { target, ...rest } = input; return { ...rest, jobId: target.id }; })();
      const _meta = extra.mcpReq._meta;
      const scope = scopeResolver.require(
        _meta as ToolCallMetadata,
        undefined,
        "Codex job cancellation"
      );
      const actionHash = createHash("sha256")
        .update(JSON.stringify({
          action: "cancel-job",
          jobId: args.jobId,
          expectedVersion: args.expectedVersion,
          reason: args.reason,
          acknowledgeAffectedJobIds: [...(args.acknowledgeAffectedJobIds || [])].sort()
        }))
        .digest("hex");
      const result = await runCancellationMutation(
        scope.scopeId,
        args.requestId,
        actionHash,
        async () => {
          const existing = jobs.get(args.jobId);
          if (!existing || existing.scopeId !== scope.scopeId) throw scopedHandleUnavailable("job");
          if (existing.version !== args.expectedVersion) {
            throw new Error(
              `Codex job version changed from ${args.expectedVersion} to ${existing.version}. Refresh authoritative status before retrying cancellation.`
            );
          }
          const { intent } = jobs.beginCancellationOperation({
            scopeId: scope.scopeId,
            requestId: args.requestId,
            actionHash,
            source: "model-tool",
            toolName: "codex_cancel",
            actionName: "cancel-job",
            target: cancellationTargetForJob(existing),
            expectedVersion: args.expectedVersion,
            callerRequestDigest: correlationDigest("mcp-request", extra.mcpReq.id),
            reasonCode: "public-job-cancel",
            reason: args.reason
          });
          const cancelled = await jobs.cancel(args.jobId, intent, {
            acknowledgeAffectedJobIds: args.acknowledgeAffectedJobIds
          });
          const formatted = formatJobStatus(
            cancelled,
            jobs.staleThresholdMs,
            undefined,
            userSettings.current,
            jobs
          );
          jobs.completeCancellationOperation(scope.scopeId, args.requestId, formatted);
          return formatted;
        }
      );
      return mutationToolResult(
        { ok: true, action: "cancel-job", job: result },
        "model",
        "codex_cancel"
      );
    }
  );

  const interactionAnswersBaseInput = z.record(
    z.string().trim().min(1).max(200),
    z.array(z.string().max(4_000)).max(20)
  );
  const interactionAnswersInput = interactionAnswersBaseInput
    .refine(
      (answers) => Object.keys(answers).length <= MAX_CODEX_INTERACTION_QUESTIONS,
      `At most ${MAX_CODEX_INTERACTION_QUESTIONS} interaction questions can be answered at once.`
    );

    const interactionResponseInput = z.strictObject({
        scopeId: scopeIdSchema().optional(),
        widgetInstanceId: widgetInstanceIdSchema.optional(),
        requestId: scopeIdSchema().describe("Unique UUID for this exact response and its retries."),
        jobId: z.string().trim().min(1).max(200),
        expectedJobVersion: z.number().int().min(1),
        interactionId: z.string().trim().min(1).max(200),
        response: z.union([
          z.strictObject({
            decision: z.enum(["accept", "acceptForSession", "decline", "cancel"])
          }),
          z.strictObject({
            answers: interactionAnswersInput
          }),
          z.strictObject({
            elicitation: z.strictObject({
              action: z.enum(["accept", "decline", "cancel"]),
              content: z.record(z.string().min(1).max(200), z.union([
                z.string().max(8_192), z.number(), z.boolean(), z.array(z.string().max(8_192)).max(100)
              ])).refine(content => Object.keys(content).length <= 32 && JSON.stringify(content).length <= 48_000,
                "MCP form content exceeds the response limit.").nullable().optional()
            })
          })
        ]),
        card: userControlProofInputSchema
      });
  const respondInteraction: ToolCallback<typeof interactionResponseInput> = async (args, extra) => {
    const _meta = extra.mcpReq._meta;
      if (
        "answers" in args.response &&
        Object.keys(args.response.answers).length > MAX_CODEX_INTERACTION_QUESTIONS
      ) {
        throw new Error(
          `At most ${MAX_CODEX_INTERACTION_QUESTIONS} interaction questions can be answered at once.`
        );
      }
      const { scope, widgetSessionId, claims } = requireControlCard(args, _meta);
      if (claims && claims.jobVersion !== args.expectedJobVersion) {
        throw new Error("UI_CONTROL_TARGET_CHANGED: The requested version differs from the displayed work.");
      }
      const responseHash = createHash("sha256")
        .update(JSON.stringify(args.response))
        .digest("hex");
      const actionHash = createHash("sha256")
        .update(JSON.stringify({
          action: "respond-interaction",
          jobId: args.jobId,
          expectedJobVersion: args.expectedJobVersion,
          interactionId: args.interactionId,
          responseHash,
          card: args.card
        }))
        .digest("hex");
      const result = await runIdempotentMutation(
        scope.scopeId,
        args.requestId,
        actionHash,
        async () => {
          const job = jobs.get(args.jobId);
          const activity = job ? jobs.getActivity(job.activityId) : undefined;
          const agent = job?.agentId ? jobs.getAgent(job.agentId) : undefined;
          if (
            !job ||
            job.scopeId !== scope.scopeId ||
            !activity ||
            activity.scopeId !== scope.scopeId ||
            !agent ||
            agent.scopeId !== scope.scopeId
          ) {
            throw new Error(
              "The requested Codex interaction is unavailable in this card's conversation scope."
            );
          }
          if (job.version !== args.expectedJobVersion) {
            throw new Error(
              `Codex job version changed from ${args.expectedJobVersion} to ${job.version}. Refresh the Dashboard before retrying the response.`
            );
          }
          const interaction = job.pendingInteractions.find(
            (entry) => entry.interactionId === args.interactionId
          );
          if (!interaction) {
            throw new Error("Unknown or already resolved Codex interaction id for this job.");
          }
          if (ordinaryCodexQuestion(interaction)) {
            throw new Error("GPT_RESPONSE_REQUIRED: GPT handles this ordinary question through codex_status input queries and codex_answer.");
          }
          if ("answers" in args.response) {
            if (interaction.kind !== "user-input") {
              throw new Error("This Codex approval interaction requires a decision.");
            }
            const expectedQuestionIds = [...new Set(
              (interaction.questions || []).map((question) => question.id)
            )].sort();
            const answerIds = Object.keys(args.response.answers).sort();
            if (JSON.stringify(answerIds) !== JSON.stringify(expectedQuestionIds)) {
              throw new Error("Answers must match the exact question ids in the pending interaction.");
            }
          } else if ("elicitation" in args.response) {
            if (interaction.kind !== "mcp-elicitation") throw new Error("This interaction is not an MCP elicitation.");
          } else if (isInputInteraction(interaction)) {
            throw new Error("This Codex interaction requires answers.");
          }
          const updated = await jobs.respondToInteraction(
            job.jobId,
            args.interactionId,
            args.response
          );
          return {
            ok: true,
            action: "respond-interaction",
            activityId: activity.activityId,
            agentId: agent.agentId,
            job: formatJobStatus(
              updated,
              jobs.staleThresholdMs,
              undefined,
              userSettings.current,
              jobs
            ),
            promptOrAnswersPersisted: false
          };
        }
      );
      return mutationToolResult(result, "app");
    };

  server.registerTool(
    "codex_interaction_respond",
    {
      title: "Respond to Codex Interaction",
      description:
        "App-only response to an original pending Codex approval or input request. The server verifies the selected target, current version, request identity, and private access proof. Answers are transient.",
      inputSchema: interactionResponseInput,
      outputSchema: mutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
        "codex/uiContractGeneration": DASHBOARD_CARD_CONTRACT_GENERATION
      }
    },
    respondInteraction
  );

  server.registerTool(
    "codex_steer",
    {
      title: "Steer Active Codex Job",
      description:
        "Send additional guidance to one running Codex turn in this conversation without starting another turn. This does not resolve structured questions or approvals.",
      inputSchema: z.strictObject({
        scopeId: scopeIdSchema().optional()
          .describe("Conversation UUID for hosts that do not supply scoped MCP metadata."),
        requestId: scopeIdSchema()
          .describe("Unique UUID for this exact Job/version/prompt steering request and its retries."),
        jobId: z.string().trim().min(1).max(200)
          .describe("Exact active Job id returned by codex_task."),
        expectedJobVersion: z.number().int().min(1)
          .describe("Authoritative Job version observed immediately before steering."),
        prompt: verbatimInput(config.maxPromptChars, "Steering prompt")
          .describe("Bounded additional guidance for the current in-flight turn only.")
      }),
      outputSchema: codexSteerOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      const scope = scopeResolver.require(
        _meta as ToolCallMetadata,
        args.scopeId,
        "Codex active Job steering"
      );
      const prompt = verbatimText(args.prompt, {
        field: "Steering prompt",
        maxCharacters: config.maxPromptChars,
        rejectControlCharacters: false
      });
      const promptHash = createHash("sha256").update(prompt).digest("hex");
      const actionHash = createHash("sha256")
        .update(JSON.stringify({
          action: "steer",
          jobId: args.jobId,
          expectedJobVersion: args.expectedJobVersion,
          promptHash
        }))
        .digest("hex");
      const safeCurrentJob = () => {
        const job = jobs.get(args.jobId);
        return job?.scopeId === scope.scopeId ? job : undefined;
      };
      const result = await jobs.runSteeringMutation(
        {
          scopeId: scope.scopeId,
          requestId: args.requestId,
          actionHash,
          jobId: args.jobId,
          expectedJobVersion: args.expectedJobVersion,
          promptSha256: promptHash
        },
        {
          conflict: steeringFailureResult(
            "STEERING_REQUEST_CONFLICT",
            undefined
          ),
          notDelivered: steeringFailureResult(
            "JOB_NOT_ACTIVE",
            safeCurrentJob(),
            "The durable steering request stopped before dispatch and was not queued for a future turn."
          ),
          uncertain: steeringFailureResult(
            "DELIVERY_UNCERTAIN",
            safeCurrentJob()
          )
        },
        async () => {
          const validation = validatePublicSteeringTarget(
            jobs,
            upstream,
            scope.scopeId,
            args.jobId,
            args.expectedJobVersion
          );
          if (!validation.ok) {
            return {
              status: "not-delivered",
              result: steeringFailureResult(
                validation.code,
                validation.job,
                validation.message
              )
            };
          }
          jobs.markSteeringDeliveryDispatching(
            scope.scopeId,
            args.requestId,
            actionHash
          );
          try {
            const updated = await jobs.steer(validation.job.jobId, prompt);
            return {
              status: "delivered",
              result: steeringSuccessResult(updated)
            };
          } catch {
            return {
              status: "uncertain",
              result: steeringFailureResult(
                "DELIVERY_UNCERTAIN",
                safeCurrentJob()
              )
            };
          }
        }
      );
      return steeringToolResult(result);
    }
  );


  const activityVerificationEvidenceInput = z.strictObject({
    summary: z.string().trim().min(1).max(1_000),
    jobIds: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
    tests: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    artifacts: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    references: z.array(z.string().trim().min(1).max(500)).max(20).optional()
  });
  const activityPolicyPatchInput = z.strictObject({
    kind: z.enum(ACTIVITY_KINDS).optional(),
    handoff: z.enum(ACTIVITY_HANDOFF_POLICIES).optional(),
    completion: z.enum(ACTIVITY_COMPLETION_TRIGGERS).optional()
  }).refine(
    (patch) => Object.keys(patch).length > 0,
    "Provide at least one Activity policy field."
  );
  const codexActivityOperationInput = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.enum(["seal", "start-verification"])
    }),
    z.strictObject({
      kind: z.enum(["complete", "abandon"]),
      reason: z.string().trim().min(1).max(2_000).optional()
    }),
    z.strictObject({
      kind: z.literal("verification-passed"),
      evidence: activityVerificationEvidenceInput.describe(
        "Bounded verification evidence; raw prompts and private reasoning are forbidden."
      )
    }),
    z.strictObject({
      kind: z.literal("verification-failed"),
      reason: z.string().trim().min(1).max(2_000)
    }),
    z.strictObject({
      kind: z.literal("set-policy"),
      policy: activityPolicyPatchInput
    })
  ]);
  const codexActivityUpdateInput = z.strictObject({
    scopeId: scopeIdSchema()
      .optional()
      .describe("Conversation UUID for hosts that do not supply scoped MCP metadata."),
    activityId: scopeIdSchema().describe("Exact Activity id in the current conversation scope."),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .describe("Authoritative Activity version observed immediately before this transition."),
    operation: codexActivityOperationInput.describe(
      "One non-cancelling lifecycle, verification, or policy transition."
    )
  });
  const codexActivityCancelRuntimeInput = z.strictObject({
    scopeId: scopeIdSchema()
      .optional()
      .describe("Compatibility-only conversation UUID for MCP hosts without ChatGPT session metadata."),
    requestId: scopeIdSchema().describe("Unique UUID for this exact Activity cancellation and its retries."),
    activityId: scopeIdSchema().describe("Exact Activity id in the current conversation scope."),
    expectedVersion: z.number().int().min(1)
      .describe("Authoritative Activity version observed immediately before cancellation."),
    reason: z.string().trim().min(1).max(CANCELLATION_REASON_MAX_LENGTH).describe(
      "Short user-facing reason for this GPT-requested whole-Activity cancellation. Do not include private reasoning, raw prompts, secrets, or unnecessary file contents."
    ),
    acknowledgeAffectedJobIds: z
      .array(z.string().trim().min(1).max(200))
      .max(HARD_MAX_CONCURRENT_JOBS)
      .optional()
      .describe("Exact affected-job list confirmed before cancelling an Activity that shares workers.")
  });
  const codexActivityCancelPublicInput = codexActivityCancelRuntimeInput.omit({ scopeId: true });

  server.registerTool(
    "codex_activity_update",
    {
      title: "Update Codex Activity",
      description:
        "Update an Activity's lifecycle, verification, or policy at its current version.",
      inputSchema: codexActivityUpdateInput,
      outputSchema: activityUpdateMutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      const operation = args.operation;
      if (
        operation.kind === "set-policy" &&
        !["kind", "handoff", "completion"].some((key) =>
          Object.prototype.hasOwnProperty.call(operation.policy, key)
        )
      ) {
        throw new Error("set-policy requires at least one Activity policy field.");
      }
      const scope = scopeResolver.require(
        _meta as ToolCallMetadata,
        args.scopeId,
        "Codex Activity update"
      );
      const existing = jobs.getActivity(args.activityId);
      if (!existing || existing.scopeId !== scope.scopeId) throw scopedHandleUnavailable("activity");
      if (existing.version !== args.expectedVersion) {
        return { ...mutationToolResult({ ok: false, action: operation.kind, code: "STALE_ACTIVITY_VERSION",
          activity: formatActivitySummary(existing),
          warning: "Activity version changed. Read the current Activity before retrying; no mutation was applied.",
          nextActions: [statusAction({ query: { kind: "activity", id: existing.activityId } }, "Read the current Activity version.")]
        }, "model", "codex_activity_update"), isError: true };
      }
      let activity!: BridgeActivity;
      const cancelledJobIds: string[] = [];
      jobs.activityTransaction(() => {
        const current = jobs.getActivity(args.activityId);
        if (!current || current.scopeId !== scope.scopeId) throw scopedHandleUnavailable("activity");
        if (current.version !== args.expectedVersion) {
          throw new Error(
            `Activity version changed from ${args.expectedVersion} to ${current.version}. Refresh authoritative state before retrying the transition.`
          );
        }
        switch (operation.kind) {
          case "seal":
            activity = jobs.sealActivity(args.activityId);
            break;
          case "complete":
            activity = jobs.completeActivity(args.activityId, operation.reason);
            break;
          case "abandon":
            activity = jobs.abandonActivity(args.activityId, operation.reason);
            break;
          case "start-verification":
            activity = jobs.startActivityVerification(args.activityId);
            break;
          case "verification-passed":
            activity = jobs.passActivityVerification(
              args.activityId,
              operation.evidence as ActivityVerificationEvidence
            );
            break;
          case "verification-failed":
            activity = jobs.failActivityVerification(args.activityId, operation.reason);
            break;
          case "set-policy":
            activity = jobs.setActivityPolicy(args.activityId, {
              kind: operation.policy.kind,
              handoffPolicy: operation.policy.handoff,
              completionTrigger: operation.policy.completion
            });
            break;
        }
      });

      return mutationToolResult({
        ok: true,
        action: operation.kind,
        activity: formatActivitySummary(activity),
        cancelledJobIds,
        policySource: "explicit-tool-input",
        codexOutputCanMutatePolicy: false
      }, "model", "codex_activity_update");
    }
  );

  const cancelActivity = async (args: z.infer<typeof codexActivityCancelPublicInput>, extra: Parameters<ToolCallback<typeof codexActivityCancelPublicInput>>[1], toolName = "codex_cancel") => {
      const _meta = extra.mcpReq._meta;
      const scope = scopeResolver.require(
        _meta as ToolCallMetadata,
        undefined,
        "Codex Activity cancellation"
      );
      const actionHash = createHash("sha256")
        .update(JSON.stringify({
          action: "cancel-activity",
          activityId: args.activityId,
          expectedVersion: args.expectedVersion,
          reason: args.reason || null,
          acknowledgeAffectedJobIds: [...(args.acknowledgeAffectedJobIds || [])].sort()
        }))
        .digest("hex");
      const result = await runCancellationMutation(
        scope.scopeId,
        args.requestId,
        actionHash,
        async () => {
          const existing = jobs.getActivity(args.activityId);
          if (!existing || existing.scopeId !== scope.scopeId) throw scopedHandleUnavailable("activity");
          if (existing.version !== args.expectedVersion) {
            throw new Error(
              `Activity version changed from ${args.expectedVersion} to ${existing.version}. Refresh authoritative state before retrying cancellation.`
            );
          }
          const activeJobs = jobs
            .listForActivity(args.activityId)
            .filter((job) => isActiveActivityJobStatus(job.status));
          const impacts: ReturnType<CodexJobRegistry["terminationImpact"]>[] = [];
          for (const job of activeJobs) impacts.push(jobs.terminationImpact(job.jobId));
          const allAffected = [...new Set(impacts.flatMap((impact) => impact.affectedJobIds))].sort();
          const activityJobIds = new Set(activeJobs.map((job) => job.jobId));
          const collateral = allAffected.filter((jobId) => !activityJobIds.has(jobId));
          if (collateral.length > 0) {
            const acknowledged = [...(args.acknowledgeAffectedJobIds || [])].sort();
            if (JSON.stringify(acknowledged) !== JSON.stringify(allAffected)) {
              throw new Error(
                `Force-stopping this Activity will interrupt jobs outside it that share workers. Retry after one collateral/partial-change confirmation with acknowledgeAffectedJobIds=${JSON.stringify(allAffected)}.`
              );
            }
          }
          const { intent: parentIntent } = jobs.beginCancellationOperation({
            scopeId: scope.scopeId,
            requestId: args.requestId,
            actionHash,
            source: "model-tool",
            toolName,
            actionName: "cancel-activity",
            target: {
              kind: "activity",
              activityId: existing.activityId
            },
            expectedVersion: args.expectedVersion,
            callerRequestDigest: correlationDigest("mcp-request", extra.mcpReq.id),
            reasonCode: "activity-cancel",
            reason: args.reason
          });
          jobs.setCancellationIntentStatus(parentIntent.intentId, "dispatched");
          if (activeJobs.length > 0) {
            jobs.beginActivityTermination(args.activityId, args.reason);
          }
          const childIntentByJobId = new Map<string, CancellationIntentRecord>();
          for (const job of activeJobs) {
            const intent = jobs.createCancellationIntent({
              scopeId: scope.scopeId,
              requestId: args.requestId,
              parentIntentId: parentIntent.intentId,
              cascadeId: parentIntent.cascadeId,
              source: "activity-cascade",
              toolName,
              actionName: "cancel-child-job",
              target: cancellationTargetForJob(job),
              expectedVersion: job.version,
              callerRequestDigest: parentIntent.callerRequestDigest,
              reasonCode: "activity-child-cancel"
            });
            childIntentByJobId.set(job.jobId, intent);
          }
          const cancellationTargets: string[] = [];
          const groupedMcpWorkers = new Set<string>();
          for (const job of activeJobs) {
            if (backendSupports(job.backendKind, "supportsPreciseCancellation")) {
              cancellationTargets.push(job.jobId);
              continue;
            }
            const impact = jobs.terminationImpact(job.jobId);
            const workerKey = impact.affectedJobIds.slice().sort().join("\0");
            if (groupedMcpWorkers.has(workerKey)) continue;
            groupedMcpWorkers.add(workerKey);
            cancellationTargets.push(job.jobId);
          }
          for (const targetJobId of cancellationTargets) {
            const target = jobs.get(targetJobId);
            const targetIntent = childIntentByJobId.get(targetJobId);
            if (!targetIntent) {
              throw new Error(
                "CANCELLATION_PROVENANCE_REQUIRED: Activity child cancellation has no durable intent."
              );
            }
            if (!target) {
              throw new Error("An Activity child job disappeared during cancellation.");
            }
            if (isTerminalActivityJobStatus(target.status)) {
              const currentIntent = jobs.getCancellationIntent(targetIntent.intentId);
              if (currentIntent?.status === "recorded" || currentIntent?.status === "dispatched") {
                jobs.setCancellationIntentStatus(targetIntent.intentId, "no-op");
              }
              continue;
            }
            const currentImpact = jobs.terminationImpact(target.jobId);
            const requestedTargetIntents = currentImpact.affectedJobIds
              .map((jobId) => childIntentByJobId.get(jobId))
              .filter((intent): intent is CancellationIntentRecord => Boolean(intent));
            await jobs.cancel(target.jobId, targetIntent, {
              acknowledgeAffectedJobIds: currentImpact.affectedJobIds,
              requestedTargetIntents
            });
          }
          const stillActive = jobs
            .listForActivity(args.activityId)
            .some((job) => isActiveActivityJobStatus(job.status));
          const activity = stillActive
            ? (jobs.getActivity(args.activityId) as BridgeActivity)
            : jobs.cancelActivity(args.activityId, args.reason);
          jobs.setCancellationIntentStatus(
            parentIntent.intentId,
            stillActive ? "failed" : "succeeded"
          );
          const cancellationResult = {
            ok: !stillActive,
            action: "cancel",
            activity: formatActivitySummary(activity),
            cancelledJobIds: activeJobs.map((job) => job.jobId),
            affectedJobIds: allAffected,
            collateralJobIds: collateral,
            warning:
              "Tracked Codex worker process groups were force-stopped; partial filesystem changes were not rolled back.",
            policySource: "explicit-tool-input",
            codexOutputCanMutatePolicy: false
          };
          jobs.completeCancellationOperation(
            scope.scopeId,
            args.requestId,
            cancellationResult
          );
          return cancellationResult;
        }
      );
      return mutationToolResult(result, "model", "codex_activity_cancel");
    };

  server.registerTool(
    "codex_models",
    {
      title: "List Codex Models",
      description:
        "Read the model and reasoning choices allowed by current bridge policy and backend availability. Descriptions come from the installed Codex catalog; in automatic mode a saved user model description replaces the catalog description and is marked descriptionSource=user. The bridge filters executable choices and may return an empty list with a policy warning.",
      inputSchema: z.strictObject({
        refresh: z
          .boolean()
          .optional()
          .describe("Force an immediate catalog refresh. Omit to use the short-lived cache when available.")
      }),
      outputSchema: codexModelsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (args) => {
      const catalog = await modelCatalog.getCatalog({
        refresh: args.refresh,
        backendKind: config.defaultBackend
      });
      publishTaskProjection(catalog);
      const preferences = userSettings.current;
      const allowedSelections = listAllowedModelSelections(
        preferences.modelPolicy,
        catalog,
        effectiveModelCeiling(
          catalog,
          config.operatorModelCeiling,
          preferences.usePriorityServiceTier
        )
      );
      const allowedEffortsByModel = new Map<string, Set<string>>();
      for (const selection of allowedSelections) {
        const efforts = allowedEffortsByModel.get(selection.model) || new Set<string>();
        efforts.add(selection.reasoningEffort);
        allowedEffortsByModel.set(selection.model, efforts);
      }
      const models = catalog.models
        .filter((model) => allowedEffortsByModel.has(model.id))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((model) => ({
          id: model.id,
          name: model.displayName,
          questions: modelQuestionCapabilities(model),
          ...modelDescriptionProjection(model, preferences.modelDescriptionOverrides, preferences.modelPolicy.mode === "automatic"),
          efforts: [...(allowedEffortsByModel.get(model.id) || [])]
            .sort()
            .map((effort) => {
              const description = model.supportedReasoningEfforts.find(
                (entry) => entry.effort === effort
              )?.description;
              return {
                id: effort,
                ...(description ? { description } : {})
              };
            }),
          serviceTiers: [...model.serviceTiers]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((tier) => ({
              id: tier.id,
              name: tier.name,
              ...(tier.description ? { description: tier.description } : {})
            }))
        }));
      const structured = {
        contractVersion: "2" as const,
        selectionMode: preferences.modelPolicy.mode,
        source: catalog.source,
        stale: catalog.stale,
        warning: [
          catalog.warning,
          isModelPolicySuspended(preferences.modelPolicy, catalog,
            effectiveModelCeiling(catalog, config.operatorModelCeiling, preferences.usePriorityServiceTier))
            ? ULTRA_DISABLED_NO_SELECTION_WARNING : undefined
        ].filter(Boolean).join(" ") || null,
        models
      };
      return contractedToolResult(
        modelsResultContract,
        catalog,
        structured,
        {
          text:
            `${models.length} policy-allowed Codex model(s) available from ${catalog.source}; ` +
            `catalog ${catalog.stale ? "is stale" : "is current"}.`
        }
      );
    }
  );

  server.registerTool(
    "codex_settings",
    {
      title: `Open ${PRODUCT_INFO.displayName} Settings`,
      description:
        "Open an interactive card for configuring this ChatGPT-to-Codex bridge.",
      inputSchema: z.strictObject({
        refreshModels: z
          .boolean()
          .optional()
          .describe("Force a fresh Codex model catalog lookup before rendering the card.")
      }),
      outputSchema: MODEL_VISIBLE_OUTPUT_SCHEMAS.codex_settings,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      },
      _meta: {
        ui: {
          resourceUri: SETTINGS_CARD_URI,
          visibility: ["model", "app"]
        },
        "openai/outputTemplate": SETTINGS_CARD_URI,
        "openai/widgetAccessible": true,
        "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
      }
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      return {
        content: [{ type: "text" as const, text: "Settings opened. The card loads the current preferences." }],
        structuredContent: { kind: "settings", opened: true },
        _meta: { "openai/locale": resolvePreferredUiLocale(userSettings.current.uiLocalePreference,
          metadataString(_meta, "openai/locale") || metadataString(_meta, "webplus/i18n")),
          "codex/refreshModels": args.refreshModels === true,
          hostLocale: metadataString(_meta, "openai/locale") || metadataString(_meta, "webplus/i18n") || null }
      };
    }
  );

    const settingsSnapshotInput = z.strictObject({
        refreshModels: z
          .boolean()
          .optional()
          .describe("Force a fresh Codex model catalog lookup for this settings snapshot.")
      });
  const readSettings: ToolCallback<typeof settingsSnapshotInput> = async (args, extra) => {
    const _meta = extra.mcpReq._meta;
      const view = await applicationService.settingsSnapshot({
        refreshModels: args.refreshModels
      });
      return settingsViewResult(
        view,
        metadataString(_meta, "openai/locale") || metadataString(_meta, "webplus/i18n"),
        "snapshot"
      );
    };
  const modelDescriptionHistoryInput = z.strictObject({
    view: z.literal("model-description-history"),
    modelId: z.string().min(1).max(200),
    beforeVersion: z.number().int().positive().optional()
  });
  const readModelDescriptionHistory: ToolCallback<typeof modelDescriptionHistoryInput> = async (args) => {
    const page = await applicationService.modelDescriptionHistory({
      modelId: args.modelId, beforeVersion: args.beforeVersion
    });
    return {
      content: [{ type: "text", text: "Model description history loaded." }],
      structuredContent: modelDescriptionHistoryPageOutputSchema.parse(page)
    };
  };

  const settingsAccessStrategyInput = config.allowDangerFullAccess
    ? z.enum(["read-only", "adaptive", "always-full"])
    : z.enum(["read-only", "adaptive"]);
  const projectOperationTargetInput = z.strictObject({
    name: projectNameInput(),
    cwd: z.string().trim().min(1).max(4_096)
  });
  const projectRegistryOperationInput = z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("add"),
      project: projectOperationTargetInput
    }),
    z.strictObject({
      kind: z.literal("rename"),
      projectId: scopeIdSchema(),
      name: projectNameInput()
    }),
    z.strictObject({
      kind: z.literal("relocate"),
      projectId: scopeIdSchema(),
      cwd: z.string().trim().min(1).max(4_096)
    }),
    z.strictObject({
      kind: z.literal("archive"),
      projectId: scopeIdSchema()
    }),
    z.strictObject({
      kind: z.literal("restore"),
      projectId: scopeIdSchema(),
      name: projectNameInput().optional(),
      cwd: z.string().trim().min(1).max(4_096).optional()
    }),
    z.strictObject({
      kind: z.literal("delete"),
      projectId: scopeIdSchema()
    })
  ]);
  const nestedSettingsPatchBase = z.strictObject({
    accessStrategy: settingsAccessStrategyInput.optional(),
    modelPolicy: editableModelPolicyZod().optional(),
    modelDescriptionOverrides: z.record(z.string().min(1).max(200), z.string().max(MAX_MODEL_DESCRIPTION_LENGTH)).optional(),
    usePriorityServiceTier: z.boolean().optional(),
    historyRetentionDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(0)]).optional(),
    uiLocalePreference: z.enum(UI_LOCALE_PREFERENCES).optional(),
    maxConcurrentJobs: z.number().int().min(1).max(config.maxConcurrentJobs).optional(),
    showBridgeThreadsInCodexApp: z.boolean().optional(),
    experimentalDirectResultDelivery: z.boolean().optional(),
    projectOperations: z.array(projectRegistryOperationInput)
      .min(1)
      .max(MAX_REGISTERED_PROJECTS * 2)
      .optional()
  });
  const nestedSettingsPatchInput = nestedSettingsPatchBase.refine(
    (patch) => Object.keys(patch).length > 0,
    "Provide at least one setting or project operation."
  );
  const settingsOperationInput = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("reset") }),
    z.strictObject({
      kind: z.literal("patch"),
      settings: nestedSettingsPatchInput
    })
  ]);
  const settingsInput = z.strictObject({
    expectedSettingsRevision: z.number().int().min(0).optional()
      .describe("Exact ordinary settingsRevision; required only when ordinary settings may change."),
    expectedRegistryRevision: z.number().int().min(0).optional()
      .describe("Exact project registryRevision; required only when project operations are present."),
    operation: settingsOperationInput.describe(
      "Reset defaults, or atomically patch settings and an explicit project-registry delta."
    )
  });

  async function applySettingsMutation(
    input: BridgeSettingsMutationInput
  ): Promise<SettingsView> {
    const args = settingsInput.parse(input);
    const resetRequested = args.operation.kind === "reset";
    const patch: BridgeUserSettingsPatch = {};
    let projectOperations: ProjectRegistryOperation[] = [];

    if (args.operation.kind === "patch") {
      const settings = args.operation.settings;
      const nestedKeys = [
        "accessStrategy",
        "modelPolicy",
        "modelDescriptionOverrides",
        "usePriorityServiceTier",
        "historyRetentionDays",
        "uiLocalePreference",
        "maxConcurrentJobs",
        "showBridgeThreadsInCodexApp",
        "experimentalDirectResultDelivery",
        "projectOperations"
      ] as const;
      if (!nestedKeys.some((key) => Object.prototype.hasOwnProperty.call(settings, key))) {
        throw new Error("SETTINGS_PATCH_EMPTY: Provide at least one setting or project operation.");
      }
      for (const key of [
        "accessStrategy",
        "modelPolicy",
        "modelDescriptionOverrides",
        "usePriorityServiceTier",
        "historyRetentionDays",
        "uiLocalePreference",
        "maxConcurrentJobs",
        "showBridgeThreadsInCodexApp",
        "experimentalDirectResultDelivery"
      ] as const) {
        if (settings[key] !== undefined) {
          (patch as Record<string, unknown>)[key] = settings[key];
        }
      }
      projectOperations = (settings.projectOperations || []) as ProjectRegistryOperation[];
    }

    const managedRuntimeEnv = process.env.CODEX_MCP_BRIDGE_ENV_FILE;
    if (managedRuntimeEnv && projectOperations.length > 0) {
      const currentProjects = userSettings.current.projects;
      const candidateRoots = projectOperations.flatMap((operation) => {
        switch (operation.kind) {
          case "add":
            return [operation.project.cwd];
          case "relocate":
            return [operation.cwd];
          case "restore":
            return operation.cwd
              ? [operation.cwd]
              : currentProjects
                  .filter((project) => project.id === operation.projectId)
                  .map((project) => project.cwd);
          default:
            return [];
        }
      });
      assertRuntimeEnvOutsideProjectRoots(managedRuntimeEnv, candidateRoots);
    }

    // Fail stale native clients/cards before any external catalog lookup. The
    // same revisions are checked again immediately before the atomic write.
    const hasGeneralMutation = resetRequested || Object.keys(patch).length > 0;
    if (hasGeneralMutation && args.expectedSettingsRevision === undefined) {
      throw new Error("SETTINGS_REVISION_CONFLICT: expectedSettingsRevision is required.");
    }
    if (projectOperations.length > 0 && args.expectedRegistryRevision === undefined) {
      throw new Error(
        "PROJECT_REGISTRY_REVISION_CONFLICT: expectedRegistryRevision is required."
      );
    }
    if (hasGeneralMutation) {
      userSettings.assertExpectedRevision(args.expectedSettingsRevision as number);
    }
    if (projectOperations.length > 0) {
      userSettings.assertExpectedRegistryRevision(args.expectedRegistryRevision as number);
    }
    const current = userSettings.current;
    const nextRevision = current.settingsRevision + 1;
    let validatedCatalog: CodexModelCatalogSnapshot | undefined;
    if (resetRequested) {
      const catalog = await freshCatalogForPolicy(
        modelCatalog,
        config.defaultBackend,
        nextRevision
      );
      validatedCatalog = catalog;
      const resetPolicy = userSettings.defaults.modelPolicy;
      validatePolicyAgainstCatalog(
        resetPolicy,
        catalog,
        config.operatorModelCeiling,
        nextRevision
      );
      assertPriorityCompatibility(
        resetPolicy,
        catalog,
        config.operatorModelCeiling,
        userSettings.defaults.usePriorityServiceTier,
        nextRevision
      );
      userSettings.reset(args.expectedSettingsRevision as number, resetPolicy);
    } else {
      if (patch.modelPolicy !== undefined || patch.usePriorityServiceTier !== undefined) {
        const policy = validateModelPolicy(patch.modelPolicy || current.modelPolicy);
        if (
          !sameModelPolicy(policy, current.modelPolicy) ||
          (
            patch.usePriorityServiceTier !== undefined &&
            patch.usePriorityServiceTier !== current.usePriorityServiceTier
          )
        ) {
          const catalog = await freshCatalogForPolicy(
            modelCatalog,
            config.defaultBackend,
            nextRevision
          );
          validatedCatalog = catalog;
          validatePolicyAgainstCatalog(
            policy,
            catalog,
            config.operatorModelCeiling,
            nextRevision
          );
          assertPriorityCompatibility(
            policy,
            catalog,
            config.operatorModelCeiling,
            patch.usePriorityServiceTier ?? current.usePriorityServiceTier,
            nextRevision
          );
        }
        if (patch.modelPolicy !== undefined) patch.modelPolicy = policy;
      }
      if (projectOperations.length > 0) {
        userSettings.updateWithProjectOperations(
          patch,
          projectOperations,
          hasGeneralMutation ? args.expectedSettingsRevision : undefined,
          args.expectedRegistryRevision
        );
      } else {
        userSettings.update(patch, args.expectedSettingsRevision as number);
      }
    }
    const projectionStatus = publishTaskProjection(validatedCatalog);
    return buildSettingsView(
      config,
      userSettings,
      modelCatalog,
      false,
      projectionStatus.descriptorProjectionUpdated,
      projectionStatus.developerModeRefreshRequired
    );
  }

  server.registerTool(
    "codex_update_settings",
    {
      title: `Save ${PRODUCT_INFO.displayName} Settings`,
      description:
        "Save or reset bridge settings from the settings card. Reset preserves registered projects; removing a registration preserves its files and work history.",
      inputSchema: settingsInput,
      outputSchema: settingsViewOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: {
        ui: {
          visibility: ["app"]
        },
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
        "codex/uiContractGeneration": SETTINGS_CARD_CONTRACT_GENERATION
      }
    },
    async (args, extra) => {
      const _meta = extra.mcpReq._meta;
      return settingsViewResult(
        await applicationService.updateSettings(args),
        metadataString(_meta, "openai/locale") || metadataString(_meta, "webplus/i18n"),
        "mutation"
      );
    }
  );

  server.registerTool(
    "codex_task",
    {
      title: "Run or Continue Codex Task",
      description:
        "Durably admit one asynchronous Codex turn in the current conversation and return its exact Job identity without waiting for completion. Follow the returned Job's completionDeliveryPolicy and nextActions. The default live-card policy supplies a codex_dashboard render action: call it immediately before any prose response so the originating conversation mounts its exact live Dashboard and can resume ChatGPT once with the terminal result. The opt-in experimental direct-wait policy supplies an exact bounded terminal codex_status wait instead: repeat that same Job wait after timeout or host abort, inspect the supplied input action after every non-terminal return, review the terminal result, and continue only work already approved by the user; never cross a new approval or input boundary. Each admitted Job keeps its policy snapshot even if Settings changes later. Explicit Activity policies still control separate native notification and verification channels.",
      inputSchema: codexTaskInputSchema(config, taskExecutionEnvelopeRef()),
      outputSchema: codexTaskOutputSchema,
      annotations: codexTaskEnvelopeAnnotations(config)
    },
    async (args, extra) => {
      let removeTaskAbortObserver: (() => void) | undefined;
      let releaseRuntimeAdmission: (() => void) | undefined;
      let admittedForCall = false;
      let taskScopeId: string | undefined;
      const onTaskAdmitted = () => {
        admittedForCall = true;
        releaseRuntimeAdmission?.();
        releaseRuntimeAdmission = undefined;
      };
      try {
        const _meta = extra.mcpReq._meta;
        const signal = extra.mcpReq.signal;
        const preferences = userSettings.current;
        args = normalizeCodexTaskInput(args);
        const scope = scopeResolver.require(
          _meta as ToolCallMetadata,
          args.scopeId,
          "Codex task execution"
        );
        taskScopeId = scope.scopeId;
        args.mcpPrincipal = authenticatedMcpPrincipal(extra);
        if (args.followup) {
          args = resolveApprovedFollowup(args, jobs, scope.scopeId);
          const prior = jobs.peekRequest(scope.scopeId, args.requestId);
          if (prior) return resultForJob(prior, config.jobStaleAfterMs, preferences, jobs);
        }
        if (testTaskReadStorageError) {
          const code = testTaskReadStorageError;
          testTaskReadStorageError = undefined;
          delete process.env.CODEX_MCP_BRIDGE_TEST_TASK_READ_STORAGE_ERROR;
          throw Object.assign(
            new Error("Injected non-transaction task read storage failure."),
            { code }
          );
        }
        const onAbort = () => {
          const admitted = jobs.peekRequest(scope.scopeId, args.requestId);
          if (!admitted) return;
          jobs.recordTransportObservation({
            kind: "mcp-handler-aborted",
            scopeId: scope.scopeId,
            jobId: admitted.jobId,
            activityId: admitted.activityId,
            toolName: "codex_task",
            callerRequestDigest: correlationDigest("mcp-request", extra.mcpReq.id),
            reasonCode: "task-call-detached"
          });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        removeTaskAbortObserver = () => signal?.removeEventListener("abort", onAbort);
        const existingRequest = jobs.peekRequest(scope.scopeId, args.requestId);
        if (!existingRequest && jobs.admissionStateStore.getArchivedJobAdmissionReceipt(
          scope.scopeId,
          { kind: "request", requestId: args.requestId }
        )) {
          throw new Error(
            "TASK_RESULT_EXPIRED: This requestId already admitted a terminal Codex Job whose result body is no longer retained. Read codex_status query kind='request' for its terminal admission fact. Use a new requestId only for a newly authorized logical turn."
          );
        }
        if (existingRequest && existingRequest.requestHashVersion !== CURRENT_TASK_REQUEST_HASH_VERSION) {
          throw new Error(
            "TASK_REPLAY_VERSION_UNSUPPORTED: This requestId belongs to a retired task contract. Read the existing Job with codex_status query kind='request' before considering a new logical turn."
          );
        }
        admitTaskContractForNewCall({
          args,
          executionEnvelopeRef: taskExecutionEnvelopeRef(),
          executionPolicyRef: currentTaskAdmissionRef(preferences)
        });
        if (!existingRequest) releaseRuntimeAdmission = acquireRuntimeAdmission();
        if (!existingRequest) {
          await config.codexService?.assertCurrentAdmission();
          jobs.resumeAuthorizedRecoveries();
        }
        resolveImplicitTaskAgent(args, jobs, scope.scopeId);
        const requestedActivity = validateActivityTaskRequest(args, jobs, scope.scopeId);
        const agentResolution = resolveAgentForTask(args, jobs, scope.scopeId, requestedActivity);
        if (agentResolution.agent?.currentThreadId &&
            sessions.belongsToAnotherAuthentication(agentResolution.agent.currentThreadId)) {
          throw new Error("CODEX_AUTH_AGENT_BOUNDARY: This Agent belongs to another authentication connection. Create a new Agent after switching accounts.");
        }
        validateTaskSelectionInput(args, preferences, requestedActivity, agentResolution);
        if (
          args.project === undefined &&
          (requestedActivity.activityId === undefined || agentResolution.contextMode === "fresh")
        ) {
          // Distinguish an empty registry (setup required) from an omitted
          // selection (project required), without ever choosing a fallback.
          void userSettings.resolveProject();
        }
        if (args.handoffSummary && agentResolution.contextMode !== "fresh") {
          throw new BackendHandoffContractError(
            "BACKEND_HANDOFF_SUMMARY_UNEXPECTED",
            "handoffSummary is accepted only for an existing Agent with context='fresh'."
          );
        }
        const projectAdmission = resolveTaskProjectAdmission({
          args,
          jobs,
          sessions,
          userSettings,
          activityRequest: requestedActivity,
          agentResolution
        });
        const activityRequest = requestedActivity;

        if (scope.scopeId === LEGACY_SCOPE_ID && agentResolution.contextMode === "fresh") {
          throw new Error("The legacy scope cannot create a fresh bridge Agent thread.");
        }
        if (agentResolution.contextMode === "fresh") {
          const backendHandoff = resolveBackendHandoff({
            args,
            resolution: agentResolution,
            jobs,
            targetBackend: config.defaultBackend
          });
          if (!projectAdmission) {
            throw new Error(
              "PROJECT_REQUIRED: Select an exact registered project for a fresh Agent context."
            );
          }
          const pinnedCwd = projectAdmission.cwd;
          let cwd: string;
          try {
            cwd = resolveAllowedCwd(pinnedCwd, config.allowedRoots);
          } catch {
            throw new Error(
              `${PROJECT_UNAVAILABLE}: The selected Activity project folder is no longer available.`
            );
          }
          if (cwd !== pinnedCwd) {
            throw new Error(
              `${PROJECT_UNAVAILABLE}: The selected Activity project no longer resolves to its admission-time folder.`
            );
          }
          const sandbox = resolveTaskSandbox(config, preferences);
          await upstream.prepareExecution?.({ backendKind: config.defaultBackend, contextMode: "fresh" });
          const executionResolution = await resolveExecutionDecision({
            config,
            upstream,
            modelCatalog,
            preferences,
            backendKind: config.defaultBackend,
            operation: "start",
            requestedSelection: args.selection,
            requestedPolicyRevision: undefined,
            onCatalog: publishTaskProjection
          });
          const decision = executionResolution.decision;
          refreshStableTaskAdmissionRef(
            args,
            preferences,
            executionResolution.admissionCatalogFingerprint,
            userSettings
          );
          assertExecutionPolicyAdmission({
            advertisedRef: taskAdmissionPolicyRef(args),
            currentRef: currentTaskAdmissionRef(
              userSettings.current,
              executionResolution.admissionCatalogFingerprint
            )
          });
          assertCurrentTaskProjectAdmission({
            requested: args.project,
            admitted: projectAdmission,
            userSettings,
            requireSameCwd: true
          });
          await enforceSensitiveFilePreflight(config, cwd, "run Codex");
          const routing = resolveTaskRouting({
            args,
            activityRequest,
            scopeId: scope.scopeId,
            projectRequest: args.project,
            projectId: projectAdmission?.projectId,
            cwd,
            sandbox,
            operation: "start",
            backendKind: config.defaultBackend,
            effectiveSelection: decision.effectiveSelection,
            agentId: agentResolution.agent?.agentId,
            contextMode: "fresh",
            backendHandoff
          });
          const replay = jobs.findRequest(
            routing.scopeId,
            routing.requestId,
            routing.requestHash
          );
          if (replay) {
            return resultForJob(replay, config.jobStaleAfterMs, preferences, jobs);
          }
          return await startNewSession({
            args,
            routing,
            requestedMode: "new",
            reason: activityRequest.activityId ? "activity-no-compatible" : "activity-new",
            config,
            upstream,
            sessions,
            jobs,
            modelCatalog,
            userSettings,
            preferences,
            activityRequest,
            agent: agentResolution.agent,
            newAgentName: agentResolution.newAgentName,
            contextMode: "fresh",
            agentRole: agentResolution.role,
            projectAdmission,
            backendHandoff,
            resolved: {
              cwd,
              sandbox,
              decision,
              admissionCatalogFingerprint:
                executionResolution.admissionCatalogFingerprint
            },
            preflightDone: true,
            onAdmitted: onTaskAdmitted
          });
        }

        if (!agentResolution.agent) {
          throw new Error("AGENT_CONTEXT_UNAVAILABLE: A new Agent has no thread to continue or fork. Use contextMode='fresh'.");
        }
        const session = await requireAgentSession(
          agentResolution,
          sessions,
          jobs,
          upstream,
          scope.scopeId,
          () => {
            assertExecutionPolicyAdmission({
              advertisedRef: taskAdmissionPolicyRef(args),
              currentRef: currentTaskAdmissionRef()
            });
            assertCurrentTaskProjectAdmission({
              requested: args.project,
              admitted: projectAdmission,
              userSettings,
              requireSameCwd: false
            });
          }
        );
        resolveTaskSandbox(config, preferences, session.sandbox);
        await upstream.prepareExecution?.({ backendKind: session.backendKind, contextMode: agentResolution.contextMode });
        const executionResolution = await resolveExecutionDecision({
          config,
          upstream,
          modelCatalog,
          preferences,
          backendKind: session.backendKind,
          operation: "continue",
          requestedSelection: args.selection,
          requestedPolicyRevision: undefined,
          currentSelection: session.selection,
          onCatalog: session.backendKind === config.defaultBackend
            ? publishTaskProjection
            : undefined
        });
        const executionDecision = executionResolution.decision;
        const executionDescriptorCatalogFingerprint = session.backendKind === config.defaultBackend
          ? executionResolution.admissionCatalogFingerprint
          : admissionFingerprintForCatalog(
              modelCatalog.getCachedCatalog?.({ backendKind: config.defaultBackend })
            );
        refreshStableTaskAdmissionRef(
          args,
          preferences,
          executionDescriptorCatalogFingerprint,
          userSettings
        );
        assertExecutionPolicyAdmission({
          advertisedRef: taskAdmissionPolicyRef(args),
          currentRef: currentTaskAdmissionRef(
            userSettings.current,
            executionDescriptorCatalogFingerprint
          )
        });
        assertCurrentTaskProjectAdmission({
          requested: args.project,
          admitted: projectAdmission,
          userSettings,
          requireSameCwd: false
        });
        const routing = resolveTaskRouting({
          args,
          activityRequest,
          scopeId: scope.scopeId,
          projectRequest: args.project,
          projectId: projectAdmission?.projectId,
          cwd: session.cwd,
          sandbox: session.sandbox,
          operation: agentResolution.contextMode === "continue" ? "continue" : "start",
          backendKind: session.backendKind,
          effectiveSelection: executionDecision.effectiveSelection,
          agentId: agentResolution.agent.agentId,
          contextMode: agentResolution.contextMode,
          sourceThreadId: session.threadId
        });
        const replay = jobs.findRequest(
          routing.scopeId,
          routing.requestId,
          routing.requestHash
        );
        if (replay) {
          return resultForJob(replay, config.jobStaleAfterMs, preferences, jobs);
        }
        if (agentResolution.contextMode === "fork") {
          return await forkTrackedSession({
            prompt: args.prompt,
            session,
            routing,
            config,
            upstream,
            sessions,
            jobs,
            preferences,
            activityRequest,
            executionDecision,
            agent: agentResolution.agent,
            agentRole: agentResolution.role,
            projectAdmission,
            userSettings,
            executionPolicyRef: taskAdmissionPolicyRef(args),
            executionPolicyCatalogFingerprint: executionDescriptorCatalogFingerprint,
            projectRequest: args.project,
            onAdmitted: onTaskAdmitted
          });
        }
        return await continueTrackedSession({
          prompt: args.prompt,
          requestedMode: "continue",
          reason: "activity-compatible",
          session,
          routing,
          config,
          upstream,
          sessions,
          jobs,
          preferences,
          activityRequest,
          executionDecision,
          agent: agentResolution.agent,
          contextMode: "continue",
          agentRole: agentResolution.role,
          projectAdmission,
          userSettings,
          executionPolicyRef: taskAdmissionPolicyRef(args),
          executionPolicyCatalogFingerprint: executionDescriptorCatalogFingerprint,
          projectRequest: args.project,
          onAdmitted: onTaskAdmitted
        });
      } catch (error) {
        try {
          runtimeOptions.onOperationFailure?.(error);
        } catch {
          // Storage observation cannot replace the task's structured error.
        }
        const admitted = admittedForCall && taskScopeId ? jobs.peekRequest(taskScopeId, args.requestId) : undefined;
        if (admitted) return resultForJob(admitted, config.jobStaleAfterMs, userSettings.current, jobs, false);
        if (error instanceof ExecutionPolicyChangedError) {
          return executionPolicyChangedResult(error);
        }
        if (error instanceof ExecutionEnvelopeChangedError) {
          return executionEnvelopeChangedResult(error);
        }
        if (error instanceof AgentThreadResumeError) {
          return agentThreadResumeErrorResult(error);
        }
        if (error instanceof BackendHandoffContractError) {
          return backendHandoffContractErrorResult(error);
        }
        if (error instanceof ModelPolicyError) {
          return modelPolicyErrorResult(error);
        }
        if (
          error instanceof Error &&
          error.message.startsWith(`${PROJECT_SETUP_REQUIRED}:`)
        ) {
          return projectSetupRequiredResult(error.message);
        }
        if (error instanceof ProjectSelectionRecoveryError) {
          const [code, ...message] = error.message.split(":");
          return taskPreflightErrorResult({ code, message: message.join(":").trim(), retryable: true,
            nextActions: projectRecoveryActions(userSettings, error.requested) });
        }
        if (
          error instanceof Error &&
          error.message.startsWith(`${PROJECT_REGISTRY_CHANGED}:`)
        ) {
          return projectSelectionChangedResult(error.message, userSettings, args.project);
        }
        if (
          error instanceof Error &&
          error.message.startsWith("PROJECT_REQUIRED:")
        ) {
          return projectSelectionRequiredResult(error.message, userSettings);
        }
        return taskPreflightErrorResult(errorFromException(error));
      } finally {
        releaseRuntimeAdmission?.();
        removeTaskAbortObserver?.();
      }
    }
  );
  server.registerTool("codex_ui_completion", {
    title: "Deliver Exact Job Completion",
    description:
      "App-only live Dashboard lease for one exact terminal Job. It coordinates a single standard ui/message attempt and records host acceptance, rejection, or uncertainty without treating the receipt as authorization.",
    inputSchema: jobCompletionDeliveryInput,
    outputSchema: jobCompletionDeliveryOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    _meta: {
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true
    }
  }, async (args, extra) => {
    const scope = scopeResolver.require(
      extra.mcpReq._meta as ToolCallMetadata,
      undefined,
      "Dashboard completion delivery"
    );
    const widgetInstanceId = mountedWidgetInstanceId(args, extra.mcpReq._meta);
    if (!widgetInstanceId) {
      throw new Error("MOUNTED_WIDGET_REQUIRED: Refresh the exact originating Dashboard.");
    }
    const current = jobs.get(args.jobId);
    if (
      !current ||
      current.scopeId !== scope.scopeId ||
      args.presentationRef !== dashboardPresentationRef(current)
    ) {
      throw new Error(
        "COMPLETION_PRESENTATION_MISMATCH: Refresh the exact Dashboard render action for this Job."
      );
    }
    if (current.completionDeliveryPolicy === "direct-wait") {
      const structured = jobCompletionDeliveryOutputSchema.parse({
        kind: "job-completion-delivery",
        state: "settled"
      });
      return {
        content: [{ type: "text", text: "This Job uses experimental direct-result delivery; live-card completion delivery is disabled." }],
        structuredContent: structured
      };
    }
    const store = jobs.admissionStateStore;
    let record;
    if (args.operation === "wait") {
      let job = current;
      if (isActiveActivityJobStatus(job.status)) {
        const waited = await jobs.wait(
          job.jobId,
          "terminal",
          args.waitMs ?? 8_000,
          extra.mcpReq.signal,
          "dashboard-completion"
        );
        job = waited.job;
      }
      if (isActiveActivityJobStatus(job.status)) {
        const structured = jobCompletionDeliveryOutputSchema.parse({
          kind: "job-completion-delivery",
          state: "waiting"
        });
        return { content: [{ type: "text", text: "Completion is not ready." }], structuredContent: structured };
      }
      record = store.claimJobCompletionDelivery(
        job.jobId,
        scope.scopeId,
        widgetInstanceId
      );
      if (record) {
        const structured = jobCompletionDeliveryOutputSchema.parse({
          kind: "job-completion-delivery",
          state: "claimed",
          receipt: record.receipt,
          attempt: record.attemptCount,
          leaseExpiresAt: new Date(record.leaseExpiresAt!).toISOString(),
          deliveryState: record.state
        });
        return { content: [{ type: "text", text: "Completion delivery lease claimed." }], structuredContent: structured };
      }
      const existing = store.getJobCompletionDelivery(job.jobId, scope.scopeId);
      const settled = Boolean(existing && (
        existing.state === "host-accepted" ||
        existing.state === "acceptance-unknown" ||
        existing.state === "result-read" ||
        existing.state === "host-rejected" && existing.attemptCount >= 3
      ));
      const structured = jobCompletionDeliveryOutputSchema.parse({
        kind: "job-completion-delivery",
        state: settled ? "settled" : "waiting",
        ...(existing ? { deliveryState: existing.state } : {})
      });
      return { content: [{ type: "text", text: settled ? "Completion delivery is settled." : "Completion delivery is waiting." }], structuredContent: structured };
    }

    const mutation = {
      jobId: current.jobId,
      scopeId: scope.scopeId,
      receipt: args.receipt,
      leaseOwner: widgetInstanceId
    };
    record = args.operation === "accepted"
      ? store.markJobCompletionHostAccepted(mutation)
      : args.operation === "rejected"
        ? store.markJobCompletionHostRejected({ ...mutation, error: args.error })
        : args.operation === "uncertain"
          ? store.markJobCompletionAcceptanceUnknown(mutation)
          : store.releaseJobCompletionDelivery(mutation);
    const structured = jobCompletionDeliveryOutputSchema.parse({
      kind: "job-completion-delivery",
      state: record.state === "host-rejected" && record.attemptCount < 3
        ? "waiting"
        : record.state === "pending"
          ? "waiting"
          : "settled",
      deliveryState: record.state
    });
    return { content: [{ type: "text", text: "Completion delivery state recorded." }], structuredContent: structured };
  });
  server.registerTool("codex_ui_read", {
    title: "Read Card Data", description: "App-only data reads for Dashboard, Settings, and selected work details. Each view retains its own scope and proof checks.",
    inputSchema: z.union([
      dashboardSnapshotInput.extend({ view: z.literal("dashboard") }),
      dashboardHistoryDetailInput,
      settingsSnapshotInput.extend({ view: z.literal("settings") }),
      modelDescriptionHistoryInput,
      controlDetailInput,
      problemControlDetailInput
    ]),
    outputSchema: APP_ONLY_OUTPUT_SCHEMAS.codex_ui_read,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] }, "openai/visibility": "private", "openai/widgetAccessible": true }
  }, async (args, extra) => {
    if (args.view === "problem-control") return readProblemControl(args,extra);
    if (args.view === "control") return readControl(args, extra);
    if (args.view === "dashboard-history") return readDashboardHistoryDetail(args, extra);
    if (args.view === "dashboard") { const { view, ...input } = args; return readDashboard(input, extra); }
    if (args.view === "settings") { const { view, ...input } = args; return readSettings(input, extra); }
    if (args.view === "model-description-history") return readModelDescriptionHistory(args, extra);
    throw new Error("UI_VIEW_UNSUPPORTED: Refresh the card and choose a supported view.");
  });
  server.registerTool("codex_ui_problem", {
    title:"Review Problems",description:"App-only execution review, undo, non-loading status recheck, and confirmed retry of failed termination. Every mutation requires a fresh mounted-card proof.",
    inputSchema:problemActionSchema.safeExtend({token:z.string().max(32768),widgetInstanceId:widgetInstanceIdSchema,scopeId:scopeIdSchema().optional()}),
    outputSchema:APP_ONLY_OUTPUT_SCHEMAS.codex_ui_problem,
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false},
    _meta:{ui:{visibility:["app"]},"openai/visibility":"private","openai/widgetAccessible":true}
  },async (args,extra) => {
    const problemArgs = problemActionSchema.safeExtend({
      token:z.string().max(32768),
      widgetInstanceId:widgetInstanceIdSchema,
      scopeId:scopeIdSchema().optional()
    }).parse(args);
    const host = scopeResolver.resolve(extra.mcpReq._meta as ToolCallMetadata,problemArgs.scopeId);
    const widget = mountedWidgetInstanceId(problemArgs,extra.mcpReq._meta);
    if (!widget) throw new Error("MOUNTED_WIDGET_REQUIRED: Refresh the problem list.");
    const claims = reviewProofs.require(problemArgs.token,widget,host?.scopeId,problemArgs);
    const {token,widgetInstanceId,scopeId,...input} = problemArgs;
    const result = await applicationService.problemAction!(input,claims.selectedScopeId || undefined,"widget-control");
    return {content:[{type:"text",text:"Problem action completed."}],structuredContent:result};
  });
  configureAutomaticRecovery(jobs,upstream,applicationService,acceptingNewJobs);
  return {
    applicationService,
    dispose: () => undefined
  };
}

function recheckRecoveryIdentity(jobs: CodexJobRegistry, agent: BridgeAgent,
  latest = jobs.observedLatestJobForAgent(agent.agentId)): AutomaticRecoveryCandidate {
  return {key:automaticRecoveryKey("recheck",[agent.agentId,agent.version,latest?.jobId]),
    scopeId:agent.scopeId,agentId:agent.agentId,jobId:agent.currentJobId || latest?.jobId,kind:"recheck"};
}

export function configureAutomaticRecovery(
  jobs: CodexJobRegistry,
  upstream: CodexUpstream,
  service: BridgeApplicationService,
  acceptingNewJobs: () => boolean
): void {
  const store = jobs.admissionStateStore;
  const candidates = async (agentId?: string): Promise<AutomaticRecoveryCandidate[]> => {
    if (!acceptingNewJobs() || jobs.runtimeAdmission.pendingAdmissions > 0) return [];
    // Production reconciliation passes exactly one Agent. No changed-Agent
    // event may materialize the global Job, incident, or connection catalog.
    if (!agentId) return [];
    const agent = jobs.getAgent(agentId);
    if (!agent) return [];
    const latest = jobs.observedLatestJobForAgent(agentId);
    const current = agent.currentJobId ? jobs.get(agent.currentJobId) : undefined;
    const thread = jobs.currentAgentThread(agentId);
    if (!thread || thread.backendKind !== "app-server") return [];
    const connection = store.threadConnections.get(thread.threadId);
    const releasableConnection = connection?.persistence === "persistent" &&
      connection.lastJobId && !["released", "releasing"].includes(connection.phase)
      ? connection : undefined;
    const recheckIdentity = recheckRecoveryIdentity(jobs, agent, latest);
    const couldRelease = releasableConnection &&
      !store.automaticRecovery.isBlocked(automaticRecoveryKey("release",
        [releasableConnection.threadId,releasableConnection.lastJobId]));
    if (store.automaticRecovery.isBlockedRecheckIdentity(recheckIdentity.key) && !couldRelease &&
        current?.status !== "termination-failed") return [];
    const result: AutomaticRecoveryCandidate[] = [];
    if (current?.status === "termination-failed" && current.cancellationIntentId) {
      const intent = jobs.getCancellationIntent(current.cancellationIntentId);
      if (intent?.status === "failed" && intent.targetJobId === current.jobId && intent.scopeId === agent.scopeId &&
          intent.source !== "assignment-containment" && current.upstreamRequestId && current.workerId && current.workerGeneration !== undefined &&
          intent.targetTurnId === current.upstreamRequestId && intent.targetThreadId === current.threadId) {
        const key = automaticRecoveryKey("retry-stop",
          [current.jobId,current.workerId,current.workerGeneration,current.upstreamRequestId,current.cancelRequestedAt]);
        if (!store.automaticRecovery.isBlocked(key)) result.push({key,
          scopeId:agent.scopeId,agentId:agent.agentId,jobId:current.jobId,kind:"retry-stop"});
      }
      return result;
    }
    const observation = dashboardRuntimeCaches.get(upstream)?.get(dashboardRuntimeCacheKey(thread));
    const unknown = observation?.stamp === dashboardRuntimeStamp(agent,latest) &&
      (observation.unavailable || observation.observation.state === "unknown" || observation.observation.backgroundProcessState === "unknown");
    const identity = dashboardRuntimeProblemIdentity(jobs,agent);
    const unresolvedOrphan = agent.lifecycle === "orphaned" && !store.workHistory.runtimeResolution(agent.agentId,identity.revision);
    const recheck = store.automaticRecovery.recheckCandidate(recheckIdentity,Boolean(unknown || unresolvedOrphan));
    if (recheck && !store.automaticRecovery.isBlocked(recheck.key)) result.push(recheck);
    const retained = releasableConnection && !current ? store.workHistory.latestJob(agent.agentId) : undefined;
    if (!current && releasableConnection?.lastJobId &&
        retained?.jobId === releasableConnection.lastJobId && ["failed","interrupted","cancelled"].includes(retained.status) &&
        !store.threadConnections.hasUnfinishedWork(thread.threadId)) {
      const key = automaticRecoveryKey("release",[thread.threadId,releasableConnection.lastJobId]);
      if (!store.automaticRecovery.isBlocked(key)) result.push({key,
        scopeId:agent.scopeId,agentId:agent.agentId,jobId:releasableConnection.lastJobId,kind:"release"});
    }
    return result;
  };
  const attempt = async (candidate: AutomaticRecoveryCandidate): Promise<AutomaticRecoveryResult> => {
    if (!(await candidates(candidate.agentId)).some(current => current.key === candidate.key)) {
      return {resolved:false,reason:"work-changed",retryable:false};
    }
    const agent = jobs.getAgent(candidate.agentId)!;
    const thread = jobs.currentAgentThread(agent.agentId)!;
    if (candidate.kind === "retry-stop") {
      const job = candidate.jobId ? jobs.get(candidate.jobId) : undefined;
      const previous = job?.cancellationIntentId ? jobs.getCancellationIntent(job.cancellationIntentId) : undefined;
      if (!job || !previous || job.status !== "termination-failed") return {resolved:false,reason:"work-changed",retryable:false};
      const requestId = randomUUID();
      const {intent} = jobs.beginCancellationOperation({scopeId:job.scopeId,requestId,
        actionHash:problemRevision([candidate.key,job.version,previous.intentId]),
        source:"operator",toolName:"bridge.automatic-recovery",actionName:"retry-exact-turn-interruption",
        target:cancellationTargetForJob(job),expectedVersion:job.version,
        callerRequestDigest:correlationDigest("prior-cancellation-intent",previous.intentId),reasonCode:"prior-stop-intent-retry"});
      await jobs.cancel(job.jobId,intent,{interruptOnly:true});
      const stopped = jobs.get(job.jobId)?.status === "cancelled" && jobs.getCancellationIntent(intent.intentId)?.status === "succeeded";
      jobs.completeCancellationOperation(job.scopeId,requestId,{ok:stopped,automatic:true,priorIntentId:previous.intentId,jobId:job.jobId});
      return stopped ? {resolved:true,reason:"original-stop-completed",evidence:"turn-interrupt"}
        : {resolved:false,reason:"precise-interruption-unconfirmed"};
    }
    if (candidate.kind === "recheck") {
      const identity = dashboardRuntimeProblemIdentity(jobs,agent);
      const checked = await service.problemAction!({requestId:randomUUID(),action:"recheck",
        targets:[{problemKey:problemKey("runtime",agent.agentId),expectedRevision:identity.revision}]},agent.scopeId);
      const fresh = jobs.getAgent(agent.agentId);
      if (!fresh || fresh.version !== agent.version) return {resolved:false,reason:"work-changed",retryable:false};
      if (checked.changed > 0) return {resolved:true,reason:"runtime-confirmed",evidence:"not-loaded-no-background"};
      const cached = dashboardRuntimeCaches.get(upstream)?.get(dashboardRuntimeCacheKey(thread));
      if (!cached || cached.stamp !== dashboardRuntimeStamp(fresh,jobs.observedLatestJobForAgent(agent.agentId))) {
        return {resolved:false,reason:"inspection-unconfirmed"};
      }
      const observation = cached.observation;
      const resolved = !cached.unavailable && observation.state !== "unknown" && observation.state !== "orphaned" && observation.backgroundProcessState === "confirmed";
      return resolved ? {resolved:true,reason:"runtime-confirmed",evidence:observation.state === "busy" ? "active-turn-observed" : "runtime-observed"}
        : {resolved:false,reason:"inspection-unconfirmed"};
    }
    const connection = store.threadConnections.get(thread.threadId);
    if (!connection || connection.scopeId !== agent.scopeId || connection.persistence !== "persistent" || !upstream.releaseThreadConnection) {
      return {resolved:false,reason:"release-unavailable",retryable:false};
    }
    if (connection.lastJobId !== candidate.jobId ||
        automaticRecoveryKey("release",[thread.threadId,connection.lastJobId]) !== candidate.key ||
        ["released","releasing"].includes(connection.phase)) {
      return {resolved:false,reason:"work-changed",retryable:false};
    }
    // The exact incident target is authoritative even when its thread ID is
    // beyond the bounded worker peer page. Only the additional peers are paged.
    const peers = connection.workerPid
      ? store.threadConnections.listForWorker(connection.workerPid,31,connection.threadId)
      : [];
    const eligible = new Map<string, {candidate:AutomaticRecoveryCandidate;agent:BridgeAgent;connection:ThreadConnectionRecord}>([
      [thread.threadId,{candidate,agent,connection}]
    ]);
    let visitedPeers = 0;
    for (const peerConnection of peers) {
      if (++visitedPeers % 8 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      // A peer without a terminal Job can never yield a release incident.
      if (!peerConnection.agentId || !peerConnection.lastJobId) continue;
      const key = automaticRecoveryKey("release",[peerConnection.threadId,peerConnection.lastJobId]);
      if (store.automaticRecovery.isBlocked(key)) continue;
      const owner = jobs.getAgent(peerConnection.agentId);
      if (!owner || owner.scopeId !== peerConnection.scopeId || owner.currentJobId) continue;
      const currentThread = jobs.currentAgentThread(owner.agentId);
      if (currentThread?.threadId !== peerConnection.threadId || currentThread.backendKind !== "app-server") continue;
      const retained = store.workHistory.latestJob(owner.agentId);
      if (retained?.jobId !== peerConnection.lastJobId ||
          !["failed","interrupted","cancelled"].includes(retained.status) ||
          store.threadConnections.hasUnfinishedWork(peerConnection.threadId)) continue;
      eligible.set(peerConnection.threadId,{candidate:{key,scopeId:owner.scopeId,agentId:owner.agentId,
        jobId:retained.jobId,kind:"release"},agent:owner,connection:peerConnection});
    }
    const releasing = store.threadConnections.update(thread.threadId,{phase:"releasing"},Date.now(),connection.revision);
    if (!releasing) return {resolved:false,reason:"work-changed",retryable:false};
    const canRelease = (id: string) => {
      const expected = eligible.get(id);
      if (!expected) return false;
      const currentAgent = jobs.getAgent(expected.agent.agentId), current = store.threadConnections.get(id);
      return acceptingNewJobs() && jobs.runtimeAdmission.pendingAdmissions === 0 &&
        currentAgent?.version === expected.agent.version && !currentAgent.currentJobId &&
        current?.revision === (id === thread.threadId ? releasing.revision : expected.connection.revision) &&
        current.lastJobId === expected.candidate.jobId && !store.threadConnections.hasUnfinishedWork(id);
    };
    try {
      const released = await upstream.releaseThreadConnection(thread.threadId,{canRelease,eligibleThreadIds:[...eligible.keys()],previousWorkerPid:connection.workerPid});
      const confirmed = released.phase === "released" && Boolean(released.evidence);
      if (confirmed) for (const id of released.releasedThreadIds || []) {
        if (id === thread.threadId || !canRelease(id)) continue;
        const peer = eligible.get(id)!;
        store.threadConnections.update(id,{phase:"released",evidence:released.evidence},Date.now(),peer.connection.revision);
        store.automaticRecovery.confirm(peer.candidate.key,"idle-connection-released",released.evidence!,Date.now());
      }
      store.threadConnections.update(thread.threadId,confirmed ? released : {phase:"blocked",reason:released.reason || "release-unconfirmed"},Date.now(),releasing.revision);
      return confirmed ? {resolved:true,reason:"idle-connection-released",evidence:released.evidence}
        : {resolved:false,reason:released.reason || "release-unconfirmed"};
    } catch {
      store.threadConnections.update(thread.threadId,{phase:"blocked",reason:"release-unconfirmed"},Date.now(),releasing.revision);
      return {resolved:false,reason:"release-unconfirmed"};
    }
  };
  jobs.configureAutomaticRecovery({candidates,
    pageAgents: (after, limit) => store.recoveryAgentIds(after, limit),
    agentForJob: jobId => jobs.get(jobId)?.agentId,
    attempt,enabled:() => acceptingNewJobs() && jobs.runtimeAdmission.pendingAdmissions === 0,
    changed:() => notifyCardObservation(upstream)});
}

type CodexTaskActivityInput =
  | { mode: "existing"; id: string }
  | {
      mode: "new";
      continuationOf?: string;
      title?: string;
      policy?: {
        kind?: ActivityKind;
        handoff?: ActivityHandoffPolicy;
        completion?: ActivityCompletionTrigger;
      };
    };

type CodexTaskAgentInput =
  | { mode: "existing"; id: string; context?: AgentContextMode; handoffSummary?: string }
  | { mode: "new"; name?: string };

type CodexTaskArgs = {
  mcpPrincipal?: string;
  /** Recovered only from a persisted v1 receipt, never from public input. */
  legacyFollowupIdentity?: { jobId: string; stepId: string };
  approvedFollowups?: Array<{ prompt: string }>;
  followup?: FollowupReference;
  scopeId?: string;
  requestId: string;
  taskContractVersion: typeof CODEX_TASK_INPUT_CONTRACT_VERSION;
  executionEnvelopeRef: string;
  /** Private admission snapshot; never part of the MCP input contract. */
  admittedExecutionPolicyRef?: string;
  prompt: string;
  project?: ProjectSelection;
  activity?: CodexTaskActivityInput;
  agent?: CodexTaskAgentInput;
  selection?: ModelChoice;
  /** Normalized private fields derived solely from the current nested input. */
  activityId?: string;
  continuationOfActivityId?: string;
  activityTitle?: string;
  activityKind?: ActivityKind;
  handoffPolicy?: ActivityHandoffPolicy;
  completionTrigger?: ActivityCompletionTrigger;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  contextMode?: AgentContextMode;
  handoffSummary?: string;
};

function normalizeCodexTaskInput(
  input: CodexTaskArgs
): CodexTaskArgs {
  const args = { ...input };
  if (args.activity?.mode === "existing") {
    args.activityId = args.activity.id;
  } else if (args.activity?.mode === "new") {
    args.continuationOfActivityId = args.activity.continuationOf;
    args.activityTitle = args.activity.title;
    args.activityKind = args.activity.policy?.kind;
    args.handoffPolicy = args.activity.policy?.handoff;
    args.completionTrigger = args.activity.policy?.completion;
  }

  if (args.agent?.mode === "existing") {
    args.agentId = args.agent.id;
    args.contextMode = args.agent.context;
    args.handoffSummary = args.agent.handoffSummary;
  } else if (args.agent?.mode === "new") {
    args.agentName = args.agent.name || defaultTaskAgentName(args.requestId);
    args.contextMode = "fresh";
  } else if (!args.activity || args.activity.mode === "new") {
    args.agentName = defaultTaskAgentName(args.requestId);
    args.contextMode = "fresh";
  }

  args.agentRole ||= "primary";
  return args;
}

function resolveApprovedFollowup(args: CodexTaskArgs, jobs: CodexJobRegistry, scopeId: string): CodexTaskArgs {
  const reference = args.followup!;
  const store = jobs.admissionStateStore;
  const receipt = store.taskFollowups.get(reference.followupId);
  if (!receipt || receipt.scopeId !== scopeId || receipt.mcpPrincipal !== args.mcpPrincipal || receipt.promptSha256 !== promptDigest(args.prompt)) {
    throw new Error("FOLLOWUP_NOT_APPROVED: This exact step and prompt were not approved in the original conversation.");
  }
  if (args.approvedFollowups || args.project || args.selection || args.handoffSummary ||
      args.activity && (args.activity.mode !== "existing" || args.activity.id !== receipt.activityId) ||
      args.agent && (args.agent.mode !== "existing" || args.agent.id !== receipt.agentId ||
        args.agent.context && args.agent.context !== "continue")) {
    throw new Error("FOLLOWUP_SCOPE_CHANGED: Approved followups must continue the original Activity, Agent, project and model selection.");
  }
  if (!receipt.admittedJobId) {
    if (jobs.peekRequest(scopeId, receipt.requestId)) {
      throw new Error("FOLLOWUP_ADMISSION_CONFLICT: The approved step's canonical requestId is already occupied by different work.");
    }
    const parent = jobs.get(receipt.parentJobId);
    const offered = store.getJobCompletionDelivery(receipt.parentJobId, scopeId);
    if (receipt.expiresAt <= Date.now() || !parent || parent.scopeId !== scopeId ||
        parent.status !== "completed" || parent.version !== reference.reviewedVersion ||
        !offered?.directResultOfferedAt && !offered?.completionResultOfferedAt) {
      throw new Error("FOLLOWUP_REVIEW_REQUIRED: Retrieve and review the current exact completed predecessor before admitting its approved step.");
    }
  } else if (!jobs.peekRequest(scopeId, receipt.requestId)) {
    throw new Error("TASK_RESULT_EXPIRED: The approved step already admitted a Job whose result is no longer retained. Its canonical requestId remains reserved.");
  }
  return normalizeCodexTaskInput({ ...args, requestId: receipt.requestId,
    legacyFollowupIdentity: receipt.stepId === undefined ? undefined : { jobId: receipt.parentJobId, stepId: receipt.stepId },
    activity: { mode: "existing", id: receipt.activityId },
    agent: { mode: "existing", id: receipt.agentId, context: "continue" },
    agentName: undefined, contextMode: "continue" });
}

function resolveImplicitTaskAgent(
  args: CodexTaskArgs,
  jobs: CodexJobRegistry,
  scopeId: string
): void {
  if (args.agentId || args.agentName) return;
  const sourceActivityId = args.activityId || args.continuationOfActivityId;
  if (!sourceActivityId) {
    args.agentName = defaultTaskAgentName(args.requestId);
    args.contextMode ||= "fresh";
    return;
  }
  const candidateIds = [...new Set(
    jobs.listActivityAgentAssignments(sourceActivityId).map((assignment) => assignment.agentId)
  )];
  if (candidateIds.length > 1) return;
  if (candidateIds.length === 1) {
    const agent = jobs.getAgent(candidateIds[0]);
    if (agent?.scopeId === scopeId) args.agentId = agent.agentId;
    return;
  }
  if (args.activityId) return;
  args.agentName = defaultTaskAgentName(args.requestId);
  args.contextMode ||= "fresh";
}

function defaultTaskAgentName(requestId: string): string {
  return `Codex Agent ${requestId}`;
}

// Only registry selection failures receive new-work project recovery. Pinned
// thread and post-admission failures must retain their original work identity.
class ProjectSelectionRecoveryError extends Error {
  constructor(error: Error, readonly requested: RuntimeProjectSelection) { super(error.message, { cause: error }); }
}

function resolveProjectForAdmission(userSettings: UserSettingsStore, requested?: RuntimeProjectSelection): ProjectTarget {
  try { return userSettings.resolveProject(requested); }
  catch (error) {
    if (requested && error instanceof Error &&
      (error.message.startsWith(`${PROJECT_UNAVAILABLE}:`) || error.message.startsWith("PROJECT_NOT_FOUND:"))) {
      throw new ProjectSelectionRecoveryError(error, requested);
    }
    throw error;
  }
}

class ExecutionPolicyChangedError extends Error {
  readonly code = "EXECUTION_POLICY_CHANGED" as const;

  constructor(readonly currentRef: string) {
    super(
      "EXECUTION_POLICY_CHANGED: The executable Codex policy changed after this task descriptor was listed. Refresh the tool descriptor and retry the logical call with a new requestId."
    );
    this.name = "ExecutionPolicyChangedError";
  }
}

class ExecutionEnvelopeChangedError extends Error {
  readonly code = "EXECUTION_ENVELOPE_CHANGED" as const;

  constructor() {
    super(
      "EXECUTION_ENVELOPE_CHANGED: The bridge operator envelope or stable task contract changed. Refresh the developer-mode connection before starting new work."
    );
    this.name = "ExecutionEnvelopeChangedError";
  }
}

class BackendHandoffContractError extends Error {
  constructor(
    readonly code: "BACKEND_HANDOFF_SUMMARY_REQUIRED" | "BACKEND_HANDOFF_SUMMARY_UNEXPECTED",
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "BackendHandoffContractError";
  }
}

function resolveBackendHandoff(input: {
  args: CodexTaskArgs;
  resolution: AgentTaskResolution;
  jobs: CodexJobRegistry;
  targetBackend: CodexBackendKind;
}): BackendHandoff | undefined {
  if (!input.resolution.agent) {
    if (input.args.handoffSummary) {
      throw new BackendHandoffContractError(
        "BACKEND_HANDOFF_SUMMARY_UNEXPECTED",
        "A new Agent has no prior backend thread to summarize."
      );
    }
    return undefined;
  }
  const sourceThread = input.jobs
    .listAgentThreads(input.resolution.agent.agentId)
    .find((thread) => thread.threadId === input.resolution.agent?.currentThreadId);
  if (!sourceThread || sourceThread.backendKind === input.targetBackend) {
    if (input.args.handoffSummary) {
      throw new BackendHandoffContractError(
        "BACKEND_HANDOFF_SUMMARY_UNEXPECTED",
        "handoffSummary is reserved for an explicit backend change; this fresh thread keeps the same backend."
      );
    }
    return undefined;
  }
  const summary = input.args.handoffSummary;
  if (!summary || !/\S/u.test(summary)) {
    throw new BackendHandoffContractError(
      "BACKEND_HANDOFF_SUMMARY_REQUIRED",
      `Agent ${input.resolution.agent.agentId} is pinned to ${sourceThread.backendKind}, while new threads use ${input.targetBackend}. ` +
      "Retry with context='fresh' and an explicit handoffSummary. Only that summary is copied; the original transcript and backend state are not migrated."
    );
  }
  return {
    sourceBackend: sourceThread.backendKind as CodexBackendKind,
    targetBackend: input.targetBackend,
    sourceThreadId: sourceThread.threadId,
    continuity: "explicit-summary-only",
    summarySha256: createHash("sha256").update(summary).digest("hex"),
    summary
  };
}

function backendHandoffAudit(handoff: BackendHandoff): BackendHandoffAudit {
  return {
    sourceBackend: handoff.sourceBackend,
    targetBackend: handoff.targetBackend,
    sourceThreadId: handoff.sourceThreadId,
    continuity: handoff.continuity,
    summarySha256: handoff.summarySha256
  };
}

function backendHandoffPrompt(handoff: BackendHandoff, prompt: string): string {
  return [
    "[Explicit backend handoff]",
    `Source backend: ${handoff.sourceBackend}`,
    `Target backend: ${handoff.targetBackend}`,
    "Continuity: summary-only. No transcript, hidden context, approvals, or backend state was migrated.",
    "Handoff summary:",
    handoff.summary,
    "",
    "[New request]",
    prompt
  ].join("\n");
}

type AgentThreadResumeErrorCode =
  | "AGENT_ORPHANED"
  | "AGENT_THREAD_BUSY"
  | "THREAD_PROBE_UNAVAILABLE";

class AgentThreadResumeError extends Error {
  constructor(
    readonly code: AgentThreadResumeErrorCode,
    readonly retryable: boolean,
    readonly probe: CodexThreadResumeProbe
  ) {
    const message = code === "AGENT_ORPHANED"
      ? "The backend reports that this Agent thread is missing or in a system-error state. Use contextMode='fresh' for an explicit replacement."
      : code === "AGENT_THREAD_BUSY"
        ? "The Agent thread already has an active App Server turn. Wait for that turn to finish, then retry."
        : "The bridge could not verify the Agent thread because the App Server probe was unavailable. Retry without replacing the Agent thread."
    super(`${code}: ${message}`);
    this.name = "AgentThreadResumeError";
  }
}

type ScopedHandleKind = "job" | "activity" | "agent" | "thread";

/**
 * Do not reveal whether a copied handle exists outside the caller's scope.
 * The recovery instruction remains useful for a stale or retained handle that
 * belongs to the caller, while the same response is used for foreign handles.
 */
function scopedHandleUnavailable(kind: ScopedHandleKind): Error {
  const label = {
    job: "Codex job",
    activity: "Activity",
    agent: "Agent",
    thread: "Codex thread"
  }[kind];
  return new Error(
    `HANDLE_UNAVAILABLE: The requested ${label} is unavailable in this conversation scope. ` +
    "Read codex_status({}) to obtain current retained handles before retrying."
  );
}

function validateTaskSelectionInput(
  args: CodexTaskArgs,
  preferences: BridgeUserSettings,
  activityRequest: { activityId?: string },
  agentResolution: { contextMode: AgentContextMode }
): void {
  if (
    preferences.modelPolicy.mode === "fixed" &&
    Object.prototype.hasOwnProperty.call(args, "selection")
  ) {
    throw new ModelPolicyError(
      "MODEL_SELECTION_FORBIDDEN",
      "This bridge is in fixed model mode and does not accept a per-call model selection.",
      preferences.revision,
      ["Omit selection and retry; the saved fixed selection will be applied."],
      "omit-selection"
    );
  }
  if (
    preferences.modelPolicy.mode === "automatic" &&
    args.selection === undefined &&
    (activityRequest.activityId === undefined || agentResolution.contextMode === "fresh")
  ) {
    throw new ModelPolicyError(
      "MODEL_SELECTION_REQUIRED",
      "Automatic policy requires an exact model and reasoning effort.",
      preferences.revision,
      ["codex_models"]
    );
  }
}

type ActivityTaskRequest = Pick<
  CodexTaskArgs,
  | "activityId"
  | "continuationOfActivityId"
  | "activityTitle"
  | "activityKind"
  | "handoffPolicy"
  | "completionTrigger"
>;

type AgentTaskResolution =
  | {
      agent: BridgeAgent;
      newAgentName?: never;
      contextMode: AgentContextMode;
      role?: string;
    }
  | {
      agent?: never;
      newAgentName: string;
      contextMode: "fresh";
      role?: string;
    };

function resolveAgentForTask(
  args: CodexTaskArgs,
  jobs: CodexJobRegistry,
  scopeId: string,
  activityRequest: ActivityTaskRequest
): AgentTaskResolution {
  if (args.agentId && args.agentName) {
    throw new Error("agentName creates a new Agent and cannot be combined with agentId. Use codex_agent rename for an existing Agent.");
  }
  let agent: BridgeAgent | undefined;
  if (args.agentId) {
    agent = jobs.getAgent(args.agentId);
    if (!agent || agent.scopeId !== scopeId) throw scopedHandleUnavailable("agent");
  } else if (!args.agentName) {
    const sourceActivityId = activityRequest.activityId || activityRequest.continuationOfActivityId;
    if (sourceActivityId) {
      const candidateIds = [...new Set(
        jobs.listActivityAgentAssignments(sourceActivityId).map((assignment) => assignment.agentId)
      )];
      if (candidateIds.length > 1) {
        throw new Error(
          "AGENT_ID_REQUIRED: This Activity has multiple Agent candidates. Retry with the exact intended agentId."
        );
      }
      if (candidateIds.length === 1) agent = jobs.getAgent(candidateIds[0]);
    }
  }

  if (!agent && !args.agentName && activityRequest.activityId) {
    throw new Error(
      "AGENT_REQUIRED: This Activity has no Agent candidate. Choose agent mode='new' or an exact existing Agent."
    );
  }

  if (!agent) {
    const contextMode = args.contextMode || "fresh";
    if (contextMode !== "fresh") {
      throw new Error(
        `AGENT_CONTEXT_UNAVAILABLE: A new Agent has no current thread to ${contextMode}. Use contextMode='fresh'.`
      );
    }
    return {
      contextMode,
      role: normalizeTaskAssignmentRole(args.agentRole),
      newAgentName: args.agentName || defaultTaskAgentName(args.requestId)
    };
  }
  const contextMode = args.contextMode || (agent.currentThreadId ? "continue" : "fresh");
  if ((contextMode === "continue" || contextMode === "fork") && !agent.currentThreadId) {
    throw new Error(
      `AGENT_CONTEXT_UNAVAILABLE: Agent ${agent.agentId} has no current thread to ${contextMode}. Use contextMode='fresh'.`
    );
  }
  if (agent.lifecycle === "orphaned" && contextMode !== "fresh") {
    throw new Error(
      `AGENT_ORPHANED: ${agent.orphanedReason || "The current backend thread cannot be resumed."} Use contextMode='fresh' for an explicit replacement thread.`
    );
  }
  return { agent, contextMode, role: normalizeTaskAssignmentRole(args.agentRole) };
}

function resolveTaskProjectAdmission(input: {
  args: CodexTaskArgs;
  jobs: CodexJobRegistry;
  sessions: SessionRegistry;
  userSettings: UserSettingsStore;
  activityRequest: ActivityTaskRequest;
  agentResolution: AgentTaskResolution;
}): TaskProjectAdmission | undefined {
  const requiresExplicitProject =
    input.activityRequest.activityId === undefined ||
    input.agentResolution.contextMode === "fresh";
  const selectedProject = requiresExplicitProject
    ? resolveProjectForAdmission(input.userSettings, input.args.project)
    : undefined;
  const usesExistingThread =
    Boolean(input.agentResolution.agent) &&
    (input.agentResolution.contextMode === "continue" || input.agentResolution.contextMode === "fork");
  // An attached Activity is immutable. A linked continuation also retains the
  // source project when it continues/forks a source thread, but a genuinely
  // fresh context creates a new Activity and may deliberately select another
  // registered project.
  const sourceActivityId = input.activityRequest.activityId ||
    (usesExistingThread ? input.activityRequest.continuationOfActivityId : undefined);
  const activityAdmission = sourceActivityId
    ? input.jobs.getActivityProjectAdmission(sourceActivityId)
    : undefined;
  const activityCwds = sourceActivityId
    ? [...new Set(input.jobs.listForActivity(sourceActivityId).map((job) => job.cwd))]
    : [];
  const activityCwdAmbiguous = activityCwds.length > 1;
  const legacyActivityCwd = activityCwds.length === 1 ? activityCwds[0] : undefined;

  let threadContext:
    | { projectId?: string; projectName?: string; cwd: string }
    | undefined;
  if (usesExistingThread && input.agentResolution.agent) {
    const agent = input.agentResolution.agent;
    const thread = input.jobs
      .listAgentThreads(agent.agentId)
      .find((candidate) => candidate.threadId === agent.currentThreadId);
    const session = agent.currentThreadId
      ? input.sessions.get(agent.currentThreadId)
      : undefined;
    const cwd = thread?.cwd || session?.cwd;
    if (cwd) {
      threadContext = {
        cwd,
        projectId: thread?.projectId || session?.projectId,
        projectName: thread?.projectName || session?.projectName
      };
    }
  }

  if (activityAdmission) {
    const admission = taskProjectFromActivity(activityAdmission);
    assertRequestedProjectMatches(input.args.project, admission, requiresExplicitProject);
    assertSelectedProjectMatchesAdmission(selectedProject, admission, usesExistingThread);
    if (
      threadContext &&
      (threadContext.cwd !== admission.cwd ||
        (threadContext.projectId !== undefined && threadContext.projectId !== admission.projectId))
    ) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: The selected Agent thread belongs to another project than the Activity.`
      );
    }
    return admission;
  }

  if (activityCwdAmbiguous) {
    if (input.args.project !== undefined) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: This migrated Activity spans multiple working folders and cannot be assigned one project.`
      );
    }
    return undefined;
  }

  if (legacyActivityCwd) {
    if (threadContext && threadContext.cwd !== legacyActivityCwd) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: The selected Agent thread working folder conflicts with the Activity.`
      );
    }
    if (input.args.project !== undefined) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: Legacy cwd-only Activities cannot acquire a project identity.`
      );
    }
    return undefined;
  }

  if (threadContext) {
    if (threadContext.projectId && threadContext.projectName) {
      const admission = {
        projectId: threadContext.projectId,
        projectName: threadContext.projectName,
        cwd: threadContext.cwd
      };
      assertRequestedProjectMatches(input.args.project, admission, requiresExplicitProject);
      assertSelectedProjectMatchesAdmission(selectedProject, admission, usesExistingThread);
      return admission;
    }
    if (input.args.project !== undefined) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: Legacy cwd-only Agent threads cannot acquire a project identity.`
      );
    }
    return undefined;
  }

  return taskProjectFromTarget(
    selectedProject || resolveProjectForAdmission(input.userSettings, input.args.project)
  );
}

function assertRequestedProjectMatches(
  requestedProject: RuntimeProjectSelection | undefined,
  admission: TaskProjectAdmission,
  selectionRequired: boolean
): void {
  if (!requestedProject) return;
  if (!selectionRequired) {
    throw new Error(
      `${PROJECT_CONTEXT_CONFLICT}: Omit project when continuing or forking a pinned Activity or Agent thread.`
    );
  }
  // The resolved UUID/cwd comparison below is authoritative. Snapshot names
  // remain audit/display data and never route an existing context.
}

function assertCurrentTaskProjectAdmission(input: {
  requested?: RuntimeProjectSelection;
  admitted?: TaskProjectAdmission;
  userSettings: UserSettingsStore;
  requireSameCwd: boolean;
}): TaskProjectAdmission | undefined {
  if (!input.requested) return;
  const current = taskProjectFromTarget(resolveProjectForAdmission(input.userSettings, input.requested));
  if (
    !input.admitted ||
    current.projectId !== input.admitted.projectId ||
    (input.requireSameCwd && current.cwd !== input.admitted.cwd)
  ) {
    throw new Error(
      `${PROJECT_REGISTRY_CHANGED}: Project choices changed before admission. Refresh the tool descriptor and retry.`
    );
  }
  return current;
}

function assertSelectedProjectMatchesAdmission(
  selected: ProjectTarget | undefined,
  admission: TaskProjectAdmission,
  preservePinnedCwd: boolean
): void {
  if (!selected) return;
  if (
    selected.id !== admission.projectId ||
    (!preservePinnedCwd && selected.cwd !== admission.cwd)
  ) {
    throw new Error(
      `${PROJECT_CONTEXT_CONFLICT}: The selected project no longer matches the pinned Activity or Agent thread.`
    );
  }
}

function taskProjectFromActivity(admission: ActivityProjectAdmission): TaskProjectAdmission {
  return {
    projectId: admission.projectId,
    projectName: admission.projectName,
    cwd: admission.projectCwd
  };
}

function taskProjectFromTarget(project: ProjectTarget): TaskProjectAdmission {
  return { projectId: project.id, projectName: project.name, cwd: project.cwd };
}

async function requireAgentSession(
  resolution: AgentTaskResolution,
  sessions: SessionRegistry,
  jobs: CodexJobRegistry,
  upstream: CodexUpstream,
  scopeId: string,
  assertCurrentAdmission?: () => void
): Promise<TrackedCodexSession> {
  if (!resolution.agent) throw new Error("Agent resolution is missing an existing thread owner.");
  const threadId = resolution.agent.currentThreadId as string;
  const session = sessions.get(threadId);
  if (!session && sessions.belongsToAnotherAuthentication(threadId)) {
    throw new Error("CODEX_AUTH_THREAD_BOUNDARY: The Agent's thread belongs to another authentication connection.");
  }
  if (!session || session.scopeId !== scopeId) {
    jobs.setAgentExecutionState(resolution.agent.agentId, "orphaned", {
      orphanedReason: "The Agent's persisted current thread session is unavailable after bridge recovery."
    });
    throw new Error(
      "AGENT_ORPHANED: The Agent current thread session is unavailable. Use contextMode='fresh' for an explicit replacement."
    );
  }
  if (session.backendKind !== "app-server") {
    throw new Error("CODEX_BACKEND_RETIRED: This thread's execution path was removed. Start a fresh App Server context with an explicit handoffSummary; its original history and credentials are preserved.");
  }
  let probe: Awaited<ReturnType<NonNullable<CodexUpstream["probeThread"]>>> | undefined;
  try {
    probe = upstream.probeThread
      ? await upstream.probeThread(threadId, session.backendKind)
      : undefined;
  } catch (error) {
    // If policy changed while the asynchronous probe was in flight, the stale
    // captured-admission error is authoritative even when the probe also failed.
    assertCurrentAdmission?.();
    throw error;
  }
  // The probe result can orphan an Agent or rewrite recovered session lineage.
  // Recheck the captured execution authority immediately before either
  // mutation so a stale call remains side-effect free.
  assertCurrentAdmission?.();
  if (probe?.state === "busy") {
    throw new AgentThreadResumeError("AGENT_THREAD_BUSY", true, probe);
  }
  if (probe?.state === "unknown") {
    throw new AgentThreadResumeError("THREAD_PROBE_UNAVAILABLE", true, probe);
  }
  if (
    probe?.state === "orphaned" ||
    (!probe && upstream.canResumeThread?.(threadId, session.backendKind) === false)
  ) {
    jobs.setAgentExecutionState(resolution.agent.agentId, "orphaned", {
      orphanedReason: "The backend reports that the Agent current thread can no longer be resumed."
    });
    throw new AgentThreadResumeError(
      "AGENT_ORPHANED",
      false,
      probe || { state: "orphaned", reason: "missing", threadId, retryable: false }
    );
  }
  if (
    probe &&
    (probe.sessionId !== undefined || probe.forkedFromThreadId !== undefined) &&
    (probe.sessionId !== session.sessionId ||
      probe.forkedFromThreadId !== session.forkedFromThreadId)
  ) {
    sessions.record({
      ...session,
      ...(probe.sessionId ? { sessionId: probe.sessionId } : {}),
      ...(probe.forkedFromThreadId ? { forkedFromThreadId: probe.forkedFromThreadId } : {}),
      updatedAt: Date.now()
    });
    return sessions.get(threadId) || session;
  }
  return session;
}

function validateActivityTaskRequest(
  args: ActivityTaskRequest,
  jobs: CodexJobRegistry,
  scopeId: string
): ActivityTaskRequest {
  const request: ActivityTaskRequest = {
    activityId: args.activityId,
    continuationOfActivityId: args.continuationOfActivityId,
    activityTitle: args.activityTitle,
    activityKind: args.activityKind,
    handoffPolicy: args.handoffPolicy,
    completionTrigger: args.completionTrigger
  };
  if (!request.activityId) {
    if (request.continuationOfActivityId) {
      const source = jobs.getActivity(request.continuationOfActivityId);
      if (!source || source.scopeId !== scopeId) throw scopedHandleUnavailable("activity");
    }
    return request;
  }
  if (request.continuationOfActivityId) {
    throw new Error("continuationOfActivityId creates a new linked Activity and cannot be combined with activityId.");
  }
  if (
    request.activityTitle !== undefined ||
    request.activityKind !== undefined ||
    request.handoffPolicy !== undefined ||
    request.completionTrigger !== undefined
  ) {
    throw new Error(
      "activityTitle, activityKind, handoffPolicy, and completionTrigger create a new Activity and cannot be used with activityId. Use codex_activity_update operation kind='set-policy' for an existing Activity."
    );
  }
  const activity = jobs.getActivity(request.activityId);
  if (!activity || activity.scopeId !== scopeId) throw scopedHandleUnavailable("activity");
  if (activity.lifecycle !== "open") {
    throw new Error("A new Codex job can be attached only to an open Activity.");
  }
  return request;
}

function resolveActivityForTask(
  jobs: CodexJobRegistry,
  request: ActivityTaskRequest,
  scopeId: string,
  projectAdmission?: TaskProjectAdmission
): BridgeActivity {
  const validated = validateActivityTaskRequest(request, jobs, scopeId);
  if (validated.activityId) {
    return jobs.getActivity(validated.activityId) as BridgeActivity;
  }
  return jobs.createActivity({
    scopeId,
          projectId: projectAdmission?.projectId,
    projectName: projectAdmission?.projectName,
    projectCwd: projectAdmission?.cwd,
    continuationOfActivityId: validated.continuationOfActivityId,
    title: validated.activityTitle,
    kind: validated.activityKind,
    handoffPolicy: validated.handoffPolicy,
    completionTrigger: validated.completionTrigger
  });
}

function recordAdmittedThread(input: {
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  authBoundary?: string;
  sessionDecision: SessionDecision;
  agent: BridgeAgent;
  threadId: string;
  scopeId: string;
  cwd: string;
  projectAdmission?: Pick<TaskProjectAdmission, "projectId" | "projectName">;
  sandbox: SandboxMode;
  selection: ExecutionDecision["effectiveSelection"];
  policyRevision: number;
  backendKind: CodexBackendKind;
  visibleInCodexApp: boolean;
  contextMode: AgentContextMode;
  sessionId?: string;
  forkedFromThreadId?: string;
}): () => void {
  const previousSession = input.sessions.getForJob(input.threadId, input.authBoundary);
  const previousDecisionThreadId = input.sessionDecision.threadId;
  const restoreSessions = input.sessions.captureInMemory();
  let recorded = false;
  const restore = () => {
    if (previousDecisionThreadId) input.sessionDecision.threadId = previousDecisionThreadId;
    else delete input.sessionDecision.threadId;
    if (recorded) restoreSessions();
  };
  try {
    input.jobs.activityTransaction(() => {
      input.sessionDecision.threadId = input.threadId;
      const now = Date.now();
      input.sessions.recordForJob({
        threadId: input.threadId,
        scopeId: input.scopeId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.forkedFromThreadId ? { forkedFromThreadId: input.forkedFromThreadId } : {}),
        cwd: input.cwd,
        ...(input.projectAdmission
          ? {
              projectId: input.projectAdmission.projectId,
              projectName: input.projectAdmission.projectName
            }
          : {}),
        sandbox: input.sandbox,
        selection: input.selection,
        policyRevision: input.policyRevision,
        backendKind: input.backendKind,
        visibleInCodexApp: input.visibleInCodexApp,
        persistence: input.jobs.admissionStateStore.threadConnections.get(input.threadId)?.persistence || previousSession?.persistence || "unknown",
        updatedAt: now,
        createdAt: now,
        lastUsedAt: now
      }, input.authBoundary);
      recorded = true;
      input.jobs.linkAgentThread({
        agentId: input.agent.agentId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        projectId: input.projectAdmission?.projectId,
        projectName: input.projectAdmission?.projectName,
        backendKind: input.backendKind,
        cwd: input.cwd,
        sandbox: input.sandbox,
        contextMode: input.contextMode,
        forkedFromThreadId: input.forkedFromThreadId
      });
    });
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

async function startNewSession(input: {
  args: CodexTaskArgs;
  routing: CodexRouting;
  requestedMode: SessionMode;
  reason: SessionDecision["reason"];
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  modelCatalog: CodexModelCatalogProvider;
  userSettings: UserSettingsStore;
  preferences: BridgeUserSettings;
  activityRequest: ActivityTaskRequest;
  agent?: BridgeAgent;
  newAgentName?: string;
  contextMode: Extract<AgentContextMode, "fresh">;
  agentRole?: string;
  projectAdmission?: TaskProjectAdmission;
  backendHandoff?: BackendHandoff;
  resolved: {
    cwd: string;
    sandbox: SandboxMode;
    decision: ExecutionDecision;
    admissionCatalogFingerprint: string;
  };
  preflightDone?: boolean;
  rejectIfSelectionActive?: boolean;
  onAdmitted?: () => void;
}): Promise<ToolResult> {
  const { cwd, sandbox, decision: executionDecision } = input.resolved;
  const access = resolveExecutionPolicy(input.config, input.preferences, cwd, sandbox);
  if (!input.preflightDone) await enforceSensitiveFilePreflight(input.config, cwd, "run Codex");

  const basePrompt = input.backendHandoff
    ? backendHandoffPrompt(input.backendHandoff, input.args.prompt)
    : input.args.prompt;
  const prompt = basePrompt;
  const payload: Record<string, unknown> = {
    prompt,
    ...executionAccessArguments(access)
  };
  const ephemeralAppServerThread =
    backendSupports(input.config.defaultBackend, "supportsEphemeralThreads") &&
    !input.preferences.showBridgeThreadsInCodexApp;
  const storage = await input.config.codexService?.sessionPolicy(input.config.defaultBackend, input.preferences.showBridgeThreadsInCodexApp);
  if (backendSupports(input.config.defaultBackend, "supportsEphemeralThreads")) {
    payload.ephemeral = ephemeralAppServerThread;
  }
  applyModelSelection(payload, executionDecision.effectiveSelection, input.config.defaultBackend);
  const sessionDecision: SessionDecision = {
    requestedMode: input.requestedMode,
    action: "start",
    reason: input.reason,
    ...(input.backendHandoff ? { handoff: backendHandoffAudit(input.backendHandoff) } : {})
  };
  return runCodex({
    jobs: input.jobs,
    userSettings: input.userSettings,
    config: input.config,
    preferences: input.preferences,
    operation: "start",
    backendKind: input.config.defaultBackend,
    cwd,
    sandbox,
    routing: input.routing,
    selectionKey: selectionKeyFor(input.routing.scopeId, cwd, sandbox, executionDecision.effectiveSelection),
    executionDecision,
    rejectIfSelectionActive: input.rejectIfSelectionActive,
    sessionDecision,
    activityRequest: input.activityRequest,
    agent: input.agent,
    newAgentName: input.newAgentName,
    contextMode: input.contextMode,
    agentRole: input.agentRole,
    projectAdmission: input.projectAdmission,
    projectRequest: input.args.project,
    executionPolicyRef: taskAdmissionPolicyRef(input.args),
    executionPolicyCatalogFingerprint:
      input.resolved.admissionCatalogFingerprint,
    sourceThreadId: input.backendHandoff?.sourceThreadId,
    run: (onProgress, onAssigned) => input.upstream.startThread
      ? input.upstream.startThread(
          {
            backendKind: input.config.defaultBackend,
            ...(storage?.contextId ? { contextId: storage.contextId } : {}),
            prompt,
            ...access,
            selection: executionDecision.effectiveSelection,
            ...(backendSupports(input.config.defaultBackend, "supportsEphemeralThreads")
              ? { ephemeral: ephemeralAppServerThread }
              : {})
          },
          onProgress,
          onAssigned
        )
      : input.upstream.callTool("codex", payload, onProgress, onAssigned),
    onAssigned: (assignment, agent, job) => {
      if (!assignment.threadId) return;
      // A cross-backend handoff becomes current only after turn/start accepts
      // the summary-bearing turn. If the worker exits after thread/start but
      // before that point, retain the source Agent as current and keep the new
      // thread correlated only on the failed Job for explicit reconciliation.
      if (input.backendHandoff && !assignment.upstreamRequestId) return;
      recordAdmittedThread({
        sessions: input.sessions,
        jobs: input.jobs,
        authBoundary: job.authBoundary,
        sessionDecision: job.sessionDecision,
        agent,
        threadId: assignment.threadId,
        scopeId: input.routing.scopeId,
        cwd,
        projectAdmission: input.projectAdmission,
        sandbox,
        selection: executionDecision.effectiveSelection,
        policyRevision: executionDecision.policyRevision,
        backendKind: assignment.backendKind,
        visibleInCodexApp:
          storage?.visibleInCodexApp ?? (backendSupports(assignment.backendKind, "supportsThreadInspection") && !ephemeralAppServerThread),
        contextMode: input.contextMode,
        sessionId: assignment.sessionId,
        forkedFromThreadId: assignment.forkedFromThreadId
      });
    },
    onAdmitted: input.onAdmitted,
    onComplete: (result, agent, job) => {
      const threadId = extractThreadId(result);
      if (!threadId) return;
      const lineage = extractResultThreadLineage(result);
      return recordAdmittedThread({
        sessions: input.sessions,
        jobs: input.jobs,
        authBoundary: job.authBoundary,
        sessionDecision: job.sessionDecision,
        agent,
        threadId,
        scopeId: input.routing.scopeId,
        cwd,
        projectAdmission: input.projectAdmission,
        sandbox,
        selection: executionDecision.effectiveSelection,
        policyRevision: executionDecision.policyRevision,
        backendKind: extractResultBackendKind(result) || input.config.defaultBackend,
        visibleInCodexApp:
          storage?.visibleInCodexApp ?? (backendSupports((extractResultBackendKind(result) || input.config.defaultBackend), "supportsThreadInspection") &&
          !ephemeralAppServerThread),
        sessionId: lineage.sessionId,
        forkedFromThreadId: lineage.forkedFromThreadId,
        contextMode: input.contextMode
      });
    }
  });
}

function resolvePinnedAgentCwd(input: {
  session: TrackedCodexSession;
  config: BridgeConfig;
}): string {
  let currentCwd: string;
  try {
    currentCwd = resolveAllowedCwd(input.session.cwd, input.config.allowedRoots);
  } catch {
    throw new Error(
      "PROJECT_UNAVAILABLE: The Agent thread project folder is unavailable. Restore that folder or use contextMode='fresh' in an available project."
    );
  }
  if (currentCwd !== input.session.cwd) {
    throw new Error(
      "PROJECT_UNAVAILABLE: The Agent thread project identity changed. Restore the admitted folder or use contextMode='fresh' in an available project."
    );
  }
  return currentCwd;
}

async function continueTrackedSession(input: {
  prompt: string;
  requestedMode: SessionMode;
  reason: SessionDecision["reason"];
  session: TrackedCodexSession;
  routing: CodexRouting;
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  preferences: BridgeUserSettings;
  activityRequest: ActivityTaskRequest;
  adoptOnComplete?: boolean;
  preflightDone?: boolean;
  rejectIfSelectionActive?: boolean;
  executionDecision: ExecutionDecision;
  agent: BridgeAgent;
  contextMode: Extract<AgentContextMode, "continue">;
  agentRole?: string;
  projectAdmission?: TaskProjectAdmission;
  userSettings: UserSettingsStore;
  executionPolicyRef?: string;
  executionPolicyCatalogFingerprint: string | null;
  projectRequest?: RuntimeProjectSelection;
  onAdmitted?: () => void;
}): Promise<ToolResult> {
  const access = resolveExecutionPolicy(input.config, input.preferences, input.session.cwd, input.session.sandbox);
  const currentCwd = resolvePinnedAgentCwd(input);
  if (!input.preflightDone) {
    await enforceSensitiveFilePreflight(input.config, currentCwd, "continue Codex");
  }
  const prompt = input.prompt;
  const decision: SessionDecision = {
    requestedMode: input.requestedMode,
    action: "continue",
    reason: input.reason,
    threadId: input.session.threadId
  };
  let executionStateApplied = false;
  return runCodex({
    jobs: input.jobs,
    config: input.config,
    preferences: input.preferences,
    operation: "continue",
    backendKind: input.session.backendKind,
    cwd: input.session.cwd,
    sandbox: input.session.sandbox,
    routing: input.routing,
    selectionKey: selectionKeyFor(input.routing.scopeId, input.session.cwd, input.session.sandbox, {
      ...input.executionDecision.effectiveSelection
    }),
    executionDecision: input.executionDecision,
    rejectIfSelectionActive: input.rejectIfSelectionActive,
    sessionDecision: decision,
    activityRequest: input.activityRequest,
    agent: input.agent,
    contextMode: input.contextMode,
    agentRole: input.agentRole,
    projectAdmission: input.projectAdmission,
    userSettings: input.userSettings,
    executionPolicyRef: input.executionPolicyRef,
    executionPolicyCatalogFingerprint: input.executionPolicyCatalogFingerprint,
    projectRequest: input.projectRequest,
    sourceThreadId: input.session.threadId,
    onAdmitted: input.onAdmitted,
    exclusiveKeys: [threadExclusiveKey(input.session.threadId)],
    run: (onProgress, onAssigned) => {
      const recordAssignment = (assignment: UpstreamWorkerAssignment) => {
        onAssigned(assignment);
        if (executionStateApplied || !backendSupports(input.session.backendKind, "supportsTurnSelection")) return;
        executionStateApplied = true;
        try {
          input.sessions.updateExecution(
            input.session.threadId,
            input.executionDecision.effectiveSelection,
            input.executionDecision.policyRevision
          );
        } catch (error) {
          console.error(
            `Could not persist App Server turn selection for ${input.session.threadId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      };
      if (input.upstream.continueThread) {
        return input.upstream.continueThread(
          {
            backendKind: input.session.backendKind,
            threadId: input.session.threadId,
            prompt,
            ...access,
            ...(backendSupports(input.session.backendKind, "supportsTurnSelection")
              ? { selection: input.executionDecision.effectiveSelection }
              : {})
          },
          onProgress,
          recordAssignment
        );
      }
      const payload: Record<string, unknown> = {
        threadId: input.session.threadId,
        prompt,
        ...executionAccessArguments(access),
        ...backendRoutingArgument(input.session.backendKind)
      };
      if (backendSupports(input.session.backendKind, "supportsTurnSelection")) {
        applyModelSelection(payload, input.executionDecision.effectiveSelection, input.session.backendKind);
      }
      return input.upstream.callTool("codex-reply", payload, onProgress, recordAssignment);
    },
    onComplete: (result, _agent, job) => {
      const restoreSessions = input.sessions.captureInMemory();
      const lineage = extractResultThreadLineage(result);
      const existingThread = input.jobs
        .listAgentThreads(input.agent.agentId)
        .find((thread) => thread.threadId === input.session.threadId);
      let recorded = false;
      const restore = () => {
        if (recorded) restoreSessions();
      };
      try {
        input.sessions.recordForJob({
          ...input.session,
          ...lineage,
          ...(input.projectAdmission
            ? {
                projectId: input.projectAdmission.projectId,
                projectName: input.projectAdmission.projectName
              }
            : {}),
          scopeId: input.adoptOnComplete ? input.routing.scopeId : input.session.scopeId,
          selection: input.executionDecision.effectiveSelection,
          policyRevision: input.executionDecision.policyRevision,
          updatedAt: Date.now(),
          lastUsedAt: Date.now()
        }, job.authBoundary);
        recorded = true;
        input.jobs.linkAgentThread({
          agentId: input.agent.agentId,
          threadId: input.session.threadId,
          sessionId: lineage.sessionId || existingThread?.sessionId || input.session.sessionId,
          projectId: input.projectAdmission?.projectId,
          projectName: input.projectAdmission?.projectName,
          backendKind: input.session.backendKind,
          cwd: input.session.cwd,
          sandbox: input.session.sandbox,
          // A continuation enriches legacy admission metadata; it does not
          // rewrite how the existing thread originally entered the Agent.
          contextMode: existingThread?.contextMode || "continue",
          forkedFromThreadId: existingThread?.forkedFromThreadId
        });
      } catch (error) {
        restore();
        throw error;
      }
      return restore;
    }
  });
}

async function forkTrackedSession(input: {
  prompt: string;
  session: TrackedCodexSession;
  routing: CodexRouting;
  config: BridgeConfig;
  upstream: CodexUpstream;
  sessions: SessionRegistry;
  jobs: CodexJobRegistry;
  preferences: BridgeUserSettings;
  activityRequest: ActivityTaskRequest;
  executionDecision: ExecutionDecision;
  agent: BridgeAgent;
  agentRole?: string;
  projectAdmission?: TaskProjectAdmission;
  userSettings: UserSettingsStore;
  executionPolicyRef?: string;
  executionPolicyCatalogFingerprint: string | null;
  projectRequest?: RuntimeProjectSelection;
  onAdmitted?: () => void;
}): Promise<ToolResult> {
  const access = resolveExecutionPolicy(input.config, input.preferences, input.session.cwd, input.session.sandbox);
  if (!backendCapabilities(input.upstream, input.session.backendKind).supportsFork || !input.upstream.forkThread) {
    throw new Error(
      `CONTEXT_MODE_UNSUPPORTED: Backend ${input.session.backendKind} does not support contextMode='fork'. Use continue or fresh.`
    );
  }
  const storage = await input.config.codexService?.sessionPolicy(input.session.backendKind, input.preferences.showBridgeThreadsInCodexApp, input.session.threadId);
  const currentCwd = resolvePinnedAgentCwd(input);
  await enforceSensitiveFilePreflight(input.config, currentCwd, "fork Codex context");
  const prompt = input.prompt;
  const sessionDecision: SessionDecision = {
    requestedMode: "new",
    action: "start",
    reason: "explicit-new",
    threadId: input.session.threadId
  };
  return runCodex({
    jobs: input.jobs,
    config: input.config,
    preferences: input.preferences,
    operation: "start",
    backendKind: input.session.backendKind,
    cwd: input.session.cwd,
    sandbox: input.session.sandbox,
    routing: input.routing,
    selectionKey: selectionKeyFor(
      input.routing.scopeId,
      input.session.cwd,
      input.session.sandbox,
      input.executionDecision.effectiveSelection
    ),
    executionDecision: input.executionDecision,
    sessionDecision,
    activityRequest: input.activityRequest,
    agent: input.agent,
    contextMode: "fork",
    agentRole: input.agentRole,
    projectAdmission: input.projectAdmission,
    userSettings: input.userSettings,
    executionPolicyRef: input.executionPolicyRef,
    executionPolicyCatalogFingerprint: input.executionPolicyCatalogFingerprint,
    projectRequest: input.projectRequest,
    sourceThreadId: input.session.threadId,
    onAdmitted: input.onAdmitted,
    exclusiveKeys: [threadExclusiveKey(input.session.threadId)],
    run: (onProgress, onAssigned) => input.upstream.forkThread?.(
      {
        backendKind: input.session.backendKind,
        ...access,
        threadId: input.session.threadId,
        prompt,
        selection: input.executionDecision.effectiveSelection,
        ephemeral: !input.preferences.showBridgeThreadsInCodexApp
      },
      onProgress,
      onAssigned
    ) as Promise<ToolResult>,
    onAssigned: (assignment, _agent, job) => {
      if (!assignment.threadId) return;
      recordAdmittedThread({
        sessions: input.sessions,
        jobs: input.jobs,
        authBoundary: job.authBoundary,
        sessionDecision: job.sessionDecision,
        agent: input.agent,
        threadId: assignment.threadId,
        scopeId: input.routing.scopeId,
        cwd: input.session.cwd,
        projectAdmission: input.projectAdmission,
        sandbox: input.session.sandbox,
        selection: input.executionDecision.effectiveSelection,
        policyRevision: input.executionDecision.policyRevision,
        backendKind: input.session.backendKind,
        visibleInCodexApp:
          storage?.visibleInCodexApp ?? (backendSupports(input.session.backendKind, "supportsThreadInspection") &&
          input.preferences.showBridgeThreadsInCodexApp),
        contextMode: "fork",
        sessionId: assignment.sessionId || input.session.sessionId,
        forkedFromThreadId: assignment.forkedFromThreadId || input.session.threadId
      });
    },
    onComplete: (result, _agent, job) => {
      const threadId = extractThreadId(result);
      if (!threadId) return;
      const lineage = extractResultThreadLineage(result, input.session.threadId);
      return recordAdmittedThread({
        sessions: input.sessions,
        jobs: input.jobs,
        authBoundary: job.authBoundary,
        sessionDecision: job.sessionDecision,
        agent: input.agent,
        threadId,
        scopeId: input.routing.scopeId,
        cwd: input.session.cwd,
        projectAdmission: input.projectAdmission,
        sandbox: input.session.sandbox,
        selection: input.executionDecision.effectiveSelection,
        policyRevision: input.executionDecision.policyRevision,
        backendKind: input.session.backendKind,
        visibleInCodexApp:
          storage?.visibleInCodexApp ?? (backendSupports(input.session.backendKind, "supportsThreadInspection") &&
          input.preferences.showBridgeThreadsInCodexApp),
        sessionId: lineage.sessionId,
        contextMode: "fork",
        forkedFromThreadId: lineage.forkedFromThreadId || input.session.threadId
      });
    }
  });
}

async function runCodex(input: {
  jobs: CodexJobRegistry;
  userSettings?: UserSettingsStore;
  config: BridgeConfig;
  preferences: BridgeUserSettings;
  operation: CodexJobOperation;
  backendKind: CodexBackendKind;
  cwd: string;
  sandbox: SandboxMode;
  routing: CodexRouting;
  sessionDecision: SessionDecision;
  activityRequest: ActivityTaskRequest;
  agent?: BridgeAgent;
  newAgentName?: string;
  contextMode: AgentContextMode;
  agentRole?: string;
  projectAdmission?: TaskProjectAdmission;
  projectRequest?: RuntimeProjectSelection;
  executionPolicyRef?: string;
  executionPolicyCatalogFingerprint?: string | null;
  sourceThreadId?: string;
  selectionKey: string;
  executionDecision: ExecutionDecision;
  rejectIfSelectionActive?: boolean;
  onAdmitted?: () => void;
  exclusiveKeys?: string[];
  run: (
    onProgress: (progress: Progress) => void,
    onAssigned: (assignment: UpstreamWorkerAssignment) => void
  ) => Promise<ToolResult>;
  onAssigned?: (assignment: UpstreamWorkerAssignment, agent: BridgeAgent, job: CodexJob) => void;
  onComplete?: (result: ToolResult, agent: BridgeAgent, job: CodexJob) => void | (() => void);
}): Promise<ToolResult> {
  if (!input.agent && !input.newAgentName) {
    throw new Error("Codex task admission requires an existing Agent or a new Agent name.");
  }
  let job!: CodexJob;
  let deferredAdmissionJobId: string | undefined;
  let replayedDuringAdmission = false;
  const admit = () => input.jobs.activityTransaction(() => {
    const replay = input.jobs.findRequest(
      input.routing.scopeId,
      input.routing.requestId,
      input.routing.requestHash
    );
    if (replay) {
      job = replay;
      replayedDuringAdmission = true;
      return;
    }
    if (input.userSettings) {
      assertExecutionPolicyAdmission({
        advertisedRef: input.executionPolicyRef,
        currentRef: input.userSettings.executionPolicyRef(
          input.userSettings.current,
          input.executionPolicyCatalogFingerprint || null
        )
      });
    }
    let projectAdmission = input.projectAdmission;
    if (input.projectRequest) {
      if (!input.userSettings) {
        throw new Error("Project registry authority is missing from project-selecting admission.");
      }
      const currentProject = assertCurrentTaskProjectAdmission({
        requested: input.projectRequest,
        admitted: projectAdmission,
        userSettings: input.userSettings,
        requireSameCwd: input.contextMode === "fresh"
      }) as TaskProjectAdmission;
      projectAdmission = input.contextMode === "fresh"
        ? currentProject
        : {
            ...(projectAdmission as TaskProjectAdmission),
            projectName: currentProject.projectName
          };
    }
    const activity = resolveActivityForTask(
      input.jobs,
      input.activityRequest,
      input.routing.scopeId,
      projectAdmission
    );
    const agent = input.agent || input.jobs.createAgent({
      scopeId: input.routing.scopeId,
      agentName: input.newAgentName as string
    });
    input.jobs.assignAgent({
      activityId: activity.activityId,
      agentId: agent.agentId,
      contextMode: input.contextMode,
      role: input.agentRole
    });
    const completionDeliveryPolicy: CompletionDeliveryPolicy =
      (input.userSettings?.current.experimentalDirectResultDelivery ??
        input.preferences.experimentalDirectResultDelivery)
        ? "direct-wait"
        : "live-card";
    job = input.jobs.start(
      {
        operation: input.operation,
        backendKind: input.backendKind,
        activityId: activity.activityId,
        projectId: projectAdmission?.projectId,
        projectName: projectAdmission?.projectName,
        projectRequest: input.projectRequest,
        agentId: agent.agentId,
        contextMode: input.contextMode,
        cwd: input.cwd,
        sandbox: input.sandbox,
        scopeId: input.routing.scopeId,
        requestId: input.routing.requestId,
        requestHash: input.routing.requestHash,
        requestHashVersion: input.routing.requestHashVersion,
        mcpPrincipal: input.routing.mcpPrincipal,
        approvedFollowups: input.routing.approvedFollowups,
        followup: input.routing.followup,
        completionDeliveryPolicy,
        sourceThreadId: input.sourceThreadId,
        selectionKey: activitySelectionKey(activity.activityId, input.selectionKey),
        executionDecision: input.executionDecision,
        exclusiveKeys: [
          agentExclusiveKey(agent.agentId),
          ...(input.exclusiveKeys || [])
        ],
        sessionDecision: input.sessionDecision
      },
      (onProgress, onAssigned) => {
        let canonicalCwd: string;
        try {
          canonicalCwd = resolveAllowedCwd(input.cwd, input.config.allowedRoots);
        } catch {
          throw new Error(
            `${PROJECT_UNAVAILABLE}: The admitted project folder became unavailable before Codex started.`
          );
        }
        if (canonicalCwd !== input.cwd) {
          throw new Error(
            `${PROJECT_UNAVAILABLE}: The admitted project folder changed canonical identity before Codex started.`
          );
        }
        return input.run(onProgress, onAssigned);
      },
      input.onComplete
        ? (result, currentJob) => input.onComplete?.(result, agent, currentJob)
        : undefined,
      input.preferences.maxConcurrentJobs,
      input.rejectIfSelectionActive,
      input.onAssigned
        ? (assignment, currentJob) => input.onAssigned?.(assignment, agent, currentJob)
        : undefined,
      true
    );
    deferredAdmissionJobId = job.jobId;
    if (shouldSealOneJobCompletionActivity(input.activityRequest, activity)) {
      // A newly declared notify/sealed Activity represents one admitted
      // asynchronous Job. Seal it after the Job exists so terminal settlement
      // can atomically create the durable completion outbox record.
      input.jobs.sealActivity(activity.activityId);
    }
  });
  try {
    if (input.userSettings && input.projectRequest) {
      input.userSettings.admissionTransaction(admit);
    } else {
      admit();
    }
  } catch (error) {
    if (deferredAdmissionJobId) {
      input.jobs.discardDeferredAdmission(deferredAdmissionJobId);
    }
    throw error;
  }
  if (deferredAdmissionJobId) {
    input.jobs.activateDeferredExecution(deferredAdmissionJobId);
  }
  input.onAdmitted?.();
  return taskResultForJob(
    job,
    input.config.jobStaleAfterMs,
    input.preferences,
    input.jobs,
    replayedDuringAdmission
  );
}

function shouldSealOneJobCompletionActivity(
  request: ActivityTaskRequest,
  activity: BridgeActivity
): boolean {
  return (
    request.activityId === undefined &&
    request.continuationOfActivityId === undefined &&
    activity.handoffPolicy === "notify" &&
    activity.completionTrigger === "sealed-jobs-terminal"
  );
}

function resultForJob(
  job: CodexJob,
  staleAfterMs: number,
  preferences: BridgeUserSettings,
  jobs?: CodexJobRegistry,
  replay = true
): ToolResult {
  if (
    job.result &&
    (job.status === "completed" || (job.status === "failed" && job.result.isError))
  ) {
    return forwardResult(job.result, job, preferences, jobs, replay);
  }
  return taskResultForJob(job, staleAfterMs, preferences, jobs, replay);
}

type PageCursorKind = "sessions" | "jobs" | "activities";

type ActivityHistoryCursor = {
  scopeVersion: number;
  offset: number;
};

function encodeActivityHistoryCursor(scopeVersion: number, offset: number): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: "activity-history",
    scopeVersion,
    offset
  }), "utf8").toString("base64url");
}

function decodeActivityHistoryCursor(cursor: string): ActivityHistoryCursor {
  try {
    const value = parseBase64UrlJson(cursor, "Activity history pagination cursor");
    if (
      !isRecord(value) ||
      value.v !== 1 ||
      value.kind !== "activity-history" ||
      !Number.isSafeInteger(value.scopeVersion) ||
      (value.scopeVersion as number) < 0 ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0 ||
      (value.offset as number) > 1_000_000_000
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      scopeVersion: value.scopeVersion as number,
      offset: value.offset as number
    };
  } catch {
    throw new Error("Invalid Activity history pagination cursor.");
  }
}

function pageSummary(
  kind: PageCursorKind,
  offset: number,
  limit: number,
  returned: number,
  total: number
) {
  const nextOffset = offset + returned < total ? offset + returned : null;
  return {
    offset,
    limit,
    returned,
    total,
    hasMore: nextOffset !== null,
    nextOffset,
    nextCursor: nextOffset === null ? null : encodePageCursor(kind, nextOffset)
  };
}

function encodePageCursor(kind: PageCursorKind, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, offset }), "utf8").toString("base64url");
}

function decodePageCursor(cursor: string, expectedKind: PageCursorKind): number {
  try {
    const value = parseBase64UrlJson(cursor, `${expectedKind} pagination cursor`);
    if (
      !isRecord(value) ||
      value.v !== 1 ||
      value.kind !== expectedKind ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0 ||
      (value.offset as number) > 1_000_000_000
    ) {
      throw new Error("invalid cursor payload");
    }
    return value.offset as number;
  } catch {
    throw new Error(`Invalid or mismatched ${expectedKind} pagination cursor.`);
  }
}

function parseBase64UrlJson(value: string, field: string): unknown {
  return parseJsonUtf8Strict(Buffer.from(value, "base64url"), field);
}

type PublicSteeringValidation =
  | { ok: true; job: CodexJob }
  | {
      ok: false;
      code: (typeof steeringResultCodes)[number];
      job?: CodexJob;
      message: string;
    };

function validatePublicSteeringTarget(
  jobs: CodexJobRegistry,
  upstream: CodexUpstream,
  scopeId: string,
  jobId: string,
  expectedJobVersion: number
): PublicSteeringValidation {
  const job = jobs.get(jobId);
  if (!job || job.scopeId !== scopeId) {
    return {
      ok: false,
      code: "JOB_NOT_ACTIVE",
      message: "The exact Job does not exist or is no longer retained; no future Agent turn was queued."
    };
  }

  const activity = jobs.getActivity(job.activityId);
  const agent = job.agentId ? jobs.getAgent(job.agentId) : undefined;
  const assignment = job.agentId
    ? jobs.listActivityAgentAssignments(job.activityId, job.agentId)
        .find((candidate) => candidate.releasedAt === undefined)
    : undefined;
  if (
    !activity ||
    activity.scopeId !== scopeId ||
    !agent ||
    agent.scopeId !== scopeId
  ) {
    return {
      ok: false,
      code: "JOB_SCOPE_MISMATCH",
      message: "The Job, Activity, Agent, and current thread no longer form one exact scope-owned root."
    };
  }
  if (
    job.status !== "running" ||
    job.cancelRequestedAt !== undefined ||
    (agent.lifecycle !== "active" && agent.lifecycle !== "waiting-input") ||
    activity.lifecycle === "terminating" ||
    activity.lifecycle === "completed" ||
    activity.lifecycle === "cancelled" ||
    activity.lifecycle === "abandoned"
  ) {
    return {
      ok: false,
      code: "JOB_NOT_ACTIVE",
      job,
      message: "The exact Job no longer has a steerable active turn; no future Agent turn was queued."
    };
  }
  if (
    !assignment ||
    assignment.activityId !== activity.activityId ||
    assignment.agentId !== agent.agentId ||
    agent.currentJobId !== job.jobId
  ) {
    return {
      ok: false,
      code: "JOB_SCOPE_MISMATCH",
      message: "The active Job is not the current scope-owned Activity assignment for this Agent."
    };
  }
  if (job.version !== expectedJobVersion) {
    return {
      ok: false,
      code: "STALE_JOB_VERSION",
      job,
      message: `The Job version changed from ${expectedJobVersion} to ${job.version}; steering was not dispatched.`
    };
  }
  if (
    !backendSupports(job.backendKind, "supportsSteering") ||
    !job.threadId ||
    !upstream.steerThread ||
    !upstream.canSteerThread
  ) {
    return {
      ok: false,
      code: "STEERING_UNSUPPORTED",
      job,
      message: "Steering requires a bridge-verified active Codex App Server turn."
    };
  }
  const thread = jobs.listAgentThreads(agent.agentId)
    .find((candidate) => candidate.threadId === job.threadId);
  if (
    !thread ||
    thread.scopeId !== scopeId ||
    thread.agentId !== agent.agentId ||
    !backendSupports(thread.backendKind, "supportsSteering") ||
    !thread.isCurrent ||
    agent.currentThreadId !== job.threadId
  ) {
    return {
      ok: false,
      code: "JOB_SCOPE_MISMATCH",
      job,
      message: "The active App Server thread is not the current scope-owned root for this Agent."
    };
  }
  if (upstream.canSteerThread(job.threadId) !== true) {
    return {
      ok: false,
      code: "JOB_NOT_ACTIVE",
      job,
      message: "The App Server thread has no active turn to steer; no future turn was queued."
    };
  }
  return { ok: true, job };
}

function compactSteeringJob(
  job: CodexJob | undefined
): z.infer<typeof compactSteeringJobOutputSchema> | null {
  if (!job?.agentId) return null;
  return compactSteeringJobOutputSchema.parse({
    jobId: job.jobId,
    activityId: job.activityId,
    agentId: job.agentId,
    status: job.status,
    version: job.version
  });
}

function steeringSuccessResult(job: CodexJob): z.infer<typeof codexSteerOutputSchema> {
  return codexSteerOutputSchema.parse({
    kind: "mutation",
    ok: true,
    action: "steer",
    code: null,
    job: compactSteeringJob(job),
    promptPersistedByBridge: false,
    steeringScope: "active-codex-turn-only",
    delivery: { status: "delivered" },
    message: "Additional guidance was delivered to the exact active Codex turn without creating a new turn.",
    warnings: [],
    nextActions: []
  });
}

function steeringFailureResult(
  code: (typeof steeringResultCodes)[number],
  job?: CodexJob,
  message?: string
): z.infer<typeof codexSteerOutputSchema> {
  const defaults: Record<(typeof steeringResultCodes)[number], string> = {
    JOB_NOT_ACTIVE:
      "The exact Job has no active turn to steer; no future Agent turn was queued.",
    STALE_JOB_VERSION:
      "The Job version changed before dispatch; refresh exact Job status before deciding on another request.",
    STEERING_UNSUPPORTED:
      "The selected Job is not a bridge-verified active App Server turn and cannot be steered.",
    JOB_SCOPE_MISMATCH:
      "The selected Job is not the exact scope-owned Job root for this conversation.",
    DELIVERY_UNCERTAIN:
      "The bridge crossed the upstream dispatch boundary but could not durably confirm delivery; do not automatically resend.",
    STEERING_REQUEST_CONFLICT:
      "The requestId is already bound to a different Job, version, or prompt digest."
  };
  const nextActions: Record<(typeof steeringResultCodes)[number], string[]> = {
    JOB_NOT_ACTIVE: [
      "Read the exact Job with codex_status; if it is terminal and more work is needed, use codex_task with the existing Agent and context='continue'."
    ],
    STALE_JOB_VERSION: [
      "Refresh the exact Job with codex_status, then use a fresh requestId with the current Job version if steering is still necessary."
    ],
    STEERING_UNSUPPORTED: [
      "Let the current Job finish or use codex_task with the existing Agent and context='continue' for a later turn."
    ],
    JOB_SCOPE_MISMATCH: [
      "Use only an exact Job ID returned in the current ChatGPT conversation scope."
    ],
    DELIVERY_UNCERTAIN: [
      "Inspect the exact Job with codex_status and do not automatically retry this steering request."
    ],
    STEERING_REQUEST_CONFLICT: [
      "Generate a fresh requestId for any different steering payload."
    ]
  };
  return codexSteerOutputSchema.parse({
    kind: "mutation",
    ok: false,
    action: "steer",
    code,
    job: compactSteeringJob(job),
    promptPersistedByBridge: false,
    steeringScope: "active-codex-turn-only",
    delivery: { status: code === "DELIVERY_UNCERTAIN" ? "uncertain" : "not-delivered" },
    message: message || defaults[code],
    warnings: code === "DELIVERY_UNCERTAIN"
      ? ["The bridge does not claim distributed exactly-once delivery across this crash boundary."]
      : [],
    nextActions: nextActions[code].map(guidance)
  });
}

function formatJobStatus(
  job: CodexJob,
  staleAfterMs: number,
  wait?: CodexJobWaitResult,
  preferences?: BridgeUserSettings,
  registry?: CodexJobRegistry,
  replay = false
): Record<string, unknown> {
  const activity = formatJobActivity(job, staleAfterMs);
  const pendingTerminalCommit = registry?.pendingTerminalCommit(job);
  const dashboard = dashboardPresentationHint(job, preferences, registry);
  const active = isActiveActivityJobStatus(job.status);
  const terminal = isTerminalActivityJobStatus(job.status);
  const resultOmitted = job.resultOmitted || false;
  const resultAvailability = active
    ? "pending"
    : job.status === "completed"
      ? resultOmitted
        ? "omitted"
        : job.result
          ? "delivered"
          : "unavailable"
      : "unavailable";
  const delivery = active
    ? "status"
    : resultAvailability === "delivered"
      ? "primary-content"
      : resultAvailability === "omitted"
        ? "omitted"
        : "none";
  const retainedError = retainedStructuredError(job.result);
  const error = job.status === "failed" || job.status === "interrupted" || job.status === "cancelled"
    ? normalizeStructuredError(
        retainedError || {
          code: job.error?.startsWith("BRIDGE_TERMINAL_COMMIT_FAILED:")
            ? "BRIDGE_TERMINAL_COMMIT_FAILED"
            : job.status === "cancelled"
              ? "JOB_CANCELLED"
              : job.status === "interrupted"
                ? "JOB_INTERRUPTED"
                : "JOB_FAILED",
          message:
            job.error ||
            (job.status === "interrupted"
              ? "The Codex job was interrupted before completion."
              : job.status === "cancelled"
                ? "The Codex job was cancelled. Partial filesystem changes may remain."
                : "Codex job failed.")
        }
      )
    : undefined;
  const warnings = [
    ...(job.executionDecision?.fallbackWarning
      ? [job.executionDecision.fallbackWarning]
      : []),
    ...(activity.health === "no-progress-observed"
      ? ["No progress event has been observed within the configured window; process liveness is unknown."]
      : []),
    ...(activity.health === "liveness-unknown"
      ? ["The Bridge's last active Job record does not confirm that its original execution owner is currently reachable."]
      : []),
    ...(job.status === "cancelled"
      ? ["Cancellation does not roll back partial filesystem changes."]
      : [])
  ];
  const nextActions = active
    ? job.completionDeliveryPolicy === "direct-wait"
      ? [
          {
            tool: "codex_status",
            arguments: {
              query: {
                kind: "job",
                id: job.jobId,
                waitFor: "terminal",
                waitMs: MAX_CODEX_STATUS_WAIT_MS
              }
            },
            userPrompt:
              "Wait for this exact Job in bounded intervals. After any non-terminal return, inspect the supplied exact-Job input action before repeating this same wait. A timeout or aborted read never authorizes a replacement Job. Review the terminal result before continuing only work the user already approved."
          },
          {
            tool: "codex_status",
            arguments: {
              query: {
                kind: "input",
                jobId: job.jobId,
                waitMs: DEFAULT_CODEX_STATUS_WAIT_MS
              }
            },
            userPrompt:
              "If the Job requests input or approval, stop automatic continuation at that boundary and surface it to the user."
          }
        ]
      : [
          { tool: "codex_status", arguments: { query: { kind: "input", jobId: job.jobId, waitMs: DEFAULT_CODEX_STATUS_WAIT_MS } } },
          ...(dashboard.automatic
            ? [{
                tool: "codex_dashboard",
                arguments: {
                  scope: "conversation",
                  jobId: job.jobId,
                  presentationRef: dashboardPresentationRef(job)
                },
                userPrompt:
                  "Call this render tool before replying so the originating Dashboard is mounted."
              }]
            : [])
        ]
    : [];
  return {
    status: job.status,
    terminal,
    async: active,
    delivery,
    replay,
    jobId: job.jobId,
    activityId: job.activityId,
    agentId: job.agentId || null,
    contextMode: job.contextMode || null,
    backendKind: job.backendKind,
    ...(job.runtime ? { runtime: safeRuntimeMetadata(job.runtime) } : {}),
    threadId: job.threadId || job.sessionDecision.threadId || null,
    turnId: appServerTurnId(job) || null,
    versions: {
      job: job.version,
      activity: registry?.getActivity(job.activityId)?.version || null
    },
    operation: job.operation,
    projectName: job.projectName || null,
    sandbox: job.sandbox,
    completionDeliveryPolicy: job.completionDeliveryPolicy,
    executionAudit: formatExecutionAudit(job),
    scopeId: job.scopeId,
    requestId: job.requestId,
    ...(job.approvedFollowups?.length && registry
      ? { approvedFollowups: registry.admissionStateStore.taskFollowups.references(job) } : {}),
    bridgeSession: {
      ...job.sessionDecision,
      scopeId: job.scopeId,
      requestId: job.requestId,
      projectName: job.projectName || null
    },
    bridgeActivity: {
      activityId: job.activityId,
      jobId: job.jobId,
      agentId: job.agentId || null,
      projectName: job.projectName || null,
      dashboard
    },
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    cancelRequestedAt: job.cancelRequestedAt ? new Date(job.cancelRequestedAt).toISOString() : null,
    terminalOrigin: job.terminalOrigin || null,
    cancellation: formatCancellationAudit(job, registry),
    ...activity,
    ...(wait
      ? {
          wait: {
            waitFor: wait.waitFor,
            waitedMs: wait.waitedMs,
            timedOut: wait.waitTimedOut,
            changed: wait.changed
          }
        }
      : {}),
    result: {
      availability: resultAvailability,
      bytes: job.resultBytes ?? null,
      omitted: resultOmitted
    },
    ...(error ? { error } : {}),
    warnings,
    nextActions,
    message:
      active
        ? pendingTerminalCommit
          ? "The original execution owner reported a terminal result, but durable Job storage is still pending. Keep this exact Job and wait for its original result; do not start a replacement turn."
          : job.status === "terminating"
          ? "Codex is terminating; refresh authoritative status until it reaches a terminal state."
          : job.status === "termination-failed"
            ? "Codex termination is unconfirmed; refresh status and retry the explicit cancellation if needed."
            : job.trackingState === "liveness-unknown"
              ? "This Job's last committed state is active, but current execution-owner liveness is unconfirmed. Recover the same Job and original result; do not start a replacement turn from this observation."
            : job.completionDeliveryPolicy === "direct-wait"
              ? "Codex is running independently in experimental direct-result mode. Keep the current orchestration active with bounded terminal waits on this exact Job; a timeout or aborted read does not cancel it."
              : "Codex is running independently. Query this exact Job when needed, handle any pending input, and retrieve its terminal result before reporting completion."
        : job.status === "completed"
          ? resultOmitted
            ? "Codex completed, but the primary result exceeded the configured retention limit and was omitted."
            : "Codex completed; retrieve the exact Job result for its bounded model-authoritative answer."
          : error?.message || "Codex reached a terminal state."
  };
}

/** Exact status separates a committed Bridge record from owner and host evidence.
 * The result-offer fields describe earlier completed responses; the current
 * response is recorded only after its projection succeeds. */
function exactJobCompletionEvidence(job: CodexJob, registry: CodexJobRegistry) {
  const delivery = registry.admissionStateStore.getJobCompletionDelivery(job.jobId, job.scopeId);
  const terminal = isTerminalActivityJobStatus(job.status);
  const pendingTerminalCommit = registry.pendingTerminalCommit(job);
  const direct = delivery?.directResultOfferedAt !== undefined;
  const completion = delivery?.completionResultOfferedAt !== undefined;
  return {
    jobRecord: terminal
      ? "terminal-committed" as const
      : "active-last-known" as const,
    // A terminal receipt is durable even after its owner exits. The saved
    // trackingState is not a fresh liveness measurement of that old owner.
    ownerObservation: terminal || pendingTerminalCommit ? null : job.trackingState,
    ownerTerminalResult: pendingTerminalCommit ? {
      origin: pendingTerminalCommit.origin,
      observedAt: new Date(pendingTerminalCommit.observedAt).toISOString()
    } : null,
    terminalOrigin: job.terminalOrigin || null,
    deliveryRecord: delivery?.state || null,
    resultOffer: direct && completion ? "both" as const
      : direct ? "direct-query" as const
        : completion ? "completion-receipt" as const : "none" as const,
    activityLifecycle: registry.getActivity(job.activityId)?.lifecycle || null
  };
}

/**
 * Correlates the host's Dashboard tool input with its private tool result.
 * This digest is deliberately not an authorization credential: the render
 * handler still resolves host scope and verifies exact Job ownership.
 */
function dashboardPresentationRef(
  job: Pick<CodexJob, "jobId" | "scopeId">
): string {
  return createHash("sha256")
    .update("codex-dashboard-presentation-v1", "utf8")
    .update("\0", "utf8")
    .update(job.scopeId, "utf8")
    .update("\0", "utf8")
    .update(job.jobId, "utf8")
    .digest("hex");
}

function dashboardPresentationHint(
  job: Pick<CodexJob, "activityId" | "completionDeliveryPolicy">,
  _preferences?: BridgeUserSettings,
  registry?: CodexJobRegistry
) {
  void registry;
  const direct = job.completionDeliveryPolicy === "direct-wait";
  return {
    statusTool: "codex_status",
    openTool: "codex_dashboard",
    scope: "conversation",
    automatic: !direct,
    reason: direct ? "experimental-direct-wait" as const : "default" as const,
    completionDeliveryRoute: direct ? "direct-wait" as const : "live-card" as const
  };
}

function formatJobSummary(job: CodexJob, staleAfterMs: number): Record<string, unknown> {
  return {
    jobId: job.jobId,
    activityId: job.activityId,
    agentId: job.agentId || null,
    contextMode: job.contextMode || null,
    status: job.status,
    backendKind: job.backendKind,
    threadId: job.threadId || job.sessionDecision.threadId || null,
    turnId: appServerTurnId(job) || null,
    operation: job.operation,
    projectName: job.projectName || null,
    workspaceLabel: job.projectName || "Pinned workspace",
    sandbox: job.sandbox,
    completionDeliveryPolicy: job.completionDeliveryPolicy,
    executionDecision: job.executionDecision || null,
    executionAudit: formatExecutionAudit(job),
    upstreamError: retainedStructuredError(job.result) || null,
    scopeId: job.scopeId,
    requestId: job.requestId,
    session: job.sessionDecision,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    version: job.version,
    terminal: isTerminalActivityJobStatus(job.status),
    terminalOrigin: job.terminalOrigin || null,
    cancellationIntentId: job.cancellationIntentId || null,
    ...formatJobActivity(job, staleAfterMs),
    resultBytes: job.resultBytes,
    resultOmitted: job.resultOmitted || false,
    ...(job.status === "failed" || job.status === "interrupted" || job.status === "cancelled"
      ? { error: job.error }
      : {})
  };
}

function formatCancellationAudit(
  job: CodexJob,
  registry?: CodexJobRegistry
): Record<string, unknown> | null {
  if (!job.cancellationIntentId) return null;
  const intent = registry?.getCancellationIntent(job.cancellationIntentId);
  if (!intent) {
    return {
      intentId: job.cancellationIntentId,
      durableDetailsAvailable: false
    };
  }
  const operation = registry?.getCancellationOperation(intent.scopeId, intent.requestId);
  return {
    intentId: intent.intentId,
    logicalRequestId: intent.requestId,
    source: intent.source,
    tool: intent.toolName,
    action: intent.actionName,
    reasonCode: intent.reasonCode,
    reason: operation?.reason
      ? redactSensitiveText(operation.reason).slice(0, CANCELLATION_REASON_MAX_LENGTH)
      : null,
    status: intent.status,
    expectedVersion: intent.expectedVersion,
    parentIntentId: intent.parentIntentId || null,
    cascadeId: intent.cascadeId,
    callerPresentation: intent.callerPresentation || null,
    target: {
      kind: intent.targetKind,
      jobId: intent.targetJobId || null,
      activityId: intent.targetActivityId,
      agentId: intent.targetAgentId || null,
      threadId: intent.targetThreadId || null,
      turnId: intent.targetTurnId || null,
      presentationId: intent.targetPresentationId || null
    },
    widgetProof: intent.widgetInstancePresent
      ? { present: true, cardGeneration: intent.cardGeneration || null }
      : { present: false },
    callerRequestDigest: intent.callerRequestDigest || null,
    bridgeInstanceId: intent.bridgeInstanceId,
    createdAt: new Date(intent.createdAt).toISOString(),
    dispatchedAt: intent.dispatchedAt ? new Date(intent.dispatchedAt).toISOString() : null,
    completedAt: intent.completedAt ? new Date(intent.completedAt).toISOString() : null,
    durableDetailsAvailable: true
  };
}

function formatActivitySummary(activity: BridgeActivity): Record<string, unknown> {
  return {
    activityId: activity.activityId,
    scopeId: activity.scopeId,
    projectName: activity.projectName || null,
    continuationOfActivityId: activity.continuationOfActivityId || null,
    cardGeneration: activity.cardGeneration,
    title: activity.title,
    kind: activity.kind,
    handoffPolicy: activity.handoffPolicy,
    completionTrigger: activity.completionTrigger,
    lifecycle: activity.lifecycle,
    waitingOn: activity.waitingOn,
    verification: activity.verification,
    version: activity.version,
    completionVersion: activity.completionVersion,
    legacy: activity.legacy,
    counts: activity.counts,
    createdAt: new Date(activity.createdAt).toISOString(),
    updatedAt: new Date(activity.updatedAt).toISOString(),
    sealedAt: activity.sealedAt ? new Date(activity.sealedAt).toISOString() : null,
    completedAt: activity.completedAt ? new Date(activity.completedAt).toISOString() : null
  };
}

function formatExecutionAudit(job: CodexJob): Record<string, unknown> | null {
  const decision = job.executionDecision;
  if (!decision) return null;
  const acceptedTurn = [...job.publicEvents].reverse().find((event) =>
    event.type === "turn" &&
    event.phase === "started" &&
    event.details?.evidence === "turn/start-accepted"
  );
  const reroute = [...job.publicEvents].reverse().find((event) =>
    event.type === "model" &&
    event.details?.kind === "rerouted" &&
    typeof event.details.toModel === "string"
  );
  const reroutedModel = typeof reroute?.details?.toModel === "string"
    ? reroute.details.toModel
    : undefined;
  const acceptedSelection = isRecord(acceptedTurn?.details?.selection)
    ? acceptedTurn.details.selection
    : undefined;
  const acceptedModel = typeof acceptedSelection?.model === "string"
    ? acceptedSelection.model
    : decision.effectiveSelection.model;
  const acceptedEffort = typeof acceptedSelection?.reasoningEffort === "string"
    ? acceptedSelection.reasoningEffort
    : decision.effectiveSelection.reasoningEffort;
  const acceptedServiceTier = typeof acceptedSelection?.serviceTier === "string"
    ? acceptedSelection.serviceTier
    : decision.effectiveSelection.serviceTier;
  return {
    requested: decision.requestedSelection || null,
    actual: {
      model: reroutedModel || acceptedModel,
      reasoningEffort: acceptedEffort,
      ...(acceptedServiceTier ? { serviceTier: acceptedServiceTier } : {})
    },
    source: decision.source,
    evidence: reroutedModel
      ? "model/rerouted"
      : acceptedTurn
        ? "turn/start-accepted"
        : "bridge-dispatch",
    ...(reroute
      ? {
          reroute: {
            fromModel: typeof reroute.details?.fromModel === "string"
              ? reroute.details.fromModel
              : acceptedModel,
            toModel: reroutedModel,
            reason: typeof reroute.details?.reason === "string"
              ? reroute.details.reason
              : "unspecified"
          }
        }
      : {})
  };
}

function formatSessionSummary(session: TrackedCodexSession): Record<string, unknown> {
  const updatedAt = session.updatedAt ?? session.lastUsedAt;
  return {
    threadId: session.threadId,
    sessionId: session.sessionId || null,
    forkedFromThreadId: session.forkedFromThreadId || null,
    scopeId: session.scopeId,
    projectName: session.projectName || null,
    sandbox: session.sandbox,
    selection: session.selection,
    policyRevision: session.policyRevision,
    backendKind: session.backendKind,
    updatedAt: new Date(updatedAt).toISOString(),
    createdAt: new Date(session.createdAt).toISOString(),
    lastUsedAt: new Date(session.lastUsedAt).toISOString()
  };
}

function formatAgentThreadSummary(
  thread: BridgeAgentThread | undefined
): Record<string, unknown> | null {
  if (!thread) return null;
  return {
    threadId: thread.threadId,
    sessionId: thread.sessionId || null,
    agentId: thread.agentId,
    scopeId: thread.scopeId,
    projectName: thread.projectName || null,
    backendKind: thread.backendKind,
    sandbox: thread.sandbox,
    contextMode: thread.contextMode,
    isCurrent: thread.isCurrent,
    linkedAt: new Date(thread.linkedAt).toISOString(),
    replacedAt: thread.replacedAt ? new Date(thread.replacedAt).toISOString() : null,
    forkedFromThreadId: thread.forkedFromThreadId || null
  };
}

function formatAgentSummary(agent: BridgeAgent, jobs: CodexJobRegistry): Record<string, unknown> {
  const assignments = jobs.listActivityAgentAssignments(undefined, agent.agentId);
  const threads = jobs.listAgentThreads(agent.agentId);
  return {
    agentId: agent.agentId,
    agentName: agent.agentName,
    lifecycle: agent.lifecycle,
    version: agent.version,
    currentJobId: agent.currentJobId || null,
    hasCurrentThread: Boolean(agent.currentThreadId),
    threadHistoryCount: threads.length,
    activeActivityIds: assignments
      .filter((assignment) => assignment.releasedAt === undefined)
      .map((assignment) => assignment.activityId),
    assignmentHistoryCount: assignments.length,
    orphanedReason: agent.orphanedReason || null,
    createdAt: new Date(agent.createdAt).toISOString(),
    updatedAt: new Date(agent.updatedAt).toISOString()
  };
}

type DashboardStatus = (typeof DASHBOARD_STATUSES)[number];
type DashboardTurn = z.infer<typeof dashboardTurnOutputSchema>;
type DashboardRow = z.infer<typeof dashboardRowOutputSchema>;
type DashboardPage = z.infer<typeof dashboardPageOutputSchema>;
export type DashboardView = z.infer<typeof dashboardViewOutputSchema>;
export type DashboardHistoryDetail = z.infer<typeof dashboardHistoryDetailOutputSchema>;

export type BridgeDashboardSnapshotOptions = {
  problems?: ProblemQuery;
  statusFilter?: DashboardStatusFilter;
  /** Internal resolved conversation filter. Native and retained clients omit it. */
  scopeId?: string;
  limit?: number;
  terminalOffset?: number;
  idleOffset?: number;
  inspectRuntime?: boolean;
  includeHistory?: boolean;
};

export type BridgeDashboardHistoryDetailOptions = {
  rowKey: string;
  /** Internal resolved conversation filter. Native and retained clients omit it. */
  scopeId?: string;
};

export type BridgeSettingsSnapshotOptions = {
  refreshModels?: boolean;
};

export type BridgeSettingsPatchInput = {
  accessStrategy?: AccessStrategy;
  modelPolicy?: ModelPolicy;
  modelDescriptionOverrides?: ModelDescriptionOverrides;
  usePriorityServiceTier?: boolean;
  historyRetentionDays?: HistoryRetentionDays;
  uiLocalePreference?: UiLocalePreference;
  maxConcurrentJobs?: number;
  showBridgeThreadsInCodexApp?: boolean;
  experimentalDirectResultDelivery?: boolean;
  projectOperations?: ProjectRegistryOperation[];
};

export type BridgeSettingsMutationInput = {
  expectedSettingsRevision?: number;
  expectedRegistryRevision?: number;
  operation:
    | { kind: "reset" }
    | { kind: "patch"; settings: BridgeSettingsPatchInput };
};

export type BridgeStorageAdmissionError =
  | "busy"
  | "full"
  | "io"
  | "corrupt"
  | "read-only";

export type BridgeRuntimeAdmissionSnapshot = {
  authConnection?: { source: "shared" | "bridge-chatgpt" | "bridge-api" | "disconnected";
    mode: "chatgpt" | "api-key" | "unknown"; observedAt: number | null };
  acceptingNewJobs: boolean;
  activeJobs: number;
  pendingAdmissions: number;
  pendingInteractions?: number;
  memoryOnlyThreads?: number;
  protectedMemoryOnlyThreads?: number;
  discardableMemoryOnlyThreads?: number;
  backgroundProcessState: "confirmed" | "unknown";
  backgroundProcesses: number;
  backgroundProcessAgents: number;
  backgroundProcessUnknownAgents: number;
  /** Memory-only supervisor observation; never a DB-derived claim. */
  stateService?: {
    status:
      | "ready"
      | "state-starting"
      | "state-stale"
      | "state-recovering"
      | "state-incompatible"
      | "state-capacity"
      | "admission-draining";
    generation?: string;
    heartbeatAgeMs?: number;
    activeOperation?: OperationalStateOperationObservation;
    lastCommitAt?: number;
    storageError?: BridgeStorageAdmissionError;
    storageErrorObservedAt?: number;
  };
  /** Read-only projection worker; a degraded value does not imply write loss. */
  readService?: {
    status: "ready" | "read-starting" | "read-stale" | "read-recovering" | "read-capacity";
    generation?: string;
    heartbeatAgeMs?: number;
    inFlight: number;
    capacity: number;
    lastSnapshotAt?: number;
    activeOperation?: {
      method: "dashboardSnapshot" | "dashboardHistoryDetail" | "settingsSnapshot";
      phase: "queue-wait" | "read-snapshot" | "serializing" | "responding";
      startedAt: number;
      observedAt: number;
    };
  };
  /** Best-effort diagnostics only; degradation never changes operational truth. */
  telemetryService?: {
    status: "ready" | "recovering" | "stale" | "memory-only";
    queued: number;
    inFlight: number;
    retained: number;
    dropped: number;
    failed: number;
    lastPersistedAt?: number;
  };
  /** Codex work executor; it has no SQLite connection or state authority. */
  executionService?: {
    journal?: import("./executionJournal.js").ExecutionJournalStatus;
    pendingAcknowledgements?: number;
    observationStatus?: "ready" | "degraded";
    connectionStatus?: "connected" | "disconnected";
    heartbeatStatus?: "fresh" | "delayed";
    status: "idle" | "starting" | "ready" | "stale" | "recovering" | "capacity";
    generation?: string;
    heartbeatAgeMs?: number;
    inFlight: number;
    capacity: number;
    supervisedWorkers?: number;
    supervisedProcesses?: number;
  };
  /** Bounded project-fair persistence for disposable progress projections. */
  progressPersistence?: ProgressPersistenceStatus;
};

export type BridgeRuntimeSnapshotOptions = {
  inspectBackgroundProcesses?: boolean;
};

export type BridgeNativeCompletionNotificationClaim = {
  leaseOwner: string;
  limit?: number;
};

export type BridgeNativeCompletionNotificationMutation = {
  leaseOwner: string;
  outboxIds: number[];
};

/**
 * Native companion and MCP card adapters share this application boundary.
 * It contains no mounted-widget authority and never exposes the SQLite store.
 */
export type BridgeApplicationService = {
  problemAction?(input: ProblemAction, scopeId?: string, source?: "operator" | "widget-control"): Promise<ProblemActionResult>;
  historyAction?(input: DashboardHistoryActionInput): Promise<{ok: true}>;
  threadHandoff?(input: { rowKey: string; codexThreadUrl: string; action: "request" | "cancel" | "status" }): Promise<{ phase: string; reason?: string; requested: boolean; canOpen: boolean }>;
  subscribeChanges?(listener: (topic: "dashboard" | "settings" | "enrichment") => void): () => void;
  dashboardSnapshot(options?: BridgeDashboardSnapshotOptions): Promise<DashboardView>;
  dashboardHistoryDetail?(options: BridgeDashboardHistoryDetailOptions): Promise<DashboardHistoryDetail>;
  /** Internal read-worker planning boundary; never registered as an MCP/native method. */
  dashboardRuntimePlan?(options?: BridgeDashboardSnapshotOptions): Promise<BridgeDashboardRuntimePlan>;
  /** Internal read-worker render boundary; enrichment contains no database authority. */
  dashboardSnapshotWithEnrichment?(
    options: BridgeDashboardSnapshotOptions,
    enrichment: BridgeDashboardEnrichment
  ): Promise<DashboardView>;
  settingsSnapshot(options?: BridgeSettingsSnapshotOptions): Promise<SettingsView>;
  modelDescriptionHistory(input: { modelId: string; beforeVersion?: number }): Promise<ModelDescriptionHistoryPage>;
  updateSettings(input: BridgeSettingsMutationInput): Promise<SettingsView>;
  runtimeSnapshot(options?: BridgeRuntimeSnapshotOptions): Promise<BridgeRuntimeAdmissionSnapshot>;
  runtimeHealth?(): BridgeRuntimeAdmissionSnapshot;
  beginDrain(options?: BridgeRuntimeSnapshotOptions): Promise<BridgeRuntimeAdmissionSnapshot>;
  cancelDrain(): Promise<BridgeRuntimeAdmissionSnapshot>;
  /** Internal runtime gate; never registered as an MCP or native RPC method. */
  setStorageAdmissionError?(error?: BridgeStorageAdmissionError): void;
  /** Internal resource fence/observation, never registered as MCP/native RPC. */
  pinNonforcingShutdown?(): true;
  observeNonforcingExit?(): ShutdownResult;
  /** Local native app only: opaque completion events, never task content. */
  claimNativeCompletionNotifications?(input: BridgeNativeCompletionNotificationClaim): Promise<NativeCompletionNotification[]>;
  markNativeCompletionNotificationsDelivered?(input: BridgeNativeCompletionNotificationMutation): Promise<void>;
  releaseNativeCompletionNotifications?(input: BridgeNativeCompletionNotificationMutation): Promise<void>;
  /** Native app access to the same bridge-owned, versioned source as MCP. */
  skillLibrarySnapshot?(): Promise<SkillSearchResult>;
  readBridgeSkill?(reference: SkillReference): Promise<BridgeSkill>;
  readBridgeSkillFile?(reference: SkillReference, path: string): Promise<SkillFile>;
  listBridgeSkillVersions?(input: { skillId: string }): Promise<SkillVersionList>;
  createBridgeSkill?(input: CreateBridgeSkillInput): Promise<SkillSummary>;
  createBridgeSkillFromPackage?(input: CreateBridgeSkillPackageInput): Promise<SkillSummary>;
  updateBridgeSkill?(input: UpdateBridgeSkillInput): Promise<SkillSummary>;
  updateBridgeSkillFromPackage?(input: UpdateBridgeSkillPackageInput): Promise<SkillSummary>;
  restoreBridgeSkill?(input: RestoreBridgeSkillInput): Promise<SkillSummary>;
  setBridgeSkillEnabled?(input: SetBridgeSkillEnabledInput): Promise<SkillSummary>;
  deleteBridgeSkill?(input: DeleteBridgeSkillInput): Promise<DeletedBridgeSkill>;
  beginBridgeSkillPackageUpload?(): Promise<{ uploadId: string; expiresAt: string; chunkMaxBytes: number }>;
  appendBridgeSkillPackageUpload?(input: { uploadId: string; chunkIndex: number; data: string }): Promise<{ receivedBytes: number; nextChunk: number }>;
  inspectBridgeSkillPackageUpload?(uploadId: string): Promise<import("./skillPackage.js").BridgeSkillPackageInspection>;
  exportBridgeSkillPackage?(reference: SkillReference): Promise<{
    fileName: string; mediaType: "application/zip"; bytes: number; contentDigest: string; data: string;
  }>;
};
export type BridgeReadProjectionService = Pick<
  BridgeApplicationService,
  "dashboardSnapshot" | "settingsSnapshot"
> & Required<Pick<
  BridgeApplicationService,
  "dashboardHistoryDetail" | "dashboardRuntimePlan" | "dashboardSnapshotWithEnrichment"
>>;
type CodexWeeklyUsageView = z.infer<typeof codexWeeklyUsageOutputSchema>;
type CancellationDisplay = z.infer<typeof cancellationDisplayOutputSchema>;

const CANCELLATION_CARD_OPERATION_LIMIT = 100;
const CANCELLATION_REASONS_PER_ACTIVITY_LIMIT = 20;

function buildCancellationDisplayIndex(
  jobs: CodexJobRegistry,
  scopeId?: string
): {
  byJobId: Map<string, CancellationDisplay>;
  byActivityId: Map<string, CancellationDisplay[]>;
} {
  const operations = jobs
    .listCancellationOperations(scopeId)
    .filter((operation) => operation.source === "model-tool" && Boolean(operation.reason))
    .slice(-CANCELLATION_CARD_OPERATION_LIMIT);
  const intents = jobs.listCancellationIntents(scopeId ? { scopeId } : {});
  const intentById = new Map(intents.map((intent) => [intent.intentId, intent]));
  const operationByKey = new Map(
    operations.map((operation) => [
      `${operation.scopeId}\0${operation.requestId}`,
      operation
    ])
  );
  const displayByOperationKey = new Map<string, CancellationDisplay>();

  for (const operation of operations) {
    if (!operation.reason) continue;
    const rootIntent = intentById.get(operation.rootIntentId);
    const targetAgentId = operation.targetAgentId || rootIntent?.targetAgentId;
    const targetAgent = operation.targetKind === "job" && targetAgentId
      ? jobs.getAgent(targetAgentId)
      : undefined;
    const status: CancellationDisplay["status"] = rootIntent
      ? rootIntent.status === "failed"
        ? "failed"
        : rootIntent.status === "succeeded" || rootIntent.status === "no-op"
          ? "succeeded"
          : "requested"
      : operation.status === "failed"
        ? "failed"
        : operation.status === "completed"
          ? "succeeded"
          : "requested";
    const reason = redactSensitiveText(operation.reason).slice(
      0,
      CANCELLATION_REASON_MAX_LENGTH
    ).trim();
    if (!reason) continue;
    displayByOperationKey.set(
      `${operation.scopeId}\0${operation.requestId}`,
      cancellationDisplayOutputSchema.parse({
        targetKind: operation.targetKind,
        ...(targetAgent?.agentName ? { agentName: targetAgent.agentName } : {}),
        status,
        reason,
        requestedAt: new Date(operation.createdAt).toISOString()
      })
    );
  }

  const byJobId = new Map<string, CancellationDisplay>();
  for (const intent of intents) {
    if (!intent.targetJobId) continue;
    const operationKey = `${intent.scopeId}\0${intent.requestId}`;
    if (!operationByKey.has(operationKey)) continue;
    const display = displayByOperationKey.get(operationKey);
    if (!display) continue;
    const current = byJobId.get(intent.targetJobId);
    if (!current || Date.parse(display.requestedAt) >= Date.parse(current.requestedAt)) {
      byJobId.set(intent.targetJobId, display);
    }
  }

  const byActivityId = new Map<string, CancellationDisplay[]>();
  for (const operation of operations) {
    const display = displayByOperationKey.get(`${operation.scopeId}\0${operation.requestId}`);
    if (!display) continue;
    const entries = byActivityId.get(operation.targetActivityId) || [];
    entries.push(display);
    byActivityId.set(operation.targetActivityId, entries);
  }
  for (const [activityId, entries] of byActivityId) {
    entries.sort((left, right) => Date.parse(right.requestedAt) - Date.parse(left.requestedAt));
    byActivityId.set(
      activityId,
      entries.slice(0, CANCELLATION_REASONS_PER_ACTIVITY_LIMIT)
    );
  }

  return { byJobId, byActivityId };
}

function projectCodexWeeklyUsage(usage: CodexWeeklyUsage): CodexWeeklyUsageView {
  return codexWeeklyUsageOutputSchema.parse({
    source: "codex-account-rate-limits",
    limitId: usage.limitId,
    usedPercent: usage.usedPercent,
    remainingPercent: usage.remainingPercent,
    windowDurationMins: usage.windowDurationMins,
    resetsAt: usage.resetsAt === null
      ? null
      : new Date(usage.resetsAt * 1_000).toISOString(),
    observedAt: new Date(usage.observedAt).toISOString()
  });
}

async function readCodexWeeklyUsage(
  upstream: CodexUpstream
): Promise<CardUsageResult> {
  if (!upstream.readAccountRateLimits) return { value: null, failed: false };
  try {
    const usage = await upstream.readAccountRateLimits();
    return { value: usage ? projectCodexWeeklyUsage(usage) : null, failed: false };
  } catch {
    return { value: null, failed: true };
  }
}

type CardUsageCacheEntry = {
  revision?: string;
  freshUntil: number;
  retainUntil: number;
  value: CodexWeeklyUsageView;
};

const cardUsageCaches = new WeakMap<CodexUpstream, CardUsageCacheEntry>();
type CardUsageResult = { value: CodexWeeklyUsageView | null; failed: boolean };
const cardUsageReads = new WeakMap<CodexUpstream, DisplayReadPool<CardUsageResult>>();
const cardUsageCompletions = new WeakMap<CodexUpstream, { revision?: string; until: number; failed: boolean }>();
const cardObservationListeners = new WeakMap<CodexUpstream, Set<() => void>>();

function subscribeCardObservations(upstream: CodexUpstream, listener: () => void): () => void {
  const listeners = cardObservationListeners.get(upstream) || new Set<() => void>();
  cardObservationListeners.set(upstream, listeners);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyCardObservation(upstream: CodexUpstream): void {
  for (const listener of cardObservationListeners.get(upstream) || []) listener();
}

function cachedCodexWeeklyUsage(
  upstream: CodexUpstream,
  freshOnly = false
): CodexWeeklyUsageView | null {
  const cached = cardUsageCaches.get(upstream);
  if (!cached || cached.revision !== upstream.accountRevision?.()) return null;
  const now = Date.now();
  if (cached.retainUntil <= now) {
    cardUsageCaches.delete(upstream);
    return null;
  }
  if (freshOnly && cached.freshUntil <= now) return null;
  return cached.value;
}

async function readCodexWeeklyUsageBounded(
  upstream: CodexUpstream
): Promise<{ value: CodexWeeklyUsageView | null; timedOut: boolean; failed: boolean }> {
  const revision = upstream.accountRevision?.();
  const fresh = cachedCodexWeeklyUsage(upstream, true);
  if (fresh) return { value: fresh, timedOut: false, failed: false };
  const fallback = cachedCodexWeeklyUsage(upstream);
  const completion = cardUsageCompletions.get(upstream);
  if (completion && completion.revision === revision && completion.until > Date.now()) {
    return { value: fallback, timedOut: false, failed: completion.failed };
  }
  const pool = cardUsageReads.get(upstream) || new DisplayReadPool<CardUsageResult>(1, () => notifyCardObservation(upstream));
  cardUsageReads.set(upstream, pool);
  const key = revision || "default";
  pool.invalidate(existing => existing !== key);
  const request = pool.start(key, () => readCodexWeeklyUsage(upstream), ({ value, failed }, deferred) => {
    if (revision !== upstream.accountRevision?.()) return;
    if (value) {
      const now = Date.now();
      cardUsageCaches.set(upstream, {
        revision,
        freshUntil: now + CARD_USAGE_CACHE_TTL_MS,
        retainUntil: now + CARD_USAGE_STALE_TTL_MS,
        value
      });
      cardUsageCompletions.delete(upstream);
    }
    if (!value) cardUsageCompletions.set(upstream, { revision, until: Date.now() + CARD_RUNTIME_CACHE_TTL_MS, failed });
    if (deferred) notifyCardObservation(upstream);
  });
  if (!request) return { value: fallback, timedOut: true, failed: false };
  const result = await waitForDisplay(request, CARD_USAGE_TIMEOUT_MS);
  if (revision !== upstream.accountRevision?.()) return { value: null, timedOut: false, failed: false };
  return result.pending
    ? { value: fallback, timedOut: true, failed: false }
    : { value: result.value.value || fallback, timedOut: false, failed: result.value.failed };
}

export type DashboardRuntimeObservation = {
  state: "confirmed" | "idle" | "not-loaded" | "busy" | "orphaned" | "unknown";
  backgroundProcessState: "confirmed" | "unknown";
  backgroundProcessCount: number;
  backgroundProcessIds?: string[];
};

type CardEnrichmentSummary = z.infer<typeof cardEnrichmentOutputSchema>;

type DashboardEnrichmentInput = {
  runtimeByAgent: Map<string, DashboardRuntimeObservation>;
  runtimeProbeSkippedAgents: number;
  weeklyUsage: CodexWeeklyUsageView | null;
  summary: CardEnrichmentSummary;
};

type DashboardRuntimeCacheEntry = {
  stamp: string;
  coverage: "background" | "liveness";
  freshUntil: number;
  livenessFreshUntil?: number;
  retainUntil: number;
  observation: DashboardRuntimeObservation;
  inspectedObservation: DashboardRuntimeObservation;
  unavailable?: boolean;
  observedAt: number;
  attemptedAt: number;
};

export type DashboardRuntimeCandidate = {
  agentId: string;
  thread: BridgeAgentThread;
  stamp: string;
  inspectLiveness: boolean;
};

export type BridgeDashboardRuntimePlan = {
  candidates: DashboardRuntimeCandidate[];
};

export type BridgeDashboardEnrichment = {
  runtimeByAgent: Array<[string, DashboardRuntimeObservation]>;
  runtimeProbeSkippedAgents: number;
  weeklyUsage: CodexWeeklyUsageView | null;
  summary: CardEnrichmentSummary;
};

type BridgeBackgroundProcessImpact = {
  state: "confirmed" | "unknown";
  processes: number;
  agents: number;
  unknownAgents: number;
};

const DASHBOARD_RUNTIME_PROBE_LIMIT = 100;
const DASHBOARD_RUNTIME_PROBE_CONCURRENCY = 8;
const DASHBOARD_RUNTIME_PROBE_TIMEOUT_MS = 1_500;
const DASHBOARD_RUNTIME_BUDGET_MS = 9_000;
const CARD_RUNTIME_PROBE_LIMIT = 200;
const CARD_RUNTIME_PROBE_CONCURRENCY = 8;
const CARD_RUNTIME_PROBE_TIMEOUT_MS = 1_500;
const CARD_RUNTIME_BUDGET_MS = 6_000;
const CARD_USAGE_TIMEOUT_MS = 1_500;
const CARD_RUNTIME_CACHE_TTL_MS = 5_000;
const CARD_RUNTIME_STALE_TTL_MS = 15 * 60_000;
const CARD_USAGE_CACHE_TTL_MS = 60_000;
const CARD_USAGE_STALE_TTL_MS = 30 * 60_000;
const CARD_RUNTIME_CACHE_MAX_ENTRIES = 512;
const DASHBOARD_HISTORY_LIMIT_PER_AGENT = 12;
const dashboardRuntimeCaches = new WeakMap<
  CodexUpstream,
  Map<string, DashboardRuntimeCacheEntry>
>();

function invalidateCardRuntimeCache(upstream: CodexUpstream, threadId: string): void {
  dashboardRuntimeReads.get(upstream)?.invalidate(key => key.includes(`\0${threadId}\0`));
  const cache = dashboardRuntimeCaches.get(upstream);
  if (!cache) return;
  for (const key of cache.keys()) {
    if (key.endsWith(`\0${threadId}`)) cache.delete(key);
  }
}

const DASHBOARD_ATTENTION_STATUSES = new Set<DashboardStatus>([
  "input-required",
  "approval-required",
  "termination-failed",
  "liveness-unknown",
  "failed",
  "interrupted",
  "orphaned"
]);

function dashboardSessionAlias(scopeId: string): string {
  const digest = createHash("sha256")
    .update("codex-dashboard/session-alias/v1")
    .update("\0")
    .update(scopeId)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `Session ${digest}`;
}

function dashboardCodexThreadUrl(
  visibleInCodexApp: boolean,
  ...sources: Array<{
    threadId: string;
    sessionId?: string;
    backendKind: string;
  } | undefined>
): string | undefined {
  if (!visibleInCodexApp) return undefined;
  for (const source of sources) {
    if (!source || !backendSupports(source.backendKind, "supportsThreadInspection")) continue;
    const threadId = source.threadId.trim().toLowerCase();
    const sessionId = source.sessionId?.trim().toLowerCase();
    // Codex deep links address an exact thread. Normal App Server threads use
    // the same UUID for threadId and sessionId; forks may retain the source
    // session-tree id, so prefer the exact thread UUID when both are present.
    const routeId = SCOPE_ID_PATTERN.test(threadId)
      ? threadId
      : sessionId && SCOPE_ID_PATTERN.test(sessionId)
        ? sessionId
        : undefined;
    if (routeId) return `codex://threads/${routeId}`;
  }
  return undefined;
}

function dashboardConversationKey(scopeId: string): string {
  return createHash("sha256")
    .update("codex-dashboard/conversation-key/v1")
    .update("\0")
    .update(scopeId)
    .digest("hex")
    .slice(0, 32);
}

function dashboardActivityKey(
  activityId: string | undefined,
  fallbackIdentity: string
): string {
  return createHash("sha256")
    .update("codex-dashboard/activity-key/v1")
    .update("\0")
    .update(activityId ? `activity:${activityId}` : `fallback:${fallbackIdentity}`)
    .digest("hex")
    .slice(0, 32);
}

function dashboardJobTokenUsage(
  jobId: string,
  summaries: ReadonlyMap<string, Record<string, unknown>>
): { tokenUsage?: z.infer<typeof dashboardTokenUsageOutputSchema> } {
  const usage = summaries.get(jobId)?.usage;
  const tokens = isRecord(usage) && usage.basis === "cumulative-difference" ? usage.tokens : undefined;
  const parsed = dashboardTokenUsageOutputSchema.safeParse(tokens);
  return parsed.success ? { tokenUsage: parsed.data } : {};
}

function dashboardRowKey(agentId: string | undefined, jobId?: string): string {
  return createHash("sha256")
    .update("codex-dashboard/row-key/v1")
    .update("\0")
    .update(agentId ? `agent:${agentId}` : `job:${jobId || "unknown"}`)
    .digest("hex")
    .slice(0, 32);
}

function dashboardHistoryRevision(agent: Pick<BridgeAgent, "agentId" | "version">,
  job?: {jobId:string;status:string;updatedAt:number}): string {
  return createHash("sha256").update(JSON.stringify([agent.agentId,agent.version,
    job?.jobId || null,job?.status || null,job?.updatedAt || null])).digest("hex");
}

function dashboardRuntimeProblemIdentity(jobs: CodexJobRegistry, agent: BridgeAgent) {
  const job = agent.currentJobId ? jobs.get(agent.currentJobId) : undefined;
  const latest = jobs.admissionStateStore.workHistory.latestJob(agent.agentId);
  const affected = job?.status === "termination-failed" ? jobs.terminationImpact(job.jobId).affectedJobIds.slice().sort() : [];
  return { revision:problemRevision(["runtime",agent.agentId,agent.version,agent.currentJobId || null,
    latest?.jobId,latest?.status,latest?.updatedAt,job?.version,affected.map(id => [id,jobs.get(id)?.version])]),
    stopImpact:affected.length > 0 && affected.length <= 100 ? {
      affectedJobIds:affected,
      agentNames:affected.map(id => {const item=jobs.get(id);return item?.agentId ? jobs.getAgent(item.agentId)?.agentName || "" : "";})
    } : undefined };
}

function dashboardProjectKey(
  projectId: string | undefined,
  projectName: string | null | undefined
): string {
  const identity = projectId
    ? `id:${projectId}`
    : projectName
      ? `name:${projectNameKey(projectName)}`
      : "unassigned";
  return createHash("sha256")
    .update("codex-dashboard/project-key/v1")
    .update("\0")
    .update(identity)
    .digest("hex")
    .slice(0, 32);
}

function dashboardProjectIdentity(
  ...candidates: ReadonlyArray<{
    projectId?: string;
    projectName?: string;
  } | undefined>
): Pick<DashboardRow, "projectKey" | "projectName"> {
  const paired = candidates.find((candidate) => candidate?.projectId && candidate.projectName);
  const projectId = paired?.projectId || candidates.find((candidate) => candidate?.projectId)?.projectId;
  const projectName = paired?.projectName ||
    candidates.find((candidate) => candidate?.projectName)?.projectName ||
    null;
  return {
    projectKey: dashboardProjectKey(projectId, projectName),
    projectName
  };
}

function dashboardAgentName(agentName: string | undefined): string {
  const value = agentName?.trim();
  if (!value) return "Codex job";
  return /^Codex Agent [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? "Codex Agent"
    : value;
}

function dashboardStatusForJob(job: CodexJob): DashboardStatus {
  if (isTerminalActivityJobStatus(job.status)) return job.status;
  if (job.pendingInteractions.some((interaction) => interaction.isBlocking !== false && isInputInteraction(interaction))) {
    return "input-required";
  }
  if (job.pendingInteractions.some(interaction => interaction.isBlocking !== false)) return "approval-required";
  if (job.trackingState === "orphaned") return "orphaned";
  if (job.trackingState === "liveness-unknown" || job.trackingState === "worker-lost") {
    return "liveness-unknown";
  }
  return job.status;
}

function activityParticipantDisplayState(
  activity: BridgeActivity,
  assignment: ActivityAgentAssignment | undefined,
  activityJobs: readonly CodexJob[]
): string {
  const activeJobs = activityJobs
    .filter((job) => isActiveActivityJobStatus(job.status))
    .sort((left, right) =>
      dashboardStatusPriority(dashboardStatusForJob(left)) -
        dashboardStatusPriority(dashboardStatusForJob(right)) ||
      right.updatedAt - left.updatedAt
    );
  const representative = activeJobs[0] || activityJobs.at(-1);
  if (representative) {
    const status = dashboardStatusForJob(representative);
    return status === "cancelled" ? "interrupted" : status;
  }
  if (assignment?.releasedAt === undefined && activity.lifecycle === "open") {
    return "waiting-gpt";
  }
  if (activity.lifecycle === "cancelled" || activity.lifecycle === "abandoned") {
    return "ended";
  }
  return "idle";
}

function dashboardPage<T>(
  rows: readonly T[],
  requestedOffset: number,
  limit: number,
  conversationKey: (row: T) => string
): { rows: T[]; page: DashboardPage } {
  const total = rows.length;
  const maximumOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
  const offset = Math.min(Math.max(0, requestedOffset), maximumOffset);
  const visible = rows.slice(offset, offset + limit);
  return {
    rows: visible,
    page: {
      offset,
      limit,
      returned: visible.length,
      total,
      returnedConversations: new Set(visible.map(conversationKey)).size,
      conversationTotal: new Set(rows.map(conversationKey)).size,
      hasPrevious: offset > 0,
      hasNext: offset + visible.length < total
    }
  };
}

function dashboardActivityPage(
  rows: readonly DashboardRow[],
  requestedOffset: number,
  limit: number
): { rows: DashboardRow[]; page: DashboardPage } {
  const groups: DashboardRow[][] = [];
  const byActivity = new Map<string, DashboardRow[]>();
  for (const row of rows) {
    const existing = byActivity.get(row.activityKey);
    if (existing) {
      existing.push(row);
      continue;
    }
    const group = [row];
    byActivity.set(row.activityKey, group);
    groups.push(group);
  }

  const pages: Array<{ offset: number; rows: DashboardRow[] }> = [];
  let pageRows: DashboardRow[] = [];
  let offset = 0;
  for (const group of groups) {
    if (pageRows.length > 0 && pageRows.length + group.length > limit) {
      pages.push({ offset, rows: pageRows });
      offset += pageRows.length;
      pageRows = [];
    }
    pageRows.push(...group);
  }
  if (pageRows.length > 0 || pages.length === 0) pages.push({ offset, rows: pageRows });

  const requested = Math.max(0, requestedOffset);
  let pageIndex = pages.findIndex((page) => page.offset === requested);
  if (pageIndex < 0) {
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      if ((pages[index]?.offset || 0) <= requested) {
        pageIndex = index;
        break;
      }
    }
  }
  if (pageIndex < 0) pageIndex = 0;
  const selected = pages[pageIndex] as { offset: number; rows: DashboardRow[] };
  return {
    rows: selected.rows,
    page: {
      offset: selected.offset,
      limit,
      returned: selected.rows.length,
      total: rows.length,
      returnedConversations: new Set(selected.rows.map((row) => row.conversationKey)).size,
      conversationTotal: new Set(rows.map((row) => row.conversationKey)).size,
      hasPrevious: pageIndex > 0,
      hasNext: pageIndex + 1 < pages.length
    }
  };
}

function dashboardStatusPriority(status: DashboardStatus): number {
  if (status === "input-required" || status === "approval-required") return 0;
  if (
    status === "termination-failed" ||
    status === "orphaned" ||
    status === "liveness-unknown" ||
    status === "failed" ||
    status === "interrupted"
  ) return 1;
  if (status === "terminating") return 2;
  if (status === "running" || status === "background-process-running") return 3;
  if (status === "completed" || status === "cancelled") return 4;
  return 5;
}

function listAllDashboardAgents(jobs: CodexJobRegistry, scopeId?: string): BridgeAgent[] {
  const total = jobs.agentCount(scopeId);
  const agents: BridgeAgent[] = [];
  while (agents.length < total) {
    const page = scopeId
      ? jobs.listAgents(scopeId, 1_000, agents.length)
      : jobs.listAllAgents(1_000, agents.length);
    if (page.length === 0) break;
    agents.push(...page);
  }
  return agents;
}

type BackgroundInspection = { state: "loaded"; count: number } | { state: "unloaded" } | { state: "unknown" };
const backgroundImpactReads = new WeakMap<CodexUpstream, DisplayReadPool<BackgroundInspection>>();

async function inspectBridgeBackgroundProcessImpact(
  jobs: CodexJobRegistry,
  upstream: CodexUpstream
): Promise<BridgeBackgroundProcessImpact> {
  const threads = new Map<string, Pick<BridgeAgentThread, "threadId" | "backendKind">>();
  for (const agent of listAllDashboardAgents(jobs)) {
    const thread = jobs.listAgentThreads(agent.agentId).find((entry) => entry.isCurrent);
    if (thread && backendSupports(thread.backendKind, "supportsBackgroundTerminals")) threads.set(`${thread.backendKind}\0${thread.threadId}`, thread);

  }
  const candidates = [...threads.values()];
  if (candidates.length === 0) {
    return { state: "confirmed", processes: 0, agents: 0, unknownAgents: 0 };
  }
  if (!upstream.listLoadedBackgroundTerminals) {
    return {
      state: "unknown",
      processes: 0,
      agents: 0,
      unknownAgents: candidates.length
    };
  }

  const deadline = Date.now() + DASHBOARD_RUNTIME_BUDGET_MS;
  let nextIndex = 0;
  let processes = 0;
  let agents = 0;
  let unknownAgents = 0;
  const pool = backgroundImpactReads.get(upstream) || new DisplayReadPool<BackgroundInspection>(DASHBOARD_RUNTIME_PROBE_CONCURRENCY);
  backgroundImpactReads.set(upstream, pool);
  const inspect = async (
    thread: Pick<BridgeAgentThread, "threadId" | "backendKind">,
    timeoutMs: number
  ): Promise<BackgroundInspection> => {
    if (!backendSupports(thread.backendKind, "supportsBackgroundTerminals")) {
      return Promise.resolve(upstream.canResumeThread?.(thread.threadId, thread.backendKind as CodexBackendKind) === true
        ? { state: "unknown" } : { state: "unloaded" });
    }
    // A display timeout ends this wait, not the underlying read. Share its
    // physical reservation across repeated/native snapshot requests.
    const read = pool.start(`${thread.backendKind}\0${thread.threadId}`, async () => {
      try {
        const terminals = await upstream.listLoadedBackgroundTerminals!(thread.threadId, thread.backendKind as CodexBackendKind);
        return terminals === null ? { state: "unloaded" } : { state: "loaded", count: terminals.length };
      } catch { return { state: "unknown" }; }
    }, () => {});
    if (!read) return { state: "unknown" };
    const waited = await waitForDisplay(read, timeoutMs);
    return waited.pending ? { state: "unknown" } : waited.value;
  };
  const worker = async (): Promise<void> => {
    while (nextIndex < candidates.length) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const thread = candidates[nextIndex++];
      if (!thread) return;
      const result = await inspect(
        thread,
        Math.max(1, Math.min(DASHBOARD_RUNTIME_PROBE_TIMEOUT_MS, remainingMs))
      );
      if (result.state === "unknown") {
        unknownAgents += 1;
      } else if (result.state === "loaded") {
        processes += result.count;
        if (result.count > 0) agents += 1;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(DASHBOARD_RUNTIME_PROBE_CONCURRENCY, candidates.length) },
      () => worker()
    )
  );
  unknownAgents += Math.max(0, candidates.length - nextIndex);
  return {
    state: unknownAgents === 0 ? "confirmed" : "unknown",
    processes,
    agents,
    unknownAgents
  };
}

async function inspectDashboardRuntime(
  upstream: CodexUpstream,
  candidate: DashboardRuntimeCandidate,
  shouldContinue: () => boolean = () => true
): Promise<{
  observation: DashboardRuntimeObservation;
  requests: number;
  coverage: DashboardRuntimeCacheEntry["coverage"];
}> {
  const { thread, inspectLiveness } = candidate;
  const backendKind = thread.backendKind as CodexBackendKind;
  let state: DashboardRuntimeObservation["state"] = "confirmed";
  let requests = 0;
  const coverage = inspectLiveness ? "liveness" as const : "background" as const;
  if (inspectLiveness && upstream.probeThread) {
    let probe: CodexThreadResumeProbe;
    try {
      requests += 1;
      probe = await upstream.probeThread(thread.threadId, backendKind);
    } catch {
      return {
        observation: {
          state: "unknown",
          backgroundProcessState: "unknown",
          backgroundProcessCount: 0
        },
        requests,
        coverage
      };
    }
    if (!shouldContinue()) {
      return {
        observation: {
          state: "unknown",
          backgroundProcessState: "unknown",
          backgroundProcessCount: 0
        },
        requests,
        coverage
      };
    }
    if (probe.state === "orphaned") {
      return {
        observation: {
          state: "orphaned",
          backgroundProcessState: "unknown",
          backgroundProcessCount: 0
        },
        requests,
        coverage
      };
    }
    if (probe.state === "unknown") {
      return {
        observation: {
          state: "unknown",
          backgroundProcessState: "unknown",
          backgroundProcessCount: 0
        },
        requests,
        coverage
      };
    }
    if (probe.state === "resumable" && probe.runtimeStatus === "notLoaded") {
      return {
        observation: {
          state: "not-loaded",
          backgroundProcessState: "confirmed",
          backgroundProcessCount: 0
        },
        requests,
        coverage
      };
    }
    state = probe.state === "busy" ? "busy" : "idle";
  }
  if (!upstream.listLoadedBackgroundTerminals) {
    return {
      observation: { state, backgroundProcessState: "unknown", backgroundProcessCount: 0 },
      requests,
      coverage
    };
  }
  try {
    requests += 1;
    const terminals = await upstream.listLoadedBackgroundTerminals(thread.threadId, backendKind);
    if (terminals === null) {
      return {
        observation: {
          state: state === "confirmed" ? "not-loaded" : state,
          backgroundProcessState: "confirmed",
          backgroundProcessCount: 0
        },
        requests,
        coverage
      };
    }
    return {
      observation: {
        state,
        backgroundProcessState: "confirmed",
        backgroundProcessCount: terminals.length,
        backgroundProcessIds: terminals.map((terminal) => terminal.processId)
      },
      requests,
      coverage
    };
  } catch {
    return {
      observation: { state, backgroundProcessState: "unknown", backgroundProcessCount: 0 },
      requests,
      coverage
    };
  }
}

function dashboardRuntimeCacheKey(thread: BridgeAgentThread): string {
  return `${thread.backendKind}\0${thread.threadId}`;
}

function dashboardRuntimeStamp(
  agent: Pick<BridgeAgent, "version" | "updatedAt">,
  latestJob?: Pick<CodexJob, "version" | "updatedAt">
): string {
  return `${agent.version}:${agent.updatedAt}:${latestJob?.version || 0}:${latestJob?.updatedAt || 0}`;
}

function cachedDashboardRuntimes(
  upstream: CodexUpstream,
  candidates: ReadonlyArray<DashboardRuntimeCandidate>
): Map<string, DashboardRuntimeObservation> {
  const observations = new Map<string, DashboardRuntimeObservation>();
  const cache = dashboardRuntimeCaches.get(upstream);
  if (!cache) return observations;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.retainUntil <= now) cache.delete(key);
  }
  for (const candidate of candidates) {
    const cached = cache.get(dashboardRuntimeCacheKey(candidate.thread));
    if (cached?.stamp === candidate.stamp && cached.retainUntil > now) {
      observations.set(candidate.agentId, cached.observation);
    }
  }
  return observations;
}

function cachedDashboardEnrichment(
  upstream: CodexUpstream,
  candidates: ReadonlyArray<DashboardRuntimeCandidate>
): CardEnrichmentSummary {
  const now = Date.now();
  const cache = dashboardRuntimeCaches.get(upstream);
  const entries = candidates.flatMap(candidate => {
    const entry = cache?.get(dashboardRuntimeCacheKey(candidate.thread));
    return entry?.stamp === candidate.stamp && entry.retainUntil > now ? [entry] : [];
  });
  const prefixes = candidates.map(candidate => `${dashboardRuntimeCacheKey(candidate.thread)}\0${candidate.stamp}\0`);
  const runtimePending = dashboardRuntimeReads.get(upstream)?.observePending(key => prefixes.some(prefix => key.startsWith(prefix))) || 0;
  const revision = upstream.accountRevision?.();
  const usagePending = cardUsageReads.get(upstream)?.observePending(key => key === (revision || "default")) || 0;
  const usageCompletion = cardUsageCompletions.get(upstream);
  const dates = entries.map(entry => new Date(entry.observedAt).toISOString());
  const usage = cachedCodexWeeklyUsage(upstream);
  if (usage) dates.push(usage.observedAt);
  const oldestObservationAt = earliestObservationAt(dates);
  return {
    state: "structural", runtimeRequests: 0, cacheHits: entries.length,
    timeouts: 0, durationMs: 0, usageTimedOut: false,
    pendingReads: runtimePending + usagePending,
    runtimeUnavailable: entries.filter(entry => entry.unavailable).length,
    usageUnavailable: !!(usageCompletion && usageCompletion.revision === revision && usageCompletion.failed),
    ...(oldestObservationAt ? { oldestObservationAt } : {})
  };
}

function earliestObservationAt(values: ReadonlyArray<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
}

type DashboardRuntimeResult = Awaited<ReturnType<typeof inspectDashboardRuntime>>;
const dashboardRuntimeReads = new WeakMap<CodexUpstream, DisplayReadPool<DashboardRuntimeResult>>();

function runtimeReadPool(upstream: CodexUpstream): DisplayReadPool<DashboardRuntimeResult> {
  const pool = dashboardRuntimeReads.get(upstream) || new DisplayReadPool<DashboardRuntimeResult>(CARD_RUNTIME_PROBE_CONCURRENCY, () => notifyCardObservation(upstream));
  dashboardRuntimeReads.set(upstream, pool);
  return pool;
}

function cacheDashboardRuntime(
  cache: Map<string, DashboardRuntimeCacheEntry>,
  candidate: DashboardRuntimeCandidate,
  result: DashboardRuntimeResult,
  deferred: boolean,
  jobs?: CodexJobRegistry
): void {
  const cacheKey = dashboardRuntimeCacheKey(candidate.thread);
  const previous = cache.get(cacheKey);
  const canRetainLiveness =
    result.coverage === "background" &&
    previous?.stamp === candidate.stamp &&
    previous.coverage === "liveness" &&
    previous.retainUntil > Date.now();
  const observation = canRetainLiveness
    ? { ...result.observation, state: previous.observation.state }
    : result.observation;
  const coverage = canRetainLiveness ? "liveness" as const : result.coverage;
  const stable =
    observation.backgroundProcessState === "confirmed" &&
    ["confirmed", "idle", "not-loaded", "busy"].includes(observation.state);
  {
    // Briefly cache unsuccessful checks too so a permanently unavailable thread
    // cannot monopolize every inspection batch.
    const keepPrevious = !stable && observation.state !== "orphaned" && previous?.stamp === candidate.stamp && previous.retainUntil > Date.now();
    const retained = keepPrevious
      ? {...previous.observation, ...(result.coverage === "liveness" && ["idle","busy","not-loaded"].includes(observation.state)
        ? {state:observation.state} : {})} : observation;
    cache.delete(cacheKey);
    cache.set(cacheKey, {
      stamp: candidate.stamp,
      coverage,
      // Reuse unloaded observations too: a late usage completion should not
      // immediately repeat hundreds of otherwise successful runtime probes.
      freshUntil: !stable && result.coverage === "liveness" && !deferred ? 0 : Date.now() + CARD_RUNTIME_CACHE_TTL_MS,
      livenessFreshUntil: result.coverage === "liveness"
        ? Date.now() + CARD_RUNTIME_CACHE_TTL_MS : canRetainLiveness ? previous.livenessFreshUntil : undefined,
      retainUntil: keepPrevious || canRetainLiveness
        ? previous!.retainUntil : Date.now() + CARD_RUNTIME_STALE_TTL_MS,
      observation: retained,
      inspectedObservation: result.observation,
      attemptedAt: Date.now(),
      unavailable: !stable || !!(canRetainLiveness && previous.unavailable),
      observedAt: keepPrevious || canRetainLiveness ? previous!.observedAt : Date.now()
    });
    const agent = jobs?.getAgent(candidate.agentId);
    const latest = jobs?.observedLatestJobForAgent(candidate.agentId);
    if (jobs && agent && dashboardRuntimeStamp(agent,latest) === candidate.stamp) {
      const current = cache.get(cacheKey)!;
      const confirmed = !current.unavailable && current.observation.backgroundProcessState === "confirmed" &&
        ["confirmed","idle","not-loaded","busy"].includes(current.observation.state);
      jobs.admissionStateStore.automaticRecovery.observeRecheck(recheckRecoveryIdentity(jobs,agent,latest),!confirmed,Date.now(),
        confirmed ? current.observation.state === "busy" ? "active-turn-observed" : "runtime-observed" : undefined);
    }
    while (cache.size > CARD_RUNTIME_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (typeof oldestKey !== "string") break;
      cache.delete(oldestKey);
    }
  }
}

async function inspectDashboardRuntimes(
  upstream: CodexUpstream,
  candidates: ReadonlyArray<DashboardRuntimeCandidate>,
  jobs?: CodexJobRegistry
): Promise<{
  observations: Map<string, DashboardRuntimeObservation>;
  skipped: number;
  requests: number;
  cacheHits: number;
  timeouts: number;
  unavailable: number;
  oldestObservationAt?: string;
}> {
  const observations = new Map<string, DashboardRuntimeObservation>();
  const cache = dashboardRuntimeCaches.get(upstream) || new Map<string, DashboardRuntimeCacheEntry>();
  dashboardRuntimeCaches.set(upstream, cache);
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.retainUntil <= now) cache.delete(key);
  }
  let unavailable = 0;
  const pending = candidates.filter((candidate) => {
    const key = dashboardRuntimeCacheKey(candidate.thread);
    const cached = cache.get(key);
    if (!cached || cached.stamp !== candidate.stamp || cached.retainUntil <= now) return true;
    observations.set(candidate.agentId, cached.observation);
    const coverageSatisfied = !candidate.inspectLiveness ||
      (cached.coverage === "liveness" && (cached.livenessFreshUntil || 0) > now);
    const needsRead = cached.freshUntil <= now || !coverageSatisfied;
    if (!needsRead && cached.unavailable) unavailable += 1;
    return needsRead;
  });
  const cacheHits = candidates.length - pending.length;
  // When reads outlast the display budget, let the next periodic refresh reach
  // unobserved/older threads instead of always repeating the same first workers.
  pending.sort((left, right) => {
    const checkedAt = (candidate: DashboardRuntimeCandidate) => {
      const entry = cache.get(dashboardRuntimeCacheKey(candidate.thread));
      return entry?.stamp === candidate.stamp ? entry.attemptedAt : 0;
    };
    return checkedAt(left) - checkedAt(right);
  });
  const deadline = Date.now() + CARD_RUNTIME_BUDGET_MS;
  let timedOut = 0;
  let requests = 0;
  const pool = runtimeReadPool(upstream);
  for (const candidate of candidates) {
    const prefix = `${dashboardRuntimeCacheKey(candidate.thread)}\0`;
    pool.invalidate(key => key.startsWith(prefix) && !key.startsWith(`${prefix}${candidate.stamp}\0`));
  }
  const worker = async (
    queue: DashboardRuntimeCandidate[],
    cursor: { value: number }
  ): Promise<void> => {
    while (cursor.value < queue.length) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const candidate = queue[cursor.value++];
      if (!candidate) return;
      const initiallyCountedRequests = candidate.inspectLiveness && upstream.probeThread
        ? 1
        : upstream.listLoadedBackgroundTerminals
          ? 1
          : 0;
      let started = false;
      const request = pool.start(
        `${dashboardRuntimeCacheKey(candidate.thread)}\0${candidate.stamp}\0${candidate.inspectLiveness}`,
        isCurrent => {
          started = true;
          requests += initiallyCountedRequests;
          return inspectDashboardRuntime(upstream, candidate, isCurrent);
        },
        (value, deferred) => {
          cacheDashboardRuntime(cache, candidate, value, deferred, jobs);
          if (deferred) notifyCardObservation(upstream);
        }
      );
      const waited = request ? await waitForDisplay(
        request, Math.max(1, Math.min(CARD_RUNTIME_PROBE_TIMEOUT_MS, remainingMs))
      ) : { pending: true as const };
      const result = !waited.pending && !request?.invalidated ? waited.value : null;
      if (result) {
        if (result.observation.state === "unknown" || result.observation.backgroundProcessState === "unknown") unavailable += 1;
        if (started) requests += Math.max(0, result.requests - initiallyCountedRequests);
        const cached = cache.get(dashboardRuntimeCacheKey(candidate.thread));
        const observation = cached?.stamp === candidate.stamp ? cached.observation : result.observation;
        if (!observations.has(candidate.agentId) || result.observation.state === "orphaned" ||
            result.coverage === "liveness" && ["idle","busy","not-loaded"].includes(result.observation.state) ||
            result.observation.backgroundProcessState === "confirmed") {
          observations.set(candidate.agentId, result.observation.state === "orphaned" ? result.observation : observation);
        }
      } else {
        timedOut += 1;
        if (!observations.has(candidate.agentId)) {
          observations.set(candidate.agentId, {
            state: "unknown",
            backgroundProcessState: "unknown",
            backgroundProcessCount: 0
          });
        }
        // Stop this display worker at its budget. The shared pool continues
        // to hold the physical slot across subsequent snapshot requests.
        return;
      }
    }
  };
  const livenessPending = pending.filter((candidate) => candidate.inspectLiveness);
  const backgroundPending = pending.filter((candidate) => !candidate.inspectLiveness);
  const livenessCursor = { value: 0 };
  const backgroundCursor = { value: 0 };
  let livenessWorkers = 0;
  let backgroundWorkers = 0;
  // Keep independent worker pools when both coverage classes are present.
  // A stalled thread/read therefore cannot consume every slot needed to find
  // a background process on an otherwise off-page loaded thread.
  if (livenessPending.length > 0 && backgroundPending.length > 0) {
    backgroundWorkers = Math.min(
      backgroundPending.length,
      Math.floor(CARD_RUNTIME_PROBE_CONCURRENCY / 2)
    );
    livenessWorkers = Math.min(
      livenessPending.length,
      CARD_RUNTIME_PROBE_CONCURRENCY - backgroundWorkers
    );
    let unassignedWorkers = CARD_RUNTIME_PROBE_CONCURRENCY -
      livenessWorkers - backgroundWorkers;
    const additionalBackgroundWorkers = Math.min(
      unassignedWorkers,
      backgroundPending.length - backgroundWorkers
    );
    backgroundWorkers += additionalBackgroundWorkers;
    unassignedWorkers -= additionalBackgroundWorkers;
    livenessWorkers += Math.min(
      unassignedWorkers,
      livenessPending.length - livenessWorkers
    );
  } else if (livenessPending.length > 0) {
    livenessWorkers = Math.min(CARD_RUNTIME_PROBE_CONCURRENCY, livenessPending.length);
  } else {
    backgroundWorkers = Math.min(CARD_RUNTIME_PROBE_CONCURRENCY, backgroundPending.length);
  }
  await Promise.all([
    ...Array.from(
      { length: livenessWorkers },
      () => worker(livenessPending, livenessCursor)
    ),
    ...Array.from(
      { length: backgroundWorkers },
      () => worker(backgroundPending, backgroundCursor)
    )
  ]);
  return {
    observations,
    skipped:
      timedOut +
      Math.max(0, livenessPending.length - livenessCursor.value) +
      Math.max(0, backgroundPending.length - backgroundCursor.value),
    requests,
    cacheHits,
    timeouts: timedOut,
    unavailable,
    oldestObservationAt: candidates.reduce<string | undefined>((oldest, candidate) => {
      const cached = cache.get(dashboardRuntimeCacheKey(candidate.thread));
      if (cached?.stamp !== candidate.stamp || cached.retainUntil <= Date.now()) return oldest;
      const observed = new Date(cached.observedAt).toISOString();
      return oldest && oldest < observed ? oldest : observed;
    }, undefined)
  };
}

/** Request-local memoization: never keep a display snapshot across reads. */
function projectionModelCatalog(provider: CodexModelCatalogProvider): CodexModelCatalogProvider {
  const snapshots = new Map<string, ReturnType<NonNullable<CodexModelCatalogProvider["getCachedCatalog"]>>>();
  return {
    getCatalog: options => provider.getCatalog(options),
    getCachedCatalog(options) {
      const key = options?.backendKind || "default";
      if (!snapshots.has(key)) snapshots.set(key, provider.getCachedCatalog?.(options));
      return snapshots.get(key);
    }
  };
}

function buildDashboardHistoryDetail(
  jobs: CodexJobRegistry,
  modelCatalog: CodexModelCatalogProvider,
  options: BridgeDashboardHistoryDetailOptions
): DashboardHistoryDetail {
  const agent = listAllDashboardAgents(jobs, options.scopeId)
    .find((candidate) => dashboardRowKey(candidate.agentId) === options.rowKey);
  if (!agent) {
    throw new Error("DASHBOARD_HISTORY_TARGET_CHANGED: Refresh the selected execution.");
  }

  const now = Date.now();
  const catalog = projectionModelCatalog(modelCatalog);
  const cancellations = buildCancellationDisplayIndex(jobs, agent.scopeId).byJobId;
  let summaryCache = new Map<string, Record<string, unknown>>();
  const activityTitle = (activityId: string): string | null => jobs.getActivity(activityId)?.title || null;
  const turnForJob = (job: CodexJob): DashboardTurn => {
    const execution = dashboardExecutionForJob(job, catalog);
    const cancellation = cancellations.get(job.jobId);
    const terminal = isTerminalActivityJobStatus(job.status);
    return {
      activityKey: dashboardActivityKey(job.activityId, job.jobId),
      activityTitle: activityTitle(job.activityId),
      ...(execution ? { execution } : {}),
      ...dashboardJobTokenUsage(job.jobId, summaryCache),
      status: dashboardStatusForJob(job),
      startedAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      endedAt: terminal ? new Date(job.updatedAt).toISOString() : null,
      durationMs: Math.max(0, (terminal ? job.updatedAt : now) - job.createdAt),
      ...(cancellation ? { cancellation } : {})
    };
  };
  const turnForArchivedJob = (job: DashboardRetainedJobSummary): DashboardTurn => {
    const execution = job.execution
      ? dashboardExecutionForSelection(job.execution, job.backendKind, catalog, false, job.execution.reroutedModel)
      : undefined;
    const cancellation = cancellations.get(job.jobId);
    return {
      activityKey: dashboardActivityKey(job.activityId, job.jobId),
      activityTitle: activityTitle(job.activityId),
      ...(execution ? { execution } : {}),
      ...dashboardJobTokenUsage(job.jobId, summaryCache),
      status: job.status as DashboardStatus,
      startedAt: job.createdAt === undefined ? null : new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      endedAt: new Date(job.updatedAt).toISOString(),
      durationMs: job.createdAt === undefined ? null : Math.max(0, job.updatedAt - job.createdAt),
      ...(cancellation ? { cancellation } : {})
    };
  };

  type HistoryEntry = {
    jobId: string;
    createdAt: number;
    updatedAt: number;
    revision: string;
    turn: () => DashboardTurn;
  };
  const current = jobs.listForAgent(agent.agentId)
    .filter((job) => job.scopeId === agent.scopeId);
  const archivedProjection = jobs.admissionStateStore.listDashboardAgentRetainedJobs(
    agent.scopeId,
    agent.agentId,
    DASHBOARD_HISTORY_LIMIT_PER_AGENT
  );
  const archived = [
    ...(archivedProjection.representative ? [archivedProjection.representative] : []),
    ...archivedProjection.history
  ]
    .filter((job) => isTerminalActivityJobStatus(job.status));
  summaryCache = jobs.admissionStateStore.dashboardJobSummaries([
    ...current.map((job) => job.jobId),
    ...archived.map((job) => job.jobId)
  ]);
  const entries: HistoryEntry[] = [
    ...current.map((job) => ({
      jobId: job.jobId,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      revision: dashboardHistoryRevision(agent, job),
      turn: () => turnForJob(job)
    })),
    ...archived.map((job) => ({
      jobId: job.jobId,
      createdAt: job.createdAt ?? job.updatedAt,
      updatedAt: job.updatedAt,
      revision: dashboardHistoryRevision(agent, job),
      turn: () => turnForArchivedJob(job)
    }))
  ];
  const currentJob = agent.currentJobId ? jobs.get(agent.currentJobId) : undefined;
  // A status row identifies the Agent rather than a Job. Prefer its active
  // Job; idle/recent rows fall back to the newest retained execution just as
  // the Dashboard projection does.
  const representativeJobId = currentJob?.agentId === agent.agentId && currentJob.scopeId === agent.scopeId
    ? currentJob.jobId
    : [...entries].sort((left, right) =>
      right.createdAt - left.createdAt || right.updatedAt - left.updatedAt || right.jobId.localeCompare(left.jobId)
    )[0]?.jobId;
  const representative = entries.find((entry) => entry.jobId === representativeJobId);
  const history = entries
    .filter((entry) => entry.jobId !== representativeJobId)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.jobId.localeCompare(left.jobId));
  return dashboardHistoryDetailOutputSchema.parse({
    kind: "dashboard-history",
    rowKey: options.rowKey,
    history: history.slice(0, DASHBOARD_HISTORY_LIMIT_PER_AGENT).map((entry) => entry.turn()),
    historyCount: Math.max(0, current.length + archivedProjection.total - (representative ? 1 : 0)),
    ...(representative ? { historyRevision: representative.revision } : {})
  });
}

async function buildDashboardRuntimePlan(
  jobs: CodexJobRegistry,
  upstream: CodexUpstream,
  modelCatalog: CodexModelCatalogProvider,
  sessions: SessionRegistry,
  scopeResolver: ScopeResolver,
  config: BridgeConfig,
  preferences: BridgeUserSettings,
  limit: number,
  terminalOffset: number,
  idleOffset: number,
  scopeId?: string,
  statusFilter?: DashboardStatusFilter,
  problemQuery?: ProblemQuery,
  includeHistory = true
): Promise<BridgeDashboardRuntimePlan> {
  if (problemQuery && statusFilter === undefined) statusFilter = "all";
  const visibleAgentIds = new Set<string>();
  await buildDashboardView(
    jobs,
    upstream,
    modelCatalog,
    sessions,
    scopeResolver,
    config,
    preferences,
    limit,
    terminalOffset,
    idleOffset,
    false,
    visibleAgentIds,
    undefined,
    scopeId,
    statusFilter,
    problemQuery,
    includeHistory
  );
  const inScope = (row: { scopeId: string }): boolean => !scopeId || row.scopeId === scopeId;
  const allAgents = listAllDashboardAgents(jobs, scopeId);
  const currentThreads = new Map(
    jobs.listCurrentAgentThreads().map(thread => [thread.agentId, thread])
  );
  const latestJobs = new Map<string, CodexJob>();
  for (const job of jobs.list(Math.max(jobs.size, config.maxRetainedJobs)).filter(inScope)) {
    if (!job.agentId) continue;
    const previous = latestJobs.get(job.agentId);
    if (!previous || previous.createdAt < job.createdAt) latestJobs.set(job.agentId, job);
  }
  const candidates = allAgents.flatMap((agent) => {
    const thread = currentThreads.get(agent.agentId);
    if (!thread || !backendSupports(thread.backendKind, "supportsThreadInspection")) return [];
    const latestJob = latestJobs.get(agent.agentId);
    const resolvedOrphan = agent.lifecycle === "orphaned" && !agent.currentJobId &&
      jobs.admissionStateStore.workHistory.runtimeResolution(
        agent.agentId,
        dashboardRuntimeProblemIdentity(jobs, agent).revision
      );
    return [{
      candidate: {
        agentId: agent.agentId,
        thread,
        stamp: dashboardRuntimeStamp(agent, latestJob),
        inspectLiveness: !resolvedOrphan && (
          statusFilter === undefined && visibleAgentIds.has(agent.agentId) ||
          agent.lifecycle === "active" ||
          agent.lifecycle === "waiting-input" ||
          agent.lifecycle === "orphaned" ||
          Boolean(agent.currentJobId)
        )
      } satisfies DashboardRuntimeCandidate,
      changedAt: Math.max(agent.updatedAt, latestJob?.updatedAt || 0)
    }];
  }).sort((left, right) => right.changedAt - left.changedAt)
    .map(entry => entry.candidate);
  return { candidates };
}

async function enrichDashboardRuntimePlan(
  upstream: CodexUpstream,
  plan: BridgeDashboardRuntimePlan,
  jobs?: CodexJobRegistry,
  readUpstreamUsage = true
): Promise<BridgeDashboardEnrichment> {
  const rankedCandidates = plan.candidates;
  const cache = dashboardRuntimeCaches.get(upstream);
  const checkedAt = (candidate: DashboardRuntimeCandidate): number => {
    const entry = cache?.get(dashboardRuntimeCacheKey(candidate.thread));
    return entry?.stamp === candidate.stamp ? entry.attemptedAt : 0;
  };
  // Rank the complete candidate set before limiting it. Limiting by recency
  // first permanently starved Agent 201 and beyond on every refresh.
  const fairCandidates = [...rankedCandidates].sort((left, right) =>
    checkedAt(left) - checkedAt(right)
  );
  const livenessCandidates = fairCandidates.filter(candidate => candidate.inspectLiveness);
  const backgroundCandidates = fairCandidates.filter(candidate => !candidate.inspectLiveness);
  const backgroundReserve = backgroundCandidates.length === 0
    ? 0
    : Math.min(
        backgroundCandidates.length,
        Math.max(CARD_RUNTIME_PROBE_CONCURRENCY, Math.floor(CARD_RUNTIME_PROBE_LIMIT / 4))
      );
  const selectedLivenessCandidates = livenessCandidates.slice(
    0,
    CARD_RUNTIME_PROBE_LIMIT - backgroundReserve
  );
  const selectedBackgroundCandidates = backgroundCandidates.slice(
    0,
    CARD_RUNTIME_PROBE_LIMIT - selectedLivenessCandidates.length
  );
  const candidates: DashboardRuntimeCandidate[] = [
    ...selectedLivenessCandidates,
    ...selectedBackgroundCandidates
  ];
  const startedAt = Date.now();
  const [runtimeInspection, usage] = await Promise.all([
    inspectDashboardRuntimes(upstream, candidates, jobs),
    readUpstreamUsage ? readCodexWeeklyUsageBounded(upstream)
      : Promise.resolve({ value: null, timedOut: false, failed: false })
  ]);
  const observations = cachedDashboardRuntimes(upstream, rankedCandidates);
  for (const [agentId, observation] of runtimeInspection.observations) {
    observations.set(agentId, observation);
  }
  const selectedIds = new Set(candidates.map(candidate => candidate.agentId));
  const uncheckedOutsideBatch = rankedCandidates.filter(candidate =>
    !selectedIds.has(candidate.agentId) && !observations.has(candidate.agentId)
  ).length;
  const oldestObservationAt = earliestObservationAt([
    runtimeInspection.oldestObservationAt,
    usage.value?.observedAt
  ]);
  return {
    runtimeByAgent: [...observations.entries()],
    runtimeProbeSkippedAgents: uncheckedOutsideBatch + runtimeInspection.skipped,
    weeklyUsage: usage.value,
    summary: {
      state: "enriched",
      runtimeRequests: runtimeInspection.requests,
      cacheHits: runtimeInspection.cacheHits,
      timeouts: runtimeInspection.timeouts,
      ...(runtimeInspection.unavailable > 0
        ? { runtimeUnavailable: runtimeInspection.unavailable }
        : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
      usageTimedOut: usage.timedOut,
      pendingReads: runtimeInspection.timeouts + (usage.timedOut ? 1 : 0),
      usageUnavailable: usage.failed,
      ...(oldestObservationAt ? { oldestObservationAt } : {})
    }
  };
}

function dashboardEnrichmentInput(
  enrichment: BridgeDashboardEnrichment
): DashboardEnrichmentInput {
  return {
    runtimeByAgent: new Map(enrichment.runtimeByAgent),
    runtimeProbeSkippedAgents: enrichment.runtimeProbeSkippedAgents,
    weeklyUsage: enrichment.weeklyUsage,
    summary: enrichment.summary
  };
}

async function buildDashboardView(
  jobs: CodexJobRegistry,
  upstream: CodexUpstream,
  modelCatalog: CodexModelCatalogProvider,
  sessions: SessionRegistry,
  scopeResolver: ScopeResolver,
  config: BridgeConfig,
  preferences: BridgeUserSettings,
  limit: number,
  terminalOffset: number,
  idleOffset: number,
  inspectRuntime: boolean,
  visibleAgentIdsOut?: Set<string>,
  enrichment?: DashboardEnrichmentInput,
  scopeId?: string,
  statusFilter?: DashboardStatusFilter,
  problemQuery?: ProblemQuery,
  includeHistory = true
): Promise<DashboardView> {
  if (problemQuery && statusFilter === undefined) statusFilter = "all";
  const inScope = (row: { scopeId: string }): boolean => !scopeId || row.scopeId === scopeId;
  if (inspectRuntime && !enrichment) {
    const plan = await buildDashboardRuntimePlan(
      jobs,
      upstream,
      modelCatalog,
      sessions,
      scopeResolver,
      config,
      preferences,
      limit,
      terminalOffset,
      idleOffset,
      scopeId,
      statusFilter,
      problemQuery,
      includeHistory
    );
    const projectedEnrichment = await enrichDashboardRuntimePlan(upstream, plan, jobs,
      !config.codexService);
    return buildDashboardView(
      jobs,
      upstream,
      modelCatalog,
      sessions,
      scopeResolver,
      config,
      preferences,
      limit,
      terminalOffset,
      idleOffset,
      true,
      visibleAgentIdsOut,
      dashboardEnrichmentInput(projectedEnrichment),
      scopeId,
      statusFilter,
      problemQuery,
      includeHistory
    );
  }
  // Read expensive contextual catalog metadata once per backend for this
  // synchronous projection. A later request/enrichment gets its own fresh read.
  modelCatalog = projectionModelCatalog(modelCatalog);
  const now = Date.now();
  const allJobs = jobs.list(Math.max(jobs.size, config.maxRetainedJobs), 0).filter(inScope);
  const cancellationDisplays = buildCancellationDisplayIndex(jobs, scopeId);
  const displayedCancellationJobIds = new Set<string>();
  const cancellationForDashboardJob = (jobId: string): CancellationDisplay | undefined => {
    const cancellation = cancellationDisplays.byJobId.get(jobId);
    if (!cancellation) return undefined;
    if (
      !displayedCancellationJobIds.has(jobId) &&
      displayedCancellationJobIds.size >= CANCELLATION_CARD_OPERATION_LIMIT
    ) return undefined;
    displayedCancellationJobIds.add(jobId);
    return cancellation;
  };
  const problemJobRecords = problemQuery
    ? jobs.admissionStateStore.workHistory.problemJobs(scopeId)
    : [];
  const automaticRecords = problemQuery
    ? jobs.admissionStateStore.automaticRecovery.listForDashboard(scopeId)
    : [];
  const archivedProjection = jobs.admissionStateStore.listDashboardArchivedJobsByAgent(
    scopeId,
    includeHistory ? DASHBOARD_HISTORY_LIMIT_PER_AGENT + 1 : 1,
    statusFilter === undefined ? "updated" : "created"
  );
  const archivedJobs = archivedProjection.jobs;
  const archivedCounts = jobs.admissionStateStore.dashboardArchivedCounts(scopeId);
  const summaryCache = jobs.admissionStateStore.dashboardJobSummaries([
    ...allJobs.map((job) => job.jobId),
    ...archivedJobs.map((job) => job.jobId)
  ]);
  const allAgents = listAllDashboardAgents(jobs, scopeId);
  const allSessions = sessions.list(1_000_000, 0).filter(inScope);
  const agentById = new Map(allAgents.map((agent) => [agent.agentId, agent]));
  const currentThreadByAgent = new Map(jobs.listCurrentAgentThreads().map(thread => [thread.agentId, thread]));
  const sessionById = new Map(allSessions.map(session => [session.threadId, session]));
  const activityById = new Map<string, ReturnType<CodexJobRegistry["getActivity"]>>();
  const activityFor = (id: string) => {
    if (!activityById.has(id)) activityById.set(id, jobs.getActivity(id));
    return activityById.get(id);
  };
  const currentThreadFor = (agentId: string | undefined): BridgeAgentThread | undefined => {
    if (!agentId) return undefined;
    return currentThreadByAgent.get(agentId);
  };
  const currentSessionFor = (agentId: string | undefined): TrackedCodexSession | undefined => {
    const thread = currentThreadFor(agentId);
    return thread ? sessionById.get(thread.threadId) : undefined;
  };
  const codexThreadUrlFor = (
    thread: BridgeAgentThread | undefined,
    ...trackedSessions: Array<TrackedCodexSession | undefined>
  ): string | undefined => {
    const target = thread || trackedSessions.find(
      (session): session is TrackedCodexSession => Boolean(session)
    );
    if (!target || !backendSupports(target.backendKind, "supportsThreadInspection")) return undefined;
    const visibilitySession = trackedSessions.find(
      (session) =>
        session && backendSupports(session.backendKind, "supportsThreadInspection") &&
        session.threadId.toLowerCase() === target.threadId.toLowerCase()
    );
    if (!visibilitySession) return undefined;
    return dashboardCodexThreadUrl(
      visibilitySession.visibleInCodexApp === true,
      target,
      visibilitySession
    );
  };
  const jobsByAgent = new Map<string, CodexJob[]>();
  for (const job of allJobs) {
    if (!job.agentId) continue;
    const retained = jobsByAgent.get(job.agentId) || [];
    retained.push(job);
    jobsByAgent.set(job.agentId, retained);
  }
  for (const retained of jobsByAgent.values()) {
    retained.sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        right.updatedAt - left.updatedAt ||
        right.jobId.localeCompare(left.jobId)
    );
  }
  const latestJobByAgent = new Map<string, CodexJob>();
  for (const [agentId, retained] of jobsByAgent) {
    const latest = retained[0];
    if (latest) latestJobByAgent.set(agentId, latest);
  }
  const archivedJobsByAgent = new Map<string, DashboardRetainedJobSummary[]>();
  for (const job of archivedJobs) {
    if (!job.agentId || !isTerminalActivityJobStatus(job.status)) continue;
    const retained = archivedJobsByAgent.get(job.agentId) || [];
    retained.push(job);
    archivedJobsByAgent.set(job.agentId, retained);
  }
  for (const retained of archivedJobsByAgent.values()) {
    retained.sort(
      (left, right) =>
        (statusFilter === undefined ? 0 :
          (right.createdAt ?? right.updatedAt) - (left.createdAt ?? left.updatedAt)) ||
        right.updatedAt - left.updatedAt || right.jobId.localeCompare(left.jobId)
    );
  }
  const latestArchivedJobByAgent = new Map<string, DashboardRetainedJobSummary>();
  for (const [agentId, retained] of archivedJobsByAgent) {
    const latest = retained[0];
    if (latest) latestArchivedJobByAgent.set(agentId, latest);
  }
  if (statusFilter !== undefined) {
    // Retention is based on update time. A late event on an older run can keep
    // its full Job after the newer run has become an archived summary.
    for (const [agentId, job] of latestJobByAgent) {
      const archived = latestArchivedJobByAgent.get(agentId);
      if (archived && !isActiveActivityJobStatus(job.status) &&
        (archived.createdAt ?? archived.updatedAt) > job.createdAt) {
        latestJobByAgent.delete(agentId);
      }
    }
  }

  const appServerAgents = allAgents
    .flatMap((agent) => {
      const thread = currentThreadFor(agent.agentId);
      return thread && backendSupports(thread.backendKind, "supportsThreadInspection") ? [{ agent, thread }] : [];
    });
  const runtimeCacheCandidates = appServerAgents
    .map(({ agent, thread }) => {
      const latestJob = latestJobByAgent.get(agent.agentId);
      return {
        agentId: agent.agentId,
        thread,
        stamp: dashboardRuntimeStamp(agent, latestJob),
        inspectLiveness: false,
        changedAt: Math.max(agent.updatedAt, latestJob?.updatedAt || 0)
      };
    })
    .sort((left, right) => right.changedAt - left.changedAt);
  const runtimeByAgent = enrichment?.runtimeByAgent ||
    cachedDashboardRuntimes(upstream, runtimeCacheCandidates);
  const runtimeProbeSkippedAgents = enrichment?.runtimeProbeSkippedAgents ??
    Math.max(0, appServerAgents.length - runtimeByAgent.size);

  const statusForJob = (job: CodexJob): DashboardStatus => {
    const status = dashboardStatusForJob(job);
    if (!isActiveActivityJobStatus(job.status) || !job.agentId) return status;
    const runtime = runtimeByAgent.get(job.agentId);
    if (runtime?.state === "orphaned") return "orphaned";
    if (runtime?.state === "idle" || runtime?.state === "not-loaded") {
      return "liveness-unknown";
    }
    return status;
  };

  const turnForJob = (job: CodexJob): DashboardTurn => {
    const terminal = isTerminalActivityJobStatus(job.status);
    const execution = dashboardExecutionForJob(job, modelCatalog);
    const cancellation = cancellationForDashboardJob(job.jobId);
    return {
      activityKey: dashboardActivityKey(job.activityId, job.jobId),
      activityTitle: activityFor(job.activityId)?.title || null,
      ...(execution ? { execution } : {}),
      ...dashboardJobTokenUsage(job.jobId, summaryCache),
      status: statusForJob(job),
      startedAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      endedAt: terminal ? new Date(job.updatedAt).toISOString() : null,
      durationMs: Math.max(0, (terminal ? job.updatedAt : now) - job.createdAt),
      ...(cancellation ? { cancellation } : {})
    };
  };

  const turnForArchivedJob = (job: DashboardRetainedJobSummary): DashboardTurn => {
    const execution = job.execution
      ? dashboardExecutionForSelection(
          job.execution,
          job.backendKind,
          modelCatalog,
          false,
          job.execution.reroutedModel
        )
      : undefined;
    const cancellation = cancellationForDashboardJob(job.jobId);
    return {
      activityKey: dashboardActivityKey(job.activityId, job.jobId),
      activityTitle: activityFor(job.activityId)?.title || null,
      ...(execution ? { execution } : {}),
      ...dashboardJobTokenUsage(job.jobId, summaryCache),
      status: job.status as DashboardStatus,
      startedAt: job.createdAt === undefined ? null : new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
      endedAt: new Date(job.updatedAt).toISOString(),
      durationMs: job.createdAt === undefined
        ? null
        : Math.max(0, job.updatedAt - job.createdAt),
      ...(cancellation ? { cancellation } : {})
    };
  };

  const currentExecutionForAgent = (
    agentId: string | undefined
  ): DashboardExecution | undefined => {
    const session = currentSessionFor(agentId);
    if (!session?.selection) return undefined;
    let selection = session.selection;
    if (backendCapabilities(upstream, session.backendKind).supportsServiceTierOverrideOnContinue) {
      const catalog = modelCatalog.getCachedCatalog?.({ backendKind: session.backendKind });
      const serviceTier = preferences.usePriorityServiceTier && catalog
        ? priorityServiceTierForModel(catalog, selection.model)
        : undefined;
      // Only preview a supported next-run override; retained turns keep their
      // admission-time selection even when the saved preference changes.
      if (preferences.usePriorityServiceTier && !serviceTier) return undefined;
      selection = {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        ...(serviceTier ? { serviceTier } : {})
      };
    }
    return dashboardExecutionForSelection(
      selection,
      session.backendKind,
      modelCatalog,
      true
    );
  };

  const historyForAgent = (
    agentId: string | undefined,
    representativeJobId: string | undefined
  ): { turns: DashboardTurn[]; total: number } => {
    if (!agentId) return { turns: [], total: 0 };
    const retained = [
      ...(jobsByAgent.get(agentId) || []).map((job) => ({
        jobId: job.jobId,
        updatedAt: job.updatedAt,
        turn: () => turnForJob(job)
      })),
      ...(archivedJobsByAgent.get(agentId) || []).map((job) => ({
        jobId: job.jobId,
        updatedAt: job.updatedAt,
        turn: () => turnForArchivedJob(job)
      }))
    ]
      .filter((entry) => entry.jobId !== representativeJobId)
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || right.jobId.localeCompare(left.jobId)
      );
    return {
      turns: includeHistory
        ? retained.slice(0, DASHBOARD_HISTORY_LIMIT_PER_AGENT).map((entry) => entry.turn())
        : [],
      total: Math.max(
        retained.length,
        (jobsByAgent.get(agentId)?.length || 0) +
          (archivedProjection.totalsByAgent.get(agentId) || 0) -
          (representativeJobId ? 1 : 0)
      )
    };
  };

  const agentIdByRowKey = new Map<string, string>();

  // Advertise only controls that the current Dashboard detail read can sign.
  const controlKindForAgent = (
    agentId: string | undefined
  ): DashboardRow["controlKind"] => {
    const agent = agentId ? agentById.get(agentId) : undefined;
    if (!agent) return null;
    const job = agent.currentJobId
      ? jobs.get(agent.currentJobId)
      : latestJobByAgent.get(agent.agentId);
    if (!job || !activityFor(job.activityId)) return null;
    return job.pendingInteractions.some(interaction => !ordinaryCodexQuestion(interaction)) ? "request" : null;
  };

  const jobRow = (job: CodexJob, bucket: DashboardRow["bucket"]): DashboardRow => {
    const agent = job.agentId ? agentById.get(job.agentId) : undefined;
    const thread = currentThreadFor(job.agentId);
    const currentSession = currentSessionFor(job.agentId);
    const trackedSession = job.threadId ? sessionById.get(job.threadId) : undefined;
    const isLatestAgentJob = Boolean(
      job.agentId && latestJobByAgent.get(job.agentId)?.jobId === job.jobId
    );
    const backgroundProcessCount = isLatestAgentJob
      ? runtimeByAgent.get(job.agentId || "")?.backgroundProcessCount || 0
      : 0;
    const latestTurn = turnForJob(job);
    const currentExecution = bucket === "recent" ? currentExecutionForAgent(job.agentId) : undefined;
    const nextExecution = shouldShowDashboardNextExecution(currentExecution, latestTurn.execution)
      ? currentExecution
      : undefined;
    const tokenUsage = dashboardJobTokenUsage(job.jobId, summaryCache).tokenUsage;
    const history = historyForAgent(job.agentId, job.jobId);
    const conversationUrl = scopeResolver.conversationUrl(job.scopeId);
    const codexThreadUrl = codexThreadUrlFor(thread, currentSession, trackedSession);
    const project = dashboardProjectIdentity(job, trackedSession, thread);
    const rowKey = dashboardRowKey(job.agentId, job.jobId);
    if (job.agentId) agentIdByRowKey.set(rowKey, job.agentId);
    return {
      rowKey,
      activityKey: dashboardActivityKey(job.activityId, job.agentId || job.jobId),
      conversationKey: dashboardConversationKey(job.scopeId),
      sessionAlias: dashboardSessionAlias(job.scopeId),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(codexThreadUrl ? { codexThreadUrl } : {}),
      bucket,
      ...project,
      agentName: dashboardAgentName(agent?.agentName),
      ...(tokenUsage ? { tokenUsage } : {}),
      activityTitle: latestTurn.activityTitle,
      ...(nextExecution || latestTurn.execution ? { execution: nextExecution || latestTurn.execution } : {}),
      status: latestTurn.status,
      createdAt: latestTurn.startedAt || latestTurn.updatedAt,
      updatedAt: latestTurn.updatedAt,
      elapsedMs: latestTurn.durationMs || 0,
      backgroundProcessCount,
      controlKind: controlKindForAgent(job.agentId),
      latestTurn,
      history: history.turns,
      historyCount: history.total,
      ...(agent ? { historyRevision: dashboardHistoryRevision(agent, job) } : {})
    };
  };

  const activeJobs = allJobs.filter((job) => isActiveActivityJobStatus(job.status));
  const activeJobIds = new Set(activeJobs.map((job) => job.jobId));
  const activeAgentIds = new Set(
    activeJobs.flatMap((job) => job.agentId ? [job.agentId] : [])
  );
  const representedActiveAgents = new Set<string>();
  const activeRows: DashboardRow[] = [];
  for (const job of activeJobs) {
    if (job.agentId) {
      if (representedActiveAgents.has(job.agentId)) continue;
      representedActiveAgents.add(job.agentId);
    }
    activeRows.push(jobRow(job, "active"));
  }
  const recoveryRows: Array<{ agentId: string; row: DashboardRow }> = [];
  for (const agent of allAgents) {
    if (activeAgentIds.has(agent.agentId)) continue;
    if (
      agent.currentJobId &&
      activeJobIds.has(agent.currentJobId)
    ) continue;
    const latestJob = latestJobByAgent.get(agent.agentId);
    const latestArchivedJob = latestArchivedJobByAgent.get(agent.agentId);
    const thread = currentThreadFor(agent.agentId);
    const runtime = runtimeByAgent.get(agent.agentId);
    let status: DashboardStatus | undefined;
    if (agent.lifecycle === "waiting-input") {
      status = "input-required";
    } else if (agent.lifecycle === "orphaned" || statusFilter === undefined && runtime?.state === "orphaned") {
      status = "orphaned";
    } else if (agent.lifecycle === "active" || runtime?.state === "busy") {
      status = "liveness-unknown";
    } else if (
      agent.lifecycle === "idle" &&
      runtime?.backgroundProcessState === "confirmed" &&
      runtime.backgroundProcessCount > 0
    ) {
      status = "background-process-running";
    }
    if (!status) continue;
    const changedAt = Math.max(
      agent.updatedAt,
      latestJob?.updatedAt || 0,
      latestArchivedJob?.updatedAt || 0
    );
    const latestTurn = latestJob
      ? turnForJob(latestJob)
      : latestArchivedJob
        ? turnForArchivedJob(latestArchivedJob)
        : null;
    const history = historyForAgent(
      agent.agentId,
      latestJob?.jobId || latestArchivedJob?.jobId
    );
    const currentExecution = currentExecutionForAgent(agent.agentId);
    const conversationUrl = scopeResolver.conversationUrl(agent.scopeId);
    const currentSession = currentSessionFor(agent.agentId);
    const codexThreadUrl = codexThreadUrlFor(thread, currentSession);
    const project = dashboardProjectIdentity(thread, latestJob);
    const recoveryRow: DashboardRow = {
      rowKey: dashboardRowKey(agent.agentId),
      activityKey: dashboardActivityKey(
        latestJob?.activityId || latestArchivedJob?.activityId,
        agent.agentId
      ),
      conversationKey: dashboardConversationKey(agent.scopeId),
      sessionAlias: dashboardSessionAlias(agent.scopeId),
      ...(conversationUrl ? { conversationUrl } : {}),
      ...(codexThreadUrl ? { codexThreadUrl } : {}),
      bucket: "active",
      ...project,
      agentName: dashboardAgentName(agent.agentName),
      activityTitle: latestTurn?.activityTitle || null,
      ...(currentExecution || latestTurn?.execution
        ? { execution: currentExecution || latestTurn?.execution }
        : {}),
      status,
      createdAt: latestTurn?.startedAt || new Date(agent.createdAt).toISOString(),
      updatedAt: new Date(changedAt).toISOString(),
      elapsedMs: latestTurn?.durationMs ?? Math.max(0, now - changedAt),
      backgroundProcessCount: runtime?.backgroundProcessCount || 0,
      controlKind: controlKindForAgent(agent.agentId),
      latestTurn,
      history: history.turns,
      historyCount: history.total,
      ...(latestJob || latestArchivedJob
        ? { historyRevision: dashboardHistoryRevision(agent, latestJob || latestArchivedJob) }
        : {})
    };
    agentIdByRowKey.set(recoveryRow.rowKey, agent.agentId);
    recoveryRows.push({ agentId: agent.agentId, row: recoveryRow });
    activeRows.push(recoveryRow);
  }

  // Progress and usage updates must not move active work within its status priority.
  activeRows.sort(
    (left, right) =>
      dashboardStatusPriority(left.status) - dashboardStatusPriority(right.status) ||
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.rowKey.localeCompare(right.rowKey)
  );

  const recoveryAgentIds = new Set(recoveryRows.map(({ agentId }) => agentId));
  const representedTerminalAgents = new Set<string>();
  const terminalRows: DashboardRow[] = [];
  for (const job of allJobs) {
    if (!isTerminalActivityJobStatus(job.status)) continue;
    if (job.agentId) {
      if (activeAgentIds.has(job.agentId) || recoveryAgentIds.has(job.agentId)) continue;
      if (representedTerminalAgents.has(job.agentId)) continue;
      if (latestJobByAgent.get(job.agentId)?.jobId !== job.jobId) continue;
      representedTerminalAgents.add(job.agentId);
    }
    terminalRows.push(jobRow(job, "recent"));
  }
  terminalRows.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
  const idleRows = allAgents
    .filter(
      (agent) =>
        agent.lifecycle === "idle" &&
        !activeAgentIds.has(agent.agentId) &&
        !recoveryAgentIds.has(agent.agentId) &&
        !representedTerminalAgents.has(agent.agentId)
    )
    .map((agent): DashboardRow => {
      const latestJob = latestJobByAgent.get(agent.agentId);
      const latestArchivedJob = latestArchivedJobByAgent.get(agent.agentId);
      const thread = currentThreadFor(agent.agentId);
      const latestTurn = latestJob
        ? turnForJob(latestJob)
        : latestArchivedJob
          ? turnForArchivedJob(latestArchivedJob)
          : null;
      const history = historyForAgent(
        agent.agentId,
        latestJob?.jobId || latestArchivedJob?.jobId
      );
      const currentExecution = currentExecutionForAgent(agent.agentId);
      const conversationUrl = scopeResolver.conversationUrl(agent.scopeId);
      const currentSession = currentSessionFor(agent.agentId);
      const codexThreadUrl = codexThreadUrlFor(thread, currentSession);
      const project = dashboardProjectIdentity(thread, latestJob);
      const conversationKey = dashboardConversationKey(agent.scopeId);
      const row: DashboardRow = {
        rowKey: dashboardRowKey(agent.agentId),
        activityKey: dashboardActivityKey(
          latestJob?.activityId || latestArchivedJob?.activityId,
          `idle:${conversationKey}:${project.projectKey}`
        ),
        conversationKey,
        sessionAlias: dashboardSessionAlias(agent.scopeId),
        ...(conversationUrl ? { conversationUrl } : {}),
        ...(codexThreadUrl ? { codexThreadUrl } : {}),
        bucket: "idle",
        ...project,
        agentName: dashboardAgentName(agent.agentName),
        activityTitle: latestTurn?.activityTitle || null,
        ...(currentExecution || latestTurn?.execution
          ? { execution: currentExecution || latestTurn?.execution }
          : {}),
        status: "idle",
        createdAt: latestTurn?.startedAt || new Date(agent.createdAt).toISOString(),
        updatedAt: latestTurn?.updatedAt || new Date(agent.updatedAt).toISOString(),
        elapsedMs: latestTurn?.durationMs || 0,
        backgroundProcessCount: runtimeByAgent.get(agent.agentId)?.backgroundProcessCount || 0,
        controlKind: controlKindForAgent(agent.agentId),
        latestTurn,
        history: history.turns,
        historyCount: history.total,
        ...(latestJob || latestArchivedJob
          ? { historyRevision: dashboardHistoryRevision(agent, latestJob || latestArchivedJob) }
          : {})
      };
      agentIdByRowKey.set(row.rowKey, agent.agentId);
      return row;
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  const scopeIds = new Set<string>(scopeId ? [] : jobs.admissionStateStore.listActivityScopeIds());
  if (scopeId && jobs.admissionStateStore.hasDashboardWork(scopeId)) scopeIds.add(scopeId);
  for (const job of allJobs) scopeIds.add(job.scopeId);
  for (const job of archivedJobs) scopeIds.add(job.scopeId);
  for (const agent of allAgents) scopeIds.add(agent.scopeId);
  for (const session of allSessions) scopeIds.add(session.scopeId);
  const attentionKeys = new Set<string>();
  for (const [agentId, latestJob] of latestJobByAgent) {
    const agent = agentById.get(agentId);
    if (
      agent && DASHBOARD_ATTENTION_STATUSES.has(statusForJob(latestJob))
    ) {
      attentionKeys.add(`agent:${agentId}`);
    }
  }
  for (const job of allJobs) {
    if (!job.agentId && DASHBOARD_ATTENTION_STATUSES.has(statusForJob(job))) {
      attentionKeys.add(`job:${job.jobId}`);
    }
  }
  for (const { agentId, row } of recoveryRows) {
    if (DASHBOARD_ATTENTION_STATUSES.has(row.status)) {
      attentionKeys.add(`agent:${agentId}`);
    }
  }
  const backgroundProcesses = [...runtimeByAgent.values()]
    .reduce((total, observation) => total + observation.backgroundProcessCount, 0);
  const backgroundProcessAgents = [...runtimeByAgent.values()]
    .filter((observation) => observation.backgroundProcessCount > 0).length;
  const runtimeUnknownAgentIds = new Set([...runtimeByAgent]
    .filter(
      ([,observation]) =>
        observation.state === "unknown" ||
        (observation.state !== "orphaned" && observation.backgroundProcessState === "unknown")
    ).map(([agentId]) => agentId));
  if (problemQuery?.view) for (const agent of allAgents) {
    const thread = currentThreadFor(agent.agentId);
    const cached = thread ? dashboardRuntimeCaches.get(upstream)?.get(dashboardRuntimeCacheKey(thread)) : undefined;
    if (cached?.stamp === dashboardRuntimeStamp(agent,jobs.observedLatestJobForAgent(agent.agentId)) &&
      cached.unavailable && cached.observation.state !== "orphaned") runtimeUnknownAgentIds.add(agent.agentId);
  }
  const runtimeUnknownAgents = runtimeUnknownAgentIds.size;
  const dashboardRows = [...activeRows, ...terminalRows, ...idleRows];
  // Keep the immutable cards' buckets intact. Current clients opt into one
  // history list; an idle Agent without a recorded turn has nothing to show.
  const overviewRows = new Map<string, DashboardRow>();
  for (const row of dashboardRows) {
    if (row.bucket === "idle" && !row.latestTurn) continue;
    let normalized: DashboardRow = row.bucket === "idle"
      ? { ...row, bucket: "recent", status: row.latestTurn!.status }
      : row;
    if (row.status === "background-process-running" && row.latestTurn &&
      dashboardSummaryCategory(row.latestTurn.status) === "problems") {
      normalized = { ...normalized, status: row.latestTurn.status };
    }
    if (!overviewRows.has(row.rowKey)) overviewRows.set(row.rowKey, normalized);
  }
  const acknowledgedJobs = jobs.admissionStateStore.workHistory.acknowledgedJobIds(scopeId);
  const categoryFor = (row: DashboardRow) => {
    const agentId = agentIdByRowKey.get(row.rowKey);
    if (row.status === "failed" || row.status === "interrupted") {
      const latest = agentId ? latestJobByAgent.get(agentId) || latestArchivedJobByAgent.get(agentId) : undefined;
      if (Date.parse(row.latestTurn?.endedAt || row.updatedAt) < now - ISSUE_ATTENTION_DAYS * 86400_000 ||
          latest && acknowledgedJobs.has(latest.jobId)) return null;
    }
    return dashboardSummaryCategory(row.status);
  };
  const responseRequired = [...overviewRows.values()]
    .filter(row => categoryFor(row) === "response-required").length;
  const legacyProblems = [...overviewRows.values()]
    .filter(row => categoryFor(row) === "problems").length;
  let problemCollection: z.infer<typeof dashboardProblemsOutputSchema> | undefined;
  if (problemQuery) {
    type Entry = Omit<z.infer<typeof dashboardProblemOutputSchema>, "row"> & {
      jobId?: string;
      projectRow:()=>DashboardRow;
    };
    const entries: Entry[] = [];
    const fullJobs = new Map(allJobs.map(job => [job.jobId,job]));
    const archivedById = new Map(archivedJobs.map(job => [job.jobId,job]));
    const automaticSummary = (record: (typeof automaticRecords)[number] | undefined) => record
      ? {kind:record.kind,state:record.state,attempts:record.attempts,reason:record.reason,...(record.evidence ? {evidence:record.evidence} : {})} : undefined;
    const retainedProblemRow = (retained: DashboardRetainedJobSummary): DashboardRow => {
      const agent = retained.agentId ? agentById.get(retained.agentId) : undefined;
      const thread = currentThreadFor(retained.agentId);
      const session = currentSessionFor(retained.agentId);
      const turn = turnForArchivedJob(retained);
      const conversationUrl = scopeResolver.conversationUrl(retained.scopeId);
      const codexThreadUrl = codexThreadUrlFor(thread,session);
      return {rowKey:dashboardRowKey(retained.agentId,retained.jobId),activityKey:turn.activityKey!,
        conversationKey:dashboardConversationKey(retained.scopeId),sessionAlias:dashboardSessionAlias(retained.scopeId),
        ...(conversationUrl ? {conversationUrl} : {}),...(codexThreadUrl ? {codexThreadUrl} : {}),
        bucket:"recent",...dashboardProjectIdentity(thread),agentName:dashboardAgentName(agent?.agentName),
        activityTitle:turn.activityTitle,status:turn.status,createdAt:turn.startedAt || turn.updatedAt,updatedAt:turn.updatedAt,
        elapsedMs:turn.durationMs || 0,backgroundProcessCount:0,controlKind:null,latestTurn:turn,history:[],historyCount:0};
    };
    for (const record of problemJobRecords) {
      const job = fullJobs.get(record.jobId);
      const acknowledgedAt = record.acknowledgedAt ? new Date(record.acknowledgedAt).toISOString() : null;
      entries.push({problemKey:record.problemKey,revision:record.revision,kind:"failed",source:"execution",
        review:acknowledgedAt ? "acknowledged" : "pending",acknowledgedAt,observedAt:new Date(record.updatedAt).toISOString(),
        reason:job?.error ? redactSensitiveText(job.error).slice(0,1000) : null,
        automatic:automaticSummary(automaticRecords.find(automatic => automatic.jobId === record.jobId)),
        canAcknowledge:!acknowledgedAt,canUnacknowledge:Boolean(acknowledgedAt),canRecheck:false,canRetryStop:false,
        jobId:record.jobId,
        projectRow:() => {
          if (job) return {...jobRow(job,"recent"),controlKind:null,history:[],historyCount:0};
          const retained: DashboardRetainedJobSummary = archivedById.get(record.jobId) || {
            jobId:record.jobId,scopeId:record.scopeId,activityId:record.activityId,agentId:record.agentId || undefined,
            status:record.status,updatedAt:record.updatedAt
          };
          return retainedProblemRow(retained);
        }});
    }
    const rowByAgent = new Map([...activeRows,...terminalRows,...idleRows].map(row => [row.rowKey,row]));
    for (const agent of allAgents) {
      let row = rowByAgent.get(dashboardRowKey(agent.agentId));
      const runtime = runtimeByAgent.get(agent.agentId);
      const thread = currentThreadFor(agent.agentId);
      const cachedRuntime = thread ? dashboardRuntimeCaches.get(upstream)?.get(dashboardRuntimeCacheKey(thread)) : undefined;
      const runtimeProblem = row && ["liveness-unknown","orphaned","termination-failed"].includes(row.status);
      // Last-good display details may be retained through an outage. A fresh
      // failed inspection still makes the current incident actionable now.
      const inspectionFailed = runtime && (runtime.state === "unknown" || runtime.backgroundProcessState === "unknown") ||
        cachedRuntime?.stamp === dashboardRuntimeStamp(agent,jobs.observedLatestJobForAgent(agent.agentId)) && cachedRuntime.unavailable;
      if (!runtimeProblem && !inspectionFailed) continue;
      if (!row) {
        const thread = currentThreadFor(agent.agentId);
        row = {rowKey:dashboardRowKey(agent.agentId),activityKey:dashboardActivityKey(undefined,agent.agentId),
          conversationKey:dashboardConversationKey(agent.scopeId),sessionAlias:dashboardSessionAlias(agent.scopeId),
          conversationUrl:scopeResolver.conversationUrl(agent.scopeId),bucket:"active",...dashboardProjectIdentity(thread),
          agentName:dashboardAgentName(agent.agentName),activityTitle:null,status:"liveness-unknown",
          createdAt:new Date(agent.createdAt).toISOString(),updatedAt:new Date(agent.updatedAt).toISOString(),
          elapsedMs:0,backgroundProcessCount:runtime?.backgroundProcessCount || 0,controlKind:null};
      }
      const identity = dashboardRuntimeProblemIdentity(jobs,agent);
      const resolvedAt = agent.lifecycle === "orphaned" && !agent.currentJobId && !inspectionFailed && runtime?.state !== "busy" && !(runtime?.backgroundProcessCount || 0)
        ? jobs.admissionStateStore.workHistory.runtimeResolution(agent.agentId,identity.revision) : null;
      const kind = row.status === "termination-failed" ? "termination-failed" as const
        : row.status === "orphaned" ? "orphaned" as const : "unknown" as const;
      const currentJob = agent.currentJobId ? jobs.get(agent.currentJobId) : undefined;
      const observed = inspectionFailed ? cachedRuntime?.attemptedAt : cachedRuntime?.observedAt;
      const runtimeRow = {...row,controlKind:null,status:kind === "unknown" ? "liveness-unknown" as const : row.status,
        history:[],historyCount:0};
      entries.push({problemKey:problemKey("runtime",agent.agentId),revision:identity.revision,kind,source:"runtime",
        review:resolvedAt ? "acknowledged" : "pending",acknowledgedAt:resolvedAt ? new Date(resolvedAt).toISOString() : null,
        observedAt:new Date(observed || agent.updatedAt).toISOString(),
        reason:currentJob?.error ? redactSensitiveText(currentJob.error).slice(0,1000) : null,
        automatic:automaticSummary(automaticRecords.find(automatic => automatic.key === (kind === "termination-failed" && currentJob
          ? automaticRecoveryKey("retry-stop",[currentJob.jobId,currentJob.workerId,currentJob.workerGeneration,currentJob.upstreamRequestId,currentJob.cancelRequestedAt])
          : jobs.admissionStateStore.automaticRecovery.recheckCandidate(recheckRecoveryIdentity(jobs,agent))?.key))),
        canAcknowledge:false,canUnacknowledge:false,canRecheck:!resolvedAt && Boolean(thread && backendSupports(thread.backendKind,"supportsThreadInspection")),
        canRetryStop:currentJob?.status === "termination-failed" && Boolean(identity.stopImpact),
        ...(identity.stopImpact ? {stopImpact:identity.stopImpact} : {}),projectRow:()=>runtimeRow});
    }
    if (problemQuery.view) for (const record of automaticRecords) {
      const agent = agentById.get(record.agentId);
      if (!agent) continue;
      const job = record.jobId ? fullJobs.get(record.jobId) : undefined;
      const fallback = rowByAgent.get(dashboardRowKey(record.agentId));
      if (!record.jobId && !fallback) continue;
      entries.push({problemKey:problemKey("automatic",record.key),revision:problemRevision(record),
        kind:record.kind === "retry-stop" ? "termination-failed" : record.kind === "recheck" ? "unknown" : "failed",
        source:"recovery",review:"automatic",acknowledgedAt:null,observedAt:new Date(record.updatedAt).toISOString(),reason:null,
        automatic:automaticSummary(record),canAcknowledge:false,canUnacknowledge:false,canRecheck:false,canRetryStop:false,
        ...(record.jobId ? {jobId:record.jobId} : {}),
        projectRow:()=>job ? {...jobRow(job,"recent"),controlKind:null,history:[],historyCount:0}
          : record.jobId && archivedById.has(record.jobId)
            ? retainedProblemRow(archivedById.get(record.jobId)!)
            : {...fallback!,controlKind:null,history:[],historyCount:0}});
    }
    entries.sort((a,b) => Date.parse(b.observedAt)-Date.parse(a.observedAt) || a.problemKey.localeCompare(b.problemKey));
    const filtered = entries.filter(entry => (problemQuery.view === "actionable" ? entry.source === "runtime" && entry.review === "pending"
      : problemQuery.view === "history" ? entry.source === "execution"
      : problemQuery.view === "automatic" ? entry.source === "recovery" : entry.review === problemQuery.review) &&
      (problemQuery.kind === "all" || entry.kind === problemQuery.kind));
    const maximumOffset = filtered.length ? Math.floor((filtered.length-1)/limit)*limit : 0;
    const offset = Math.min(problemQuery.offset,maximumOffset);
    const selectedEntries = filtered.slice(offset,offset+limit);
    const selectedJobIds = selectedEntries.flatMap((entry) => entry.jobId ? [entry.jobId] : []);
    for (const retained of jobs.admissionStateStore.listDashboardRetainedJobsByIds(
      selectedJobIds,
      scopeId
    )) archivedById.set(retained.jobId, retained);
    for (const [jobId, summary] of jobs.admissionStateStore.dashboardJobSummaries(selectedJobIds)) {
      summaryCache.set(jobId, summary);
    }
    const page = selectedEntries.map(({projectRow,jobId:_jobId,...entry}) => ({...entry,row:projectRow()}));
    problemCollection = {query:{...problemQuery,offset},revision:problemRevision(filtered.map(entry => [entry.problemKey,entry.revision,entry.review])),
      reviewableCount:entries.filter(entry => entry.canAcknowledge).length,
      pendingCount:entries.filter(entry => entry.review === "pending" && (!problemQuery.view || entry.source === "runtime")).length,
      acknowledgedCount:entries.filter(entry => entry.review === "acknowledged").length,rows:page,
      ...(problemQuery.view ? {historyCount:entries.filter(entry => entry.source === "execution").length,
        automaticCount:entries.filter(entry => entry.source === "recovery").length} : {}),
      page:{offset,limit,total:filtered.length,returned:page.length,hasPrevious:offset>0,hasNext:offset+page.length<filtered.length}};
  }
  const problems = problemCollection?.pendingCount ?? legacyProblems;
  const currentRows = problemQuery ? activeRows.filter(row => dashboardSummaryCategory(row.status) !== "problems") : activeRows;
  const overviewActive: DashboardRow[] = [];
  const overviewTerminal: DashboardRow[] = [];
  for (const row of overviewRows.values()) {
    const category = categoryFor(row);
    if (problemQuery && (statusFilter === "problems" || row.bucket === "active" && dashboardSummaryCategory(row.status) === "problems")) continue;
    if (statusFilter && statusFilter !== "all" &&
      (statusFilter === "background" ? row.backgroundProcessCount <= 0 : category !== statusFilter)) continue;
    if (row.bucket === "active") {
      overviewActive.push({ ...row, bucket: "active" });
    } else {
      overviewTerminal.push(row);
    }
  }
  overviewActive.sort((left, right) =>
    dashboardStatusPriority(left.status) - dashboardStatusPriority(right.status) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.rowKey.localeCompare(right.rowKey));
  overviewTerminal.sort((left, right) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.rowKey.localeCompare(right.rowKey));
  const statusRows = [...overviewRows.values()]
    .filter((row) => {
      const category = categoryFor(row);
      if (statusFilter && statusFilter !== "all") {
        return statusFilter === "background"
          ? row.backgroundProcessCount > 0
          : category === statusFilter;
      }
      return category !== null || row.backgroundProcessCount > 0;
    })
    .sort((left, right) => {
      const bucketOrder = left.bucket === "active" ? 0 : 1;
      const rightBucketOrder = right.bucket === "active" ? 0 : 1;
      return bucketOrder - rightBucketOrder ||
        (left.bucket === "active"
          ? dashboardStatusPriority(left.status) - dashboardStatusPriority(right.status) ||
            Date.parse(left.createdAt) - Date.parse(right.createdAt)
          : Date.parse(right.updatedAt) - Date.parse(left.updatedAt)) ||
        left.rowKey.localeCompare(right.rowKey);
    })
    .map((row) => ({ ...row, history: [], historyCount: row.historyCount || 0 }));
  const activePage = dashboardActivityPage(
    includeHistory ? statusFilter === undefined ? activeRows : overviewActive : [],
    0,
    100
  );
  const terminalPage = dashboardActivityPage(
    includeHistory ? statusFilter === undefined ? terminalRows : overviewTerminal : [],
    terminalOffset,
    limit
  );
  const idlePage = dashboardActivityPage(
    includeHistory ? statusFilter === undefined ? idleRows : [] : [],
    idleOffset,
    limit
  );
  for (const row of [...activePage.rows, ...terminalPage.rows, ...idlePage.rows, ...statusRows]) {
    const agentId = agentIdByRowKey.get(row.rowKey);
    if (agentId) visibleAgentIdsOut?.add(agentId);
  }
  const weeklyUsage = enrichment?.weeklyUsage || cachedCodexWeeklyUsage(upstream);
  const scopedProjectIds = scopeId ? new Set([
    ...allJobs.map(job => job.projectId),
    ...listAllScopedActivities(jobs, scopeId).map(activity => activity.projectId),
    ...allAgents.map(agent => currentThreadFor(agent.agentId)?.projectId)
  ].filter((id): id is string => Boolean(id))) : undefined;
  const trackedProjects = jobs.admissionStateStore
    .getProjectRegistrySnapshot()
    .projects
    .filter((project) => project.archivedAt === undefined &&
      (!scopedProjectIds || scopedProjectIds.has(project.id)))
    .length;

  return dashboardViewOutputSchema.parse({
    kind: "dashboard",
    ...(problemCollection ? {problems:problemCollection} : {}),
    historyPolicy: jobs.admissionStateStore.workHistory.policy(preferences.historyRetentionDays),
    generatedAt: new Date(now).toISOString(),
    scope: scopeId ? "conversation" : "bridge-wide",
    ...(statusFilter !== undefined ? { statusFilter } : {}),
    statusSource: "codex-runtime-only",
    coverage: "bridge-known-retained",
    enrichment: enrichment?.summary || cachedDashboardEnrichment(upstream, runtimeCacheCandidates),
    weeklyUsage,
    counts: {
      trackedProjects,
      trackedConversations: scopeIds.size,
      retainedJobs: allJobs.length + archivedCounts.total,
      active: currentRows.length,
      running: activeRows.filter((row) => row.status === "running").length,
      inputRequired: activeRows.filter((row) => row.status === "input-required").length,
      approvalRequired: activeRows.filter((row) => row.status === "approval-required").length,
      terminating: activeRows.filter((row) => row.status === "terminating").length,
      needsAttention: statusFilter === undefined ? attentionKeys.size : responseRequired + problems,
      responseRequired,
      problems,
      backgroundProcesses,
      backgroundProcessAgents,
      runtimeUnknownAgents,
      runtimeProbeSkippedAgents,
      completed: allJobs.filter((job) => job.status === "completed").length + archivedCounts.completed,
      failed: allJobs.filter((job) => job.status === "failed").length + archivedCounts.failed,
      interrupted: allJobs.filter((job) => job.status === "interrupted").length + archivedCounts.interrupted,
      cancelled: allJobs.filter((job) => job.status === "cancelled").length + archivedCounts.cancelled,
      idleAgents: idleRows.length,
      orphanedAgents: allAgents.filter(
        (agent) =>
          agent.lifecycle === "orphaned" || runtimeByAgent.get(agent.agentId)?.state === "orphaned"
      ).length
    },
    activeRows: activePage.rows,
    terminalRows: terminalPage.rows,
    idleRows: idlePage.rows,
    statusRows,
    statusRowsComplete: true,
    historyIncluded: includeHistory,
    pagination: {
      active: activePage.page,
      terminal: terminalPage.page,
      idle: idlePage.page
    },
    uiLocalePreference: preferences.uiLocalePreference
  });
}

function dashboardViewResult(
  view: DashboardView,
  locale: string | undefined,
  contract: typeof dashboardModelResultContract | typeof dashboardAppResultContract
): ToolResult {
  const effectiveLocale = resolvePreferredUiLocale(view.uiLocalePreference, locale);
  const localeHydration = {
    "openai/locale": effectiveLocale,
    hostLocale: locale || null
  };
  if (contract === dashboardModelResultContract) {
    const structured = dashboardModelOutputSchema.parse({
      kind: "dashboard",
      scope: "bridge-wide",
      readOnly: true,
      statusSource: "codex-runtime-only",
      summary:
        `${view.counts.trackedConversations} tracked retained conversations; ` +
        `${view.counts.active} active; ${view.counts.running} running; ` +
        `${view.counts.needsAttention} needing attention; ` +
        `${view.counts.backgroundProcesses} confirmed background processes; ` +
        `${view.counts.runtimeProbeSkippedAgents} App Server runtime checks deferred. ` +
        `Generated ${view.generatedAt}; bounded details are in the card.`
    });
    return contractedToolResult(
      dashboardModelResultContract,
      view,
      structured,
      {
        text:
          `Codex overview: ${view.counts.trackedConversations} tracked conversations, ` +
          `${view.counts.active} active, ${view.counts.needsAttention} needing attention, ` +
          `${view.counts.backgroundProcesses} confirmed background processes, ` +
          `${view.counts.runtimeProbeSkippedAgents} App Server runtime checks deferred. ` +
          "Open the card for bounded details."
      },
      { appHydration: localeHydration }
    );
  }
  const privateView = validateDashboardViewPrivateMetadata({
    kind: "codex/dashboardView",
    version: DASHBOARD_PRIVATE_METADATA_CONTRACT_VERSION,
    purpose: "bridge-wide-read-only-hydration",
    view
  });
  const appHydration = {
    [DASHBOARD_VIEW_METADATA_KEY]: privateView,
    ...localeHydration
  };
  return contractedToolResult(
    dashboardAppResultContract,
    view,
    view,
    {
      text:
        `Codex overview refreshed: ${view.counts.active} active, ` +
        `${view.counts.needsAttention} needing attention, ` +
        `${view.counts.backgroundProcesses} background processes.`
    },
    { appHydration }
  );
}

function listAllScopedActivities(jobs: CodexJobRegistry, scopeId: string): BridgeActivity[] {
  const total = jobs.activityCount(scopeId);
  const activities: BridgeActivity[] = [];
  while (activities.length < total) {
    const page = jobs.listActivities(scopeId, 1_000, activities.length);
    if (page.length === 0) break;
    activities.push(...page);
  }
  return activities;
}

type DashboardExecution = {
  model: string;
  modelDisplayName?: string;
  reasoningEffort: string;
  serviceTier?: string;
  reroutedModel?: string;
  reroutedModelDisplayName?: string;
  isCurrent: boolean;
};

function dashboardExecutionForJob(
  job: CodexJob | undefined,
  modelCatalog: CodexModelCatalogProvider
): DashboardExecution | undefined {
  const selection = job?.executionDecision?.effectiveSelection;
  if (!job || !selection) return undefined;
  const reroutedModel = [...job.publicEvents].reverse().find((event) =>
    event.type === "model" &&
    event.details?.kind === "rerouted" &&
    typeof event.details.toModel === "string" &&
    event.details.toModel.trim()
  )?.details?.toModel;
  return dashboardExecutionForSelection(
    selection,
    job.backendKind,
    modelCatalog,
    isActiveActivityJobStatus(job.status),
    typeof reroutedModel === "string" ? reroutedModel : undefined
  );
}

function dashboardExecutionForSelection(
  selection: Pick<ModelSelection, "model" | "reasoningEffort" | "serviceTier">,
  backendKind: string | undefined,
  modelCatalog: CodexModelCatalogProvider,
  isCurrent: boolean,
  reroutedModel?: string
): DashboardExecution {
  const catalog = modelCatalog.getCachedCatalog?.({
    backendKind: isCodexBackendKind(backendKind) ? backendKind : "mcp-server"
  });
  const displayNameFor = (modelId: string): string =>
    catalog?.models.find((entry) => entry.id === modelId)?.displayName || modelId;
  const modelDisplayName = displayNameFor(selection.model);
  const normalizedReroutedModel =
    typeof reroutedModel === "string" && reroutedModel !== selection.model
      ? reroutedModel
      : undefined;
  const reroutedModelDisplayName = normalizedReroutedModel
    ? displayNameFor(normalizedReroutedModel)
    : undefined;
  const reasoningEffort = selection.reasoningEffort.trim().toLowerCase();
  return {
    model: selection.model,
    ...(modelDisplayName !== selection.model ? { modelDisplayName } : {}),
    reasoningEffort,
    ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
    ...(normalizedReroutedModel ? { reroutedModel: normalizedReroutedModel } : {}),
    ...(reroutedModelDisplayName && reroutedModelDisplayName !== normalizedReroutedModel
      ? { reroutedModelDisplayName }
      : {}),
    isCurrent
  };
}

function appServerTurnId(job: CodexJob): string | undefined {
  return backendSupports(job.backendKind, "supportsPreciseCancellation") ? job.upstreamRequestId : undefined;
}

function cancellationTargetForJob(job: CodexJob): BeginCancellationOperationInput["target"] {
  return {
    kind: "job",
    jobId: job.jobId,
    activityId: job.activityId,
    ...(job.agentId ? { agentId: job.agentId } : {}),
    ...(job.threadId ? { threadId: job.threadId } : {}),
    ...(appServerTurnId(job) ? { turnId: appServerTurnId(job) } : {})
  };
}

function metadataString(meta: unknown, key: string): string | undefined {
  if (!isRecord(meta)) return undefined;
  const value = meta[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function correlationDigest(domain: string, value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  return createHash("sha256").update(domain).update("\0").update(normalized).digest("hex");
}

function boundedCancellationFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500) || "Cancellation failed.";
}

function cancellationFailureMessage(result: unknown): string {
  if (isRecord(result) && typeof result.message === "string" && result.message) {
    return result.message;
  }
  return "CANCELLATION_FAILED: The durable cancellation operation previously failed.";
}

function formatJobActivity(
  job: CodexJob,
  staleAfterMs: number
): {
  health: "running" | "no-progress-observed" | "liveness-unknown" | "terminating" | "termination-failed" | "terminal" | "worker-lost" | "orphaned";
  processLiveness: CodexJob["trackingState"] | "terminating" | "termination-unconfirmed";
  lastProgressAt: string;
  idleMs: number;
  progressObserved: boolean;
  lastProgress?: Progress;
  staleAfterMs: number;
} {
  const idleMs = Math.max(0, Date.now() - job.lastProgressAt);
  return {
    health: job.trackingState === "orphaned"
      ? "orphaned"
      : job.trackingState === "worker-lost" && job.status === "interrupted"
        ? "worker-lost"
        : isTerminalActivityJobStatus(job.status)
      ? "terminal"
      : job.status === "terminating"
        ? "terminating"
      : job.status === "termination-failed"
          ? "termination-failed"
          : job.trackingState === "liveness-unknown"
            ? "liveness-unknown"
          : idleMs >= staleAfterMs
            ? "no-progress-observed"
            : "running",
    processLiveness:
      job.status === "terminating"
        ? "terminating"
        : job.status === "termination-failed"
          ? "termination-unconfirmed"
          : job.trackingState,
    lastProgressAt: new Date(job.lastProgressAt).toISOString(),
    idleMs,
    progressObserved: Boolean(job.lastProgress),
    ...(job.lastProgress ? { lastProgress: job.lastProgress } : {}),
    staleAfterMs
  };
}

function threadExclusiveKey(threadId: string): string {
  return `thread:${threadId}`;
}

function agentExclusiveKey(agentId: string): string {
  return `agent:${agentId}`;
}

function selectionKeyFor(
  scopeId: string,
  cwd: string,
  sandbox: SandboxMode,
  selection: ModelSelection
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        scopeId,
        cwd,
        sandbox,
        model: selection.model || null,
        reasoningEffort: selection.reasoningEffort || null,
        serviceTier: selection.serviceTier || null
      })
    )
    .digest("hex");
}

function activitySelectionKey(
  activityId: string,
  compatibleSelectionKey: string
): string {
  return `activity:${activityId}:${compatibleSelectionKey}`;
}

function scopeIdSchema() {
  return z
    .string()
    .trim()
    .regex(SCOPE_ID_PATTERN, "Expected a UUID-formatted conversation or request id.")
    .transform((value) => value.toLowerCase());
}

function modelChoiceZod() {
  return z.strictObject({
    model: z.string().trim().min(1).max(200),
    reasoningEffort: z.string().trim().min(1).max(100)
  });
}

function modelPolicyZod(): z.ZodType<ModelPolicy> {
  const constraints = z.strictObject({ allowDelegation: z.boolean() });
  return z.union([
    z.strictObject({
      mode: z.literal("fixed"),
      selection: modelChoiceZod(),
      constraints
    }),
    z.strictObject({
      mode: z.literal("automatic"),
      allowedSelections: z.union([
        z.strictObject({ kind: z.literal("catalog-visible") }),
        z.strictObject({ kind: z.literal("explicit"), selections: z.array(modelChoiceZod()).min(1).max(500) })
      ]),
      constraints
    })
  ]) as z.ZodType<ModelPolicy>;
}

function editableModelPolicyZod() {
  const constraints = z.strictObject({ allowDelegation: z.boolean() });
  return z.union([
    z.strictObject({
      mode: z.literal("fixed"),
      selection: modelChoiceZod(),
      constraints
    }),
    z.strictObject({
      mode: z.literal("automatic"),
      allowedSelections: z.union([
        z.strictObject({ kind: z.literal("catalog-visible") }),
        z.strictObject({ kind: z.literal("explicit"), selections: z.array(modelChoiceZod()).min(1).max(500) })
      ]),
      constraints
    })
  ]);
}

function verbatimInput(maxCharacters: number, field: string) {
  return z.string().refine((value) => {
    try {
      verbatimText(value, {
        field,
        maxCharacters,
        rejectControlCharacters: false
      });
      return true;
    } catch {
      return false;
    }
  }, `${field} must contain at most ${maxCharacters} Unicode characters.`);
}

function codexTaskInputSchema(
  config: BridgeConfig,
  executionEnvelopeRefValue: string
): z.ZodType<CodexTaskArgs> {
  const activity = z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("existing"),
      id: scopeIdSchema().describe("Exact open Activity id in this conversation scope.")
    }),
    z.strictObject({
      mode: z.literal("new"),
      continuationOf: scopeIdSchema().optional()
        .describe("Optional prior Activity id for lineage; the source remains immutable."),
      title: z.string().trim().min(1).max(120).optional()
        .describe("Optional user-facing title. The bridge uses a neutral fallback when omitted."),
      policy: z.strictObject({
        kind: z.enum(ACTIVITY_KINDS).optional()
          .describe("Display classification only; defaults to other."),
        handoff: z.enum(ACTIVITY_HANDOFF_POLICIES).optional()
          .describe("Completion handoff policy; defaults to none."),
        completion: z.enum(ACTIVITY_COMPLETION_TRIGGERS).optional()
          .describe("Completion trigger; defaults to manual.")
      }).optional().describe(
        "Policy committed atomically when the Activity is created. Existing policy changes use codex_activity_update."
      )
    })
  ]).describe("Choose an existing Activity or describe one new Activity. Omission creates a new Activity with defaults.");
  const agent = z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("existing"),
      id: scopeIdSchema().describe("Exact bridge-managed Agent id."),
      context: z.enum(AGENT_CONTEXT_MODES).optional().describe(
        "Continue the current thread, fork it, or deliberately start fresh. Defaults to continue when resumable."
      ),
      handoffSummary: verbatimInput(4_000, "Handoff summary").optional().describe(
        "Required only when context='fresh' moves an existing Agent from its pinned backend to the configured backend. This explicit bounded summary is the only context copied; the transcript and backend state are not migrated."
      )
    }),
    z.strictObject({
      mode: z.literal("new"),
      name: z.string().trim().min(1).max(80).optional().describe(
        "Optional display name. The bridge generates a neutral scope-unique name when omitted; new Agents always start fresh."
      )
    })
  ]).describe(
    "Choose an exact existing Agent or create one. Omission creates an Agent for new Activities and reuses the sole candidate for existing Activities."
  );
  const requestId = scopeIdSchema().describe(
    "Unique idempotency UUID for one logical Codex call. Keep it through response loss or parent-result replay; reuse it only for an exact retry. Never reuse it to group different tasks or multiple calls in one GPT response."
  );
  const prompt = verbatimInput(config.maxPromptChars, "Codex prompt").describe("Instruction for Codex.");
  const project = currentProjectSelectionZod().optional().describe(
    "Exact current selector for new/fresh work. Omit for continue/fork; never send a path or private project ID."
  );
  const publicCommon = {
    scopeId: scopeIdSchema()
      .optional()
      .describe("Conversation UUID for hosts that do not supply scoped MCP metadata."),
    taskContractVersion: z.literal(CODEX_TASK_INPUT_CONTRACT_VERSION).describe(
      "Stable codex_task input contract generation."
    ),
    executionEnvelopeRef: z.literal(executionEnvelopeRefValue).describe(
      "Opaque installation/operator envelope. Settings, catalog, and project changes do not change this value."
    ),
    requestId,
    prompt,
    project,
    activity: activity.optional(),
    agent: agent.optional(),
    approvedFollowups: z.array(z.strictObject({
      prompt: verbatimInput(config.maxPromptChars, "Approved followup prompt")
    })).min(1).max(8).optional().describe(
      "Exact prompts already explicitly approved before this Job. The bridge issues opaque followupIds and canonical requestIds, returned in declaration order by admission and exact status reads. Each may continue this Activity/Agent once after result review; never name or recreate an ID or infer approval from output."
    ),
    followup: z.strictObject({
      followupId: z.string().regex(FOLLOWUP_ID_PATTERN),
      reviewedVersion: z.number().int().positive()
    }).optional().describe(
      "Reference the bridge-issued followupId after reviewing its exact predecessor result. Supply the exact approved prompt and current reviewedVersion, and reuse the returned canonical requestId; other caller requestIds also converge to that same Job. Never invent an ID. Scope, project, permission, model and context changes are forbidden."
    ),
    selection: modelChoiceZod().optional().describe(
      "Exact model/reasoning choice discovered through codex_models. Required at runtime for automatic-policy new Activity, new Agent, and fresh context; automatic continue/fork may omit it to inherit the thread selection. Fixed policy must omit it."
    )
  };
  const projected = z.strictObject(publicCommon);
  const projectedJsonSchema = jsonSchemaBody(projected);
  const projectedContractBytes = Buffer.byteLength(JSON.stringify(projectedJsonSchema), "utf8") +
    Buffer.byteLength(JSON.stringify(jsonSchemaBody(codexTaskOutputSchema, "output")), "utf8");
  if (projectedContractBytes > CODEX_TASK_DESCRIPTOR_MAX_JSON_BYTES) {
    throw new Error(
      `CODEX_TASK_DESCRIPTOR_TOO_LARGE: ${projectedContractBytes} bytes exceeds the ${CODEX_TASK_DESCRIPTOR_MAX_JSON_BYTES}-byte bounded contract.`
    );
  }
  return projected as z.ZodType<CodexTaskArgs>;
}

function currentProjectSelectionZod() {
  return z.strictObject({
    name: projectNameInput(),
    projectRef: z.string().refine((value) => {
      try {
        normalizeProjectRef(value);
        return true;
      } catch {
        return false;
      }
    }, "Invalid opaque project reference."),
    projectRevision: z.number().int().min(1)
  });
}

function projectNameInput(): z.ZodType<string> {
  // Zod's string max counts UTF-16 code units while the registry contract
  // counts Unicode code points. Two code units per admitted code point keeps
  // the published wire schema bounded without rejecting valid astral names;
  // the refinement below remains the exact authority.
  return z.string().max(PROJECT_NAME_MAX_LENGTH * 2).refine((value) => {
    try {
      normalizeProjectName(value);
      return true;
    } catch {
      return false;
    }
  }, `Use 1-${PROJECT_NAME_MAX_LENGTH} visible Unicode characters.`);
}

function jsonSchemaBody(
  schema: z.ZodType,
  io: "input" | "output" = "input"
): Record<string, unknown> {
  const { $schema: _schema, ...body } = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io
  });
  return body;
}

type TaskRequestHashInput = {
  args: CodexTaskArgs;
  activityRequest: ActivityTaskRequest;
  scopeId: string;
  projectRequest?: ProjectSelection;
  projectId?: string;
  cwd: string;
  sandbox: SandboxMode;
  operation: CodexJobOperation;
  backendKind: CodexBackendKind;
  effectiveSelection: ModelSelection;
  agentId?: string;
  contextMode: AgentContextMode;
  sourceThreadId?: string;
  backendHandoff?: BackendHandoff | BackendHandoffAudit;
};

/** Current request identity commits the public task envelope and admission-time
 * execution semantics. It deliberately excludes independent Bridge skill
 * library state, card presentation, and other mutable UI state. */
function resolveTaskRouting(input: TaskRequestHashInput): CodexRouting {
  const activityCreation = input.args.activityId
    ? null
    : {
        title: canonicalActivityTitle(input.activityRequest.activityTitle || "Codex activity"),
        kind: input.activityRequest.activityKind || "other",
        handoffPolicy: input.activityRequest.handoffPolicy || "none",
        completionTrigger: input.activityRequest.completionTrigger || "manual"
      };
  const agentCreation = input.args.agentName
    ? { name: canonicalAgentName(input.args.agentName).agentName }
    : null;
  const requestHash = createHash("sha256")
    .update(
      canonicalJson({
        version: CURRENT_TASK_REQUEST_HASH_VERSION,
        scopeId: input.scopeId,
        prompt: input.args.prompt,
        ...(input.args.approvedFollowups ? { approvedFollowups: approvedFollowupDigests(input.args.approvedFollowups) } : {}),
        ...(input.args.followup ? { followup: input.args.legacyFollowupIdentity || { followupId: input.args.followup.followupId } } : {}),
        taskContractVersion: CODEX_TASK_INPUT_CONTRACT_VERSION,
        executionEnvelopeRef: input.args.executionEnvelopeRef,
        backendHandoff: input.backendHandoff
          ? backendHandoffAuditForHash(input.backendHandoff, input.args.handoffSummary)
          : input.args.handoffSummary
            ? {
                unadmittedSummarySha256: createHash("sha256")
                  .update(input.args.handoffSummary)
                  .digest("hex")
              }
            : null,
        projectRequest: input.projectRequest
          ? currentProjectSelectionForRequestHash(input.projectRequest)
          : null,
        admittedProject: input.projectId
          ? { projectId: input.projectId, cwd: input.cwd }
          : null,
        routing: {
          activity: input.args.activityId
            ? { mode: "existing", activityId: input.args.activityId }
            : {
                mode: "new",
                continuationOfActivityId: input.args.continuationOfActivityId || null
              },
          agent: input.args.agentName
            ? {
                mode: "new",
                contextMode: input.contextMode,
                sourceThreadId: input.sourceThreadId || null
              }
            : {
                mode: "existing",
                agentId: requireTaskHashAgentId(input.agentId),
                contextMode: input.contextMode,
                sourceThreadId: input.sourceThreadId || null
              }
        },
        execution: {
          operation: input.operation,
          backendKind: input.backendKind,
          cwd: input.cwd,
          sandbox: input.sandbox,
          modelSelection: {
            model: input.effectiveSelection.model,
            reasoningEffort: input.effectiveSelection.reasoningEffort,
            serviceTier: input.effectiveSelection.serviceTier || null
          }
        },
        creation: {
          activity: activityCreation,
          agent: agentCreation,
          assignmentRole: normalizeTaskAssignmentRole(input.args.agentRole)
        }
      })
    )
    .digest("hex");
  return {
    scopeId: input.scopeId,
    requestId: input.args.requestId,
    requestHash,
    requestHashVersion: CURRENT_TASK_REQUEST_HASH_VERSION,
    mcpPrincipal: input.args.mcpPrincipal,
    approvedFollowups: approvedFollowupDigests(input.args.approvedFollowups),
    followup: input.args.followup
  };
}

function backendHandoffAuditForHash(
  handoff: BackendHandoff | BackendHandoffAudit,
  suppliedSummary?: string
): BackendHandoffAudit {
  const summarySha256 = suppliedSummary === undefined
    ? handoff.summarySha256
    : createHash("sha256").update(suppliedSummary).digest("hex");
  return {
    sourceBackend: handoff.sourceBackend,
    targetBackend: handoff.targetBackend,
    sourceThreadId: handoff.sourceThreadId,
    continuity: handoff.continuity,
    summarySha256
  };
}

function currentProjectSelectionForRequestHash(
  selection: ProjectSelection
): Record<string, unknown> {
  return {
    contract: 3,
    name: normalizeProjectName(selection.name),
    projectRef: normalizeProjectRef(selection.projectRef),
    projectRevision: selection.projectRevision
  };
}

function requireTaskHashAgentId(value: string | undefined): string {
  if (!value) throw new Error("Codex task routing requires a resolved Agent identity.");
  return value;
}

function normalizeTaskAssignmentRole(value: string | undefined): string {
  // Assignment role is persisted and hashed only as display metadata. Routing,
  // authorization, context, lifecycle, and handoff decisions must not branch on it.
  if (value === undefined) return "primary";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "primary";
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot hash unsupported JSON value of type ${typeof value}.`);
}

async function buildSettingsView(
  config: BridgeConfig,
  userSettings: UserSettingsStore,
  modelCatalog: CodexModelCatalogProvider,
  refreshModels = false,
  descriptorProjectionUpdated = false,
  developerModeRefreshRequired = false
): Promise<SettingsView> {
  let catalog: CodexModelCatalogSnapshot | undefined;
  let catalogError: string | undefined;
  try {
    catalog = await modelCatalog.getCatalog({
      refresh: refreshModels,
      backendKind: config.defaultBackend
    });
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
  }
  let modelPolicyWarning: string | undefined;
  if (catalog) {
    try {
      validatePolicyAgainstCatalog(
        userSettings.current.modelPolicy,
        catalog,
        config.operatorModelCeiling,
        userSettings.current.revision
      );
      assertPriorityCompatibility(
        userSettings.current.modelPolicy,
        catalog,
        config.operatorModelCeiling,
        userSettings.current.usePriorityServiceTier,
        userSettings.current.revision
      );
      if (isModelPolicySuspended(userSettings.current.modelPolicy, catalog,
        effectiveModelCeiling(catalog, config.operatorModelCeiling, userSettings.current.usePriorityServiceTier))) {
        modelPolicyWarning = ULTRA_DISABLED_NO_SELECTION_WARNING;
      }
    } catch (error) {
      modelPolicyWarning = error instanceof Error ? error.message : String(error);
    }
  }
  const availableAccessStrategies: SettingsView["capabilities"]["availableAccessStrategies"] = [
    "read-only",
    "adaptive"
  ];
  if (
    config.allowDangerFullAccess ||
    userSettings.current.accessStrategy === "always-full"
  ) {
    availableAccessStrategies.push("always-full");
  }
  return {
    historyPolicy: userSettings.historyPolicy,
    modelDescriptionHistoryModelIds: userSettings.modelDescriptionHistoryIds,
    settings: userSettings.current,
    operatorDefaults: userSettings.defaults,
    capabilities: {
      availableAccessStrategies,
      availableUiLocalePreferences: [...UI_LOCALE_PREFERENCES],
      projectAvailability: userSettings.projectRegistry.availability.map(
        ({ project, available }) => ({
          projectId: project.id,
          name: project.name,
          available,
          archived: project.archivedAt !== undefined
        })
      ),
      maxConcurrentJobs: config.maxConcurrentJobs,
      defaultBackend: config.defaultBackend,
      allowWorkspaceWrite: config.allowWorkspaceWrite,
      allowDangerFullAccess: config.allowDangerFullAccess,
      operatorModelCeiling: config.operatorModelCeiling || null,
      persistent: userSettings.persistent
    },
    catalog: {
      source: catalog?.source || null,
      fetchedAt: catalog?.fetchedAt || null,
      validatedAt: catalog?.validatedAt || null,
      fingerprint: catalog?.fingerprint || null,
      cached: catalog?.cached || false,
      stale: catalog?.stale || false,
      lastKnownGood: catalog?.stale || false,
      validation: catalog?.validation || "invalid",
      warning: catalog?.warning || catalogError || null,
      translationCoverage: {
        missingEffortIds: missingReasoningEffortTranslations(
          (catalog?.models || []).flatMap((model) =>
            model.supportedReasoningEfforts.map((entry) => entry.effort)
          )
        )
      },
      models: (catalog?.models || []) as CodexModelDescriptor[]
    },
    warnings: [
      ...config.startupWarnings,
      ...userSettings.loadWarnings,
      ...(modelPolicyWarning ? [modelPolicyWarning] : [])
    ],
    scopeNotice:
      "These settings are shared by every conversation using this bridge instance, not stored per ChatGPT account. Bridge security and operator model ceilings cannot be changed from the card.",
    policyActivation: {
      policyRevision: userSettings.current.settingsRevision,
      executionPolicyActive: true,
      descriptorProjectionUpdated,
      developerModeRefreshRequired
    }
  };
}

async function freshCatalogForPolicy(
  modelCatalog: CodexModelCatalogProvider,
  backendKind: CodexBackendKind,
  policyRevision: number
): Promise<CodexModelCatalogSnapshot> {
  let catalog: CodexModelCatalogSnapshot;
  try {
    catalog = await modelCatalog.getCatalog({ refresh: true, backendKind });
  } catch (error) {
    throw catalogUnavailableError(policyRevision, error);
  }
  if (catalog.stale) {
    throw new ModelPolicyError(
      "MODEL_UNAVAILABLE",
      "A fresh backend model catalog is required before activating a changed model policy.",
      policyRevision,
      ["Keep the existing active policy, restore backend catalog access, and retry the save."]
    );
  }
  return catalog;
}

function settingsViewResult(
  view: SettingsView,
  locale: string | undefined,
  audience: "snapshot" | "mutation"
): ToolResult {
  const effectiveLocale = resolvePreferredUiLocale(view.settings.uiLocalePreference, locale);
  const localizedView = localizeSettingsView(view, locale);
  const validatedEditorView = settingsViewOutputSchema.parse(localizedView);
  return contractedToolResult(
    audience === "snapshot" ? settingsSnapshotResultContract : settingsEditorResultContract,
    view,
    validatedEditorView,
    {
      text: audience === "snapshot"
        ? `Settings refreshed at revisions ${localizedView.settings.settingsRevision}/${localizedView.settings.registryRevision}.`
        : `Settings saved at revisions ${localizedView.settings.settingsRevision}/${localizedView.settings.registryRevision}.`
    },
    { appHydration: {
      // Retained cards still read the metadata copy. Current cards consume the
      // same-call structured editor state; no unused model summary is built.
      "codex/settingsView": validatedEditorView,
      "openai/locale": effectiveLocale,
      hostLocale: locale || null
    } }
  );
}

function admitTaskContractForNewCall(input: {
  args: CodexTaskArgs;
  executionEnvelopeRef: string;
  executionPolicyRef: string;
}): void {
  if (input.args.executionEnvelopeRef !== input.executionEnvelopeRef) {
    throw new ExecutionEnvelopeChangedError();
  }
  // This value is captured after public input validation and never accepted
  // from the caller. It protects every later asynchronous admission boundary.
  input.args.admittedExecutionPolicyRef = input.executionPolicyRef;
}

function refreshStableTaskAdmissionRef(
  args: CodexTaskArgs,
  preferences: BridgeUserSettings,
  admissionCatalogFingerprint: string | null,
  userSettings: UserSettingsStore
): void {
  args.admittedExecutionPolicyRef = userSettings.executionPolicyRef(
    preferences,
    admissionCatalogFingerprint
  );
}

function taskAdmissionPolicyRef(args: CodexTaskArgs): string | undefined {
  return args.admittedExecutionPolicyRef;
}

function assertExecutionPolicyAdmission(input: {
  advertisedRef?: string;
  currentRef: string;
}): void {
  if (input.advertisedRef === input.currentRef) return;
  throw new ExecutionPolicyChangedError(input.currentRef);
}

type ResolvedExecutionDecision = {
  decision: ExecutionDecision;
  admissionCatalogFingerprint: string;
};

async function resolveExecutionDecision(input: {
  config: BridgeConfig;
  upstream: CodexUpstream;
  modelCatalog: CodexModelCatalogProvider;
  preferences: BridgeUserSettings;
  backendKind: CodexBackendKind;
  operation: "start" | "continue";
  requestedSelection?: ModelChoice;
  requestedPolicyRevision?: number;
  currentSelection?: ModelSelection;
  onCatalog?: (catalog: CodexModelCatalogSnapshot) => void;
}): Promise<ResolvedExecutionDecision> {
  let catalog: CodexModelCatalogSnapshot;
  try {
    catalog = await input.modelCatalog.getCatalog({ backendKind: input.backendKind });
  } catch (error) {
    throw catalogUnavailableError(input.preferences.revision, error);
  }
  // Publish the exact catalog used for this decision for Settings and
  // diagnostics. Contract v2 keeps a generic public selection shape, captures
  // this resolved catalog fingerprint privately, and rechecks the saved policy
  // against that same fingerprint before admission.
  input.onCatalog?.(catalog);
  assertPriorityCompatibility(
    input.preferences.modelPolicy,
    catalog,
    input.config.operatorModelCeiling,
    input.preferences.usePriorityServiceTier,
    input.preferences.revision,
    input.requestedSelection
  );
  const capabilities = backendCapabilities(input.upstream, input.backendKind);
  const decision = resolveModelPolicy({
    policyRevision: input.preferences.revision,
    policy: input.preferences.modelPolicy,
    catalog,
    operatorCeiling: effectiveModelCeiling(
      catalog,
      input.config.operatorModelCeiling,
      input.preferences.usePriorityServiceTier
    ),
    backendKind: input.backendKind,
    backendCapabilities: capabilities,
    operation: input.operation,
    requestedSelection: input.requestedSelection,
    requestedPolicyRevision: input.requestedPolicyRevision,
    currentSelection: input.currentSelection
  });
  const effectiveSelection = internalServiceTierSelection(
    decision.effectiveSelection,
    catalog,
    input.preferences.usePriorityServiceTier,
    input.operation,
    capabilities,
    input.currentSelection,
    input.preferences.revision
  );
  return {
    admissionCatalogFingerprint: modelCatalogAdmissionFingerprint(catalog.models),
    decision: {
      ...decision,
      effectiveSelection,
      reason: `${decision.reason} ${effectiveSelection.serviceTier
        ? `The bridge privately applied service tier '${effectiveSelection.serviceTier}'.`
        : "No service-tier override was requested."}`
    }
  };
}

function admissionFingerprintForCatalog(
  catalog?: CodexModelCatalogSnapshot
): string | null {
  return catalog ? modelCatalogAdmissionFingerprint(catalog.models) : null;
}

function assertPriorityCompatibility(
  policy: ModelPolicy,
  catalog: CodexModelCatalogSnapshot,
  operatorCeiling: ModelChoice[] | undefined,
  usePriorityServiceTier: boolean,
  policyRevision: number,
  requestedSelection?: ModelChoice
): void {
  if (!usePriorityServiceTier) return;
  // A deliberately suspended Ultra allowlist remains saveable with Fast on.
  // The model policy resolver rejects execution before any upstream turn.
  if (isModelPolicySuspended(policy, catalog, effectiveModelCeiling(catalog, operatorCeiling, true))) return;
  if (requestedSelection && !priorityServiceTierForModel(catalog, requestedSelection.model)) {
    throw priorityUnavailable(policyRevision, requestedSelection.model);
  }
  const compatible = listAllowedModelSelections(policy, catalog, operatorCeiling)
    .some((selection) => Boolean(priorityServiceTierForModel(catalog, selection.model)));
  if (!compatible) throw priorityUnavailable(policyRevision);
}

function priorityUnavailable(policyRevision: number, model?: string): ModelPolicyError {
  return new ModelPolicyError(
    "MODEL_UNAVAILABLE",
    model
      ? `Priority is enabled, but model ${model} does not expose the Priority/Fast service tier.`
      : "Priority is enabled, but the active model policy has no allowed model with a Priority/Fast service tier.",
    policyRevision,
    ["Disable Priority in Codex settings.", "Choose a model that supports Priority and retry."]
  );
}

function effectiveModelCeiling(
  catalog: CodexModelCatalogSnapshot,
  operatorCeiling: ModelChoice[] | undefined,
  usePriorityServiceTier: boolean
): ModelChoice[] | undefined {
  if (!usePriorityServiceTier) return operatorCeiling;
  const operatorKeys = operatorCeiling
    ? new Set(operatorCeiling.map(modelChoiceKey))
    : undefined;
  return catalog.models.flatMap((model) => {
    if (model.hidden || !priorityServiceTierForModel(catalog, model.id)) return [];
    return model.supportedReasoningEfforts.flatMap(({ effort }) => {
      const selection = { model: model.id, reasoningEffort: effort };
      return !operatorKeys || operatorKeys.has(modelChoiceKey(selection)) ? [selection] : [];
    });
  });
}

function internalServiceTierSelection(
  selection: ModelSelection,
  catalog: CodexModelCatalogSnapshot,
  usePriorityServiceTier: boolean,
  operation: "start" | "continue",
  capabilities: BackendCapabilities,
  currentSelection: ModelSelection | undefined,
  policyRevision: number
): ModelSelection {
  if (
    operation === "continue" &&
    !capabilities.supportsServiceTierOverrideOnContinue &&
    currentSelection &&
    modelChoiceKey(currentSelection) === modelChoiceKey(selection)
  ) {
    return {
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      ...(currentSelection.serviceTier ? { serviceTier: currentSelection.serviceTier } : {})
    };
  }
  if (!usePriorityServiceTier) return { model: selection.model, reasoningEffort: selection.reasoningEffort };
  const serviceTier = priorityServiceTierForModel(catalog, selection.model);
  if (!serviceTier) {
    throw priorityUnavailable(policyRevision, selection.model);
  }
  return { model: selection.model, reasoningEffort: selection.reasoningEffort, serviceTier };
}

function priorityServiceTierForModel(
  catalog: CodexModelCatalogSnapshot,
  modelId: string
): string | undefined {
  const model = catalog.models.find((entry) => entry.id === modelId && !entry.hidden);
  if (!model) return undefined;
  const ids = [model.defaultServiceTier, ...model.serviceTiers.map((tier) => tier.id)]
    .filter((entry): entry is string => Boolean(entry));
  return ids.find((id) => id.toLowerCase() === "priority") ||
    ids.find((id) => id.toLowerCase() === "fast");
}

function catalogUnavailableError(policyRevision: number, error: unknown): ModelPolicyError {
  const detail = error instanceof Error ? error.message : String(error);
  return new ModelPolicyError(
    "MODEL_UNAVAILABLE",
    `The backend model catalog could not be loaded. ${detail}`,
    policyRevision,
    ["Restore backend catalog access and retry.", "Open Codex settings to inspect catalog status."]
  );
}

function backendCapabilities(
  upstream: CodexUpstream,
  backendKind: CodexBackendKind
): BackendCapabilities {
  return upstream.capabilities?.(backendKind) || (backendSupports(backendKind, "supportsTurnSelection")
    ? {
        selectionScope: "turn",
        supportsModelOverrideOnContinue: true,
        supportsEffortOverrideOnContinue: true,
        supportsServiceTierOverrideOnContinue: true,
        supportsFork: false
      }
    : {
        selectionScope: "thread",
        supportsModelOverrideOnContinue: false,
        supportsEffortOverrideOnContinue: false,
        supportsServiceTierOverrideOnContinue: false,
        supportsFork: false
      });
}

function applyModelSelection(
  payload: Record<string, unknown>,
  selection: ModelSelection,
  backendKind: CodexBackendKind
): void {
  payload.model = selection.model;
  payload.config = {
    model_reasoning_effort: selection.reasoningEffort,
  };
  if (backendSupports(backendKind, "supportsTurnSelection") && selection.serviceTier) {
    payload.serviceTier = selection.serviceTier;
  }
}

async function enforceSensitiveFilePreflight(
  config: BridgeConfig,
  cwd: string,
  operation: "run Codex" | "continue Codex" | "fork Codex context"
): Promise<void> {
  if (!config.secretScan) return;
  const sensitiveFiles = await findSensitiveFiles(cwd);
  if (sensitiveFiles.length > 0) {
    const findings = formatSensitiveFileFindings(cwd, sensitiveFiles);
    throw new Error(
      `Refusing to ${operation} because ${sensitiveFiles.length} sensitive-looking file(s) were found in the project folder. Project-relative path(s): ${findings}. Move them outside the project or set CODEX_MCP_BRIDGE_DISABLE_SECRET_SCAN=1 if you accept the risk.`
    );
  }
}

function sanitizeProgress(
  progress: Progress,
  steeringPrompts: readonly string[] = []
): Progress {
  return {
    progress: Number.isFinite(progress.progress) ? progress.progress : 0,
    ...(typeof progress.total === "number" && Number.isFinite(progress.total)
      ? { total: progress.total }
      : {}),
    ...(typeof progress.message === "string"
      ? { message: redactSteeringPromptText(progress.message, steeringPrompts).slice(0, 500) }
      : {})
  };
}

function sanitizePublicEvent(value: unknown): CodexPublicEvent | undefined {
  if (!isRecord(value)) return undefined;
  const types: CodexPublicEvent["type"][] = [
    "agent-message",
    "plan",
    "command",
    "file-change",
    "error",
    "warning",
    "model",
    "context",
    "mcp",
    "collaboration",
    "usage",
    "approval-required",
    "input-required",
    "turn"
  ];
  const phases: CodexPublicEvent["phase"][] = ["started", "updated", "completed", "waiting"];
  if (
    typeof value.eventId !== "string" ||
    !value.eventId ||
    !types.includes(value.type as CodexPublicEvent["type"]) ||
    !phases.includes(value.phase as CodexPublicEvent["phase"]) ||
    !isTimestamp(value.createdAt) ||
    typeof value.summary !== "string"
  ) {
    return undefined;
  }
  const details = sanitizePublicData(value.details, 0);
  return {
    eventId: value.eventId.slice(0, 200),
    type: value.type as CodexPublicEvent["type"],
    phase: value.phase as CodexPublicEvent["phase"],
    createdAt: value.createdAt,
    summary: redactSensitiveText(value.summary).slice(0, 1_000),
    ...(isRecord(details) ? { details } : {})
  };
}

function sanitizePublicEventForJob(
  event: CodexPublicEvent | undefined,
  cwd: string,
  allowedRoots: string[],
  steeringPrompts: readonly string[] = []
): CodexPublicEvent | undefined {
  if (!event) return undefined;
  const replacements = [cwd, ...allowedRoots]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const replacePaths = (value: unknown): unknown => {
    if (typeof value === "string") {
      let result = redactSteeringPromptText(value, steeringPrompts);
      for (const root of replacements) result = result.split(root).join(path.basename(root));
      return result;
    }
    if (Array.isArray(value)) return value.map(replacePaths);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      redactSteeringPromptText(key, steeringPrompts),
      replacePaths(entry)
    ]));
  };
  return {
    ...event,
    summary: replacePaths(event.summary) as string,
    ...(event.details ? { details: replacePaths(event.details) as Record<string, unknown> } : {})
  };
}

function readPendingInteraction(value: unknown): CodexPendingInteraction | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (
    typeof value.interactionId !== "string" ||
    !value.interactionId ||
    (kind !== "command-approval" &&
      kind !== "file-approval" &&
      kind !== "permission-approval" &&
      kind !== "user-input" && kind !== "mcp-elicitation") ||
    typeof value.threadId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.itemId !== "string" ||
    typeof value.summary !== "string"
  ) {
    return undefined;
  }
  const questions = Array.isArray(value.questions)
    ? value.questions
        .filter(isRecord)
        .slice(0, MAX_CODEX_INTERACTION_QUESTIONS)
        .flatMap((question) => {
          if (typeof question.id !== "string" || typeof question.question !== "string") return [];
          return [{
            id: question.id.slice(0, 200),
            header: typeof question.header === "string" ? question.header.slice(0, 80) : "Input",
            question: redactSensitiveText(question.question).slice(0, 1_000),
            isSecret: question.isSecret === true,
            ...(typeof question.isOther === "boolean" ? { isOther: question.isOther } : {}),
            options: Array.isArray(question.options)
              ? question.options.filter(isRecord).slice(0, 10).map((option) => ({
                  label: typeof option.label === "string" ? option.label.slice(0, 120) : "",
                  description: typeof option.description === "string"
                    ? option.description.slice(0, 300)
                    : ""
                }))
              : undefined
          }];
        })
    : undefined;
  const availableDecisions = Array.isArray(value.availableDecisions)
    ? [...new Set(value.availableDecisions.filter(isCodexInteractionDecision))].slice(0, 4)
    : undefined;
  const autoResolutionMs = value.autoResolutionMs === null
    ? null
    : typeof value.autoResolutionMs === "number" &&
        Number.isSafeInteger(value.autoResolutionMs) &&
        value.autoResolutionMs >= 0
      ? value.autoResolutionMs
      : undefined;
  const expiresAt = value.expiresAt === null
    ? null
    : typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt)
      ? value.expiresAt
      : undefined;
  const networkProtocol = isRecord(value.networkContext)
    ? value.networkContext.protocol
    : undefined;
  const networkContext: CodexPendingInteraction["networkContext"] = isRecord(value.networkContext) &&
    typeof value.networkContext.host === "string" &&
    (networkProtocol === "http" ||
      networkProtocol === "https" ||
      networkProtocol === "socks5Tcp" ||
      networkProtocol === "socks5Udp")
    ? {
        host: redactSensitiveText(value.networkContext.host).slice(0, 253),
        protocol: networkProtocol
      }
    : undefined;
  const commandActions: CodexPendingInteraction["commandActions"] = Array.isArray(value.commandActions)
    ? value.commandActions.filter(isRecord).slice(0, 20).flatMap((action) => {
        const actionType = action.type;
        if (
          actionType !== "read" &&
          actionType !== "listFiles" &&
          actionType !== "search" &&
          actionType !== "unknown"
        ) return [];
        if (typeof action.command !== "string") return [];
        return [{
          type: actionType,
          command: redactSensitiveText(action.command).slice(0, 500),
          ...(typeof action.name === "string"
            ? { name: redactSensitiveText(action.name).slice(0, 120) }
            : {}),
          ...(typeof action.pathLabel === "string"
            ? { pathLabel: redactSensitiveText(action.pathLabel).slice(0, 200) }
            : {}),
          ...(typeof action.query === "string"
            ? { query: redactSensitiveText(action.query).slice(0, 300) }
            : {})
        }];
      })
    : undefined;
  const rawAmendments = isRecord(value.proposedAmendments) ? value.proposedAmendments : undefined;
  const execPolicy = Array.isArray(rawAmendments?.execPolicy)
    ? rawAmendments.execPolicy
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 30)
        .map((entry) => redactSensitiveText(entry).slice(0, 300))
    : undefined;
  const networkPolicy: NonNullable<CodexPendingInteraction["proposedAmendments"]>["networkPolicy"] =
    Array.isArray(rawAmendments?.networkPolicy)
    ? rawAmendments.networkPolicy.filter(isRecord).slice(0, 20).flatMap((entry) => {
        const action = entry.action;
        return typeof entry.host === "string" && (action === "allow" || action === "deny")
          ? [{ host: redactSensitiveText(entry.host).slice(0, 253), action }]
          : [];
      })
    : undefined;
  const proposedAmendments = execPolicy?.length || networkPolicy?.length
    ? {
        ...(execPolicy?.length ? { execPolicy } : {}),
        ...(networkPolicy?.length ? { networkPolicy } : {})
      }
    : undefined;
  const rawPermissions = isRecord(value.requestedPermissions) ? value.requestedPermissions : undefined;
  const filesystemRead = Array.isArray(rawPermissions?.filesystemRead)
    ? rawPermissions.filesystemRead
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 50)
        .map((entry) => redactSensitiveText(entry).slice(0, 200))
    : undefined;
  const filesystemWrite = Array.isArray(rawPermissions?.filesystemWrite)
    ? rawPermissions.filesystemWrite
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 50)
        .map((entry) => redactSensitiveText(entry).slice(0, 200))
    : undefined;
  const requestedPermissions = rawPermissions && (
    rawPermissions.networkEnabled === true ||
    rawPermissions.networkEnabled === false ||
    rawPermissions.networkEnabled === null ||
    filesystemRead !== undefined ||
    filesystemWrite !== undefined ||
    typeof rawPermissions.filesystemEntries === "number"
  )
    ? {
        ...(rawPermissions.networkEnabled === true ||
          rawPermissions.networkEnabled === false ||
          rawPermissions.networkEnabled === null
          ? { networkEnabled: rawPermissions.networkEnabled }
          : {}),
        ...(filesystemRead !== undefined ? { filesystemRead } : {}),
        ...(filesystemWrite !== undefined ? { filesystemWrite } : {}),
        ...(typeof rawPermissions.filesystemEntries === "number" &&
          Number.isSafeInteger(rawPermissions.filesystemEntries) &&
          rawPermissions.filesystemEntries >= 0
          ? { filesystemEntries: Math.min(rawPermissions.filesystemEntries, 1_000) }
          : {})
      }
    : undefined;
  return {
    interactionId: value.interactionId.slice(0, 200),
    ...(value.origin === "codex-question" || value.origin === "app-approval" || value.origin === "unknown" ? { origin: value.origin } : {}),
    kind,
    threadId: value.threadId.slice(0, 200),
    turnId: value.turnId.slice(0, 200),
    itemId: value.itemId.slice(0, 200),
    summary: redactSensitiveText(value.summary).slice(0, 1_000),
    ...(typeof value.isBlocking === "boolean" ? { isBlocking: value.isBlocking } : {}),
    ...(isRecord(value.elicitation) && (value.elicitation.mode === "form" || value.elicitation.mode === "url") &&
        typeof value.elicitation.serverName === "string" ? { elicitation: {
          mode: value.elicitation.mode,
          serverName: redactSensitiveText(value.elicitation.serverName).slice(0, 200)
        } } : {}),
    ...(typeof value.reason === "string"
      ? { reason: redactSensitiveText(value.reason).slice(0, 500) }
      : {}),
    ...(typeof value.cwdLabel === "string"
      ? { cwdLabel: redactSensitiveText(value.cwdLabel).slice(0, 200) }
      : {}),
    ...(typeof value.grantRootLabel === "string"
      ? { grantRootLabel: redactSensitiveText(value.grantRootLabel).slice(0, 200) }
      : {}),
    ...(availableDecisions ? { availableDecisions } : {}),
    ...(autoResolutionMs !== undefined ? { autoResolutionMs } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(networkContext ? { networkContext } : {}),
    ...(commandActions?.length ? { commandActions } : {}),
    ...(proposedAmendments ? { proposedAmendments } : {}),
    ...(requestedPermissions ? { requestedPermissions } : {}),
    ...(questions ? { questions } : {})
  };
}

function isCodexInteractionDecision(value: unknown): value is CodexInteractionDecision {
  return value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel";
}

function sanitizePublicData(value: unknown, depth: number): unknown {
  if (depth > 6 || value === null || value === undefined) return value === null ? null : undefined;
  if (typeof value === "string") return redactSensitiveText(value).slice(0, 8_192);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizePublicData(entry, depth + 1)).filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 50)
      .flatMap(([key, entry]) => {
        const sanitized = sanitizePublicData(entry, depth + 1);
        return sanitized === undefined ? [] : [[key.slice(0, 120), sanitized]];
      })
  );
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]{1,80} PRIVATE KEY-----[\s\S]*?-----END [^-]{1,80} PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|rk|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
    .replace(/\b(password|passwd|token|api[_-]?key|secret)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

function readTrackingState(
  value: unknown
): CodexJob["trackingState"] | undefined {
  return value === "connected" || value === "liveness-unknown" || value === "worker-lost" || value === "orphaned"
    ? value
    : undefined;
}

function readPersistedJob(value: unknown): PersistedCodexJob | undefined {
  if (!isRecord(value)) return undefined;
  const jobId = typeof value.jobId === "string" && value.jobId ? value.jobId : undefined;
  const operation = value.operation;
  const sandbox = value.sandbox;
  const status = value.status;
  const sessionDecision = readSessionDecision(value.sessionDecision);
  const lastProgress = readProgress(value.lastProgress);
  const scopeId = value.scopeId;
  const requestId = value.requestId;
  const requestHash = value.requestHash;
  const requestHashVersion = value.requestHashVersion;
  const completionDeliveryPolicy: CompletionDeliveryPolicy | undefined =
    value.completionDeliveryPolicy === undefined
      ? "live-card"
      : value.completionDeliveryPolicy === "live-card" || value.completionDeliveryPolicy === "direct-wait"
        ? value.completionDeliveryPolicy
        : undefined;
  const activityId =
    typeof value.activityId === "string" && SCOPE_ID_PATTERN.test(value.activityId)
      ? value.activityId.toLowerCase()
      : undefined;
  const backendKind =
    typeof value.backendKind === "string" && value.backendKind ? value.backendKind : "mcp-server";
  const trackingState = readTrackingState(value.trackingState) ||
    (isTerminalActivityJobStatus(String(status)) ? "liveness-unknown" : "orphaned");
  const cancellationIntentId = typeof value.cancellationIntentId === "string" &&
    SCOPE_ID_PATTERN.test(value.cancellationIntentId)
      ? value.cancellationIntentId.toLowerCase()
      : undefined;
  const explicitTerminalOrigin = JOB_TERMINAL_ORIGINS.includes(
    value.terminalOrigin as JobTerminalOrigin
  )
    ? value.terminalOrigin as JobTerminalOrigin
    : undefined;
  const terminalOrigin: JobTerminalOrigin | undefined = explicitTerminalOrigin ||
    (status === "completed"
      ? "normal-completion"
      : status === "failed"
        ? "upstream-failure"
        : status === "interrupted"
          ? trackingState === "orphaned"
            ? "bridge-restart"
            : trackingState === "worker-lost"
              ? "worker-loss"
              : "app-server-interrupted"
          : status === "cancelled"
            ? "legacy-unattributed-cancellation"
            : undefined);
  const publicEvents = Array.isArray(value.publicEvents)
    ? value.publicEvents.map(sanitizePublicEvent).filter((event): event is CodexPublicEvent => Boolean(event)).slice(-200)
    : [];
  const pendingInteractions = Array.isArray(value.pendingInteractions)
    ? value.pendingInteractions
        .map(readPendingInteraction)
        .filter((interaction): interaction is CodexPendingInteraction => Boolean(interaction))
        .slice(-20)
    : [];
  const executionDecision = readExecutionDecision(value.executionDecision);
  let project: { projectId: string; projectName: string } | undefined;
  let projectRequest: RuntimeProjectSelection | undefined;
  try {
    if (value.projectId !== undefined || value.projectName !== undefined) {
      if (typeof value.projectId !== "string" || typeof value.projectName !== "string") {
        return undefined;
      }
      project = {
        projectId: normalizeProjectId(value.projectId),
        projectName: normalizeProjectName(value.projectName)
      };
    }
    if (value.projectRequest !== undefined) {
      if (!isRecord(value.projectRequest) || typeof value.projectRequest.name !== "string") {
        return undefined;
      }
      if (typeof value.projectRequest.projectRef === "string") {
        if (
          !Number.isInteger(value.projectRequest.projectRevision) ||
          Number(value.projectRequest.projectRevision) < 1
        ) {
          return undefined;
        }
        projectRequest = {
          name: normalizeProjectName(value.projectRequest.name),
          projectRef: normalizeProjectRef(value.projectRequest.projectRef),
          projectRevision: Number(value.projectRequest.projectRevision)
        };
      } else {
        if (
          !Number.isInteger(value.projectRequest.registryRevision) ||
          Number(value.projectRequest.registryRevision) < 0
        ) {
          return undefined;
        }
        projectRequest = {
          name: normalizeProjectName(value.projectRequest.name),
          registryRevision: Number(value.projectRequest.registryRevision)
        };
      }
    }
  } catch {
    return undefined;
  }
  if (
    !jobId ||
    !activityId ||
    (operation !== "start" && operation !== "continue") ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isTimestamp(value.lastProgressAt) ||
    !Number.isInteger(value.version) ||
    (value.version as number) < 1 ||
    typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) ||
    path.normalize(value.cwd) !== value.cwd ||
    (sandbox !== "read-only" && sandbox !== "workspace-write" && sandbox !== "danger-full-access") ||
    typeof scopeId !== "string" ||
    !SCOPE_ID_PATTERN.test(scopeId) ||
    typeof requestId !== "string" ||
    !requestId ||
    typeof requestHash !== "string" ||
    !/^[0-9a-f]{64}$/i.test(requestHash) ||
    !completionDeliveryPolicy ||
    (requestHashVersion !== 1 &&
      requestHashVersion !== 2 &&
      requestHashVersion !== 3 &&
      requestHashVersion !== 4 &&
      requestHashVersion !== 5 &&
      requestHashVersion !== 6 &&
      requestHashVersion !== 7 &&
      requestHashVersion !== 8 &&
      requestHashVersion !== 9 &&
      requestHashVersion !== 10 &&
      requestHashVersion !== 11) ||
    !isOptionalString(value.selectionKey) ||
    !Array.isArray(value.exclusiveKeys) ||
    !value.exclusiveKeys.every((entry) => typeof entry === "string") ||
    !sessionDecision ||
    (status !== "running" &&
      status !== "terminating" &&
      status !== "termination-failed" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "interrupted" &&
      status !== "cancelled") ||
    !isOptionalFiniteNumber(value.resultBytes) ||
    !isOptionalBoolean(value.resultOmitted) ||
    !isOptionalFiniteNumber(value.cancelRequestedAt) ||
    (value.cancellationIntentId !== undefined && !cancellationIntentId) ||
    (value.terminalOrigin !== undefined && !explicitTerminalOrigin) ||
    !isOptionalString(value.error) ||
    !isOptionalString(value.threadId) ||
    !isOptionalString(value.bridgeInstanceId) ||
    !isOptionalString(value.workerId) ||
    !isOptionalInteger(value.workerGeneration) ||
    !isOptionalInteger(value.workerPid) ||
    !isOptionalInteger(value.processGroupId) ||
    !isOptionalBoolean(value.terminationEscalated) ||
    !isOptionalString(value.upstreamRequestId) ||
    !isOptionalPositiveInteger(value.terminalVersion) ||
    !isOptionalString(value.agentId) ||
    (value.authBoundary !== undefined &&
      (typeof value.authBoundary !== "string" || !/^[a-f0-9]{64}$/.test(value.authBoundary))) ||
    !isOptionalString(value.sourceThreadId) ||
    (value.contextMode !== undefined && !AGENT_CONTEXT_MODES.includes(value.contextMode as AgentContextMode)) ||
    (value.result !== undefined && !isRecord(value.result)) ||
    (value.lastProgress !== undefined && !lastProgress) ||
    (value.executionDecision !== undefined && !executionDecision)
  ) {
    return undefined;
  }
  return {
    jobId,
    authBoundary: value.authBoundary as string | undefined,
    executionReceipt: value.executionReceipt === true,
    activityId,
    ...(project || {}),
    ...(projectRequest ? { projectRequest } : {}),
    agentId: value.agentId,
    contextMode: value.contextMode as AgentContextMode | undefined,
    threadId: value.threadId || sessionDecision.threadId,
    backendKind,
    trackingState,
    runtime: safeRuntimeMetadata(value.runtime),
    bridgeInstanceId: value.bridgeInstanceId,
    workerId: value.workerId,
    workerGeneration: value.workerGeneration,
    workerPid: value.workerPid,
    threadPersistence: ["persistent", "ephemeral", "unknown"].includes(String(value.threadPersistence)) ? value.threadPersistence as UpstreamWorkerAssignment["threadPersistence"] : undefined,
    processGroupId: value.processGroupId,
    upstreamRequestId: value.upstreamRequestId,
    terminalVersion: value.terminalVersion,
    operation,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastProgressAt: value.lastProgressAt,
    version: value.version as number,
    cwd: value.cwd,
    sandbox,
    scopeId: scopeId.toLowerCase(),
    requestId,
    requestHash,
    requestHashVersion,
    completionDeliveryPolicy,
    sourceThreadId: value.sourceThreadId,
    ...(typeof value.mcpPrincipal === "string" ? { mcpPrincipal: value.mcpPrincipal } : {}),
    ...(Array.isArray(value.approvedFollowups) ? { approvedFollowups: issueApprovedFollowups(jobId, value.approvedFollowups as ApprovedFollowup[]) } : {}),
    ...(value.followup ? { followup: readFollowupReference(value.followup as FollowupReference) } : {}),
    selectionKey: value.selectionKey,
    ...(executionDecision ? { executionDecision } : {}),
    exclusiveKeys: [...value.exclusiveKeys],
    sessionDecision,
    status,
    result: value.result as ToolResult | undefined,
    resultBytes: value.resultBytes,
    resultOmitted: value.resultOmitted,
    lastProgress,
    publicEvents,
    inputEvents: Array.isArray(value.inputEvents) ? value.inputEvents.map(sanitizePublicEvent).filter((e): e is CodexPublicEvent => Boolean(e)).filter(isCodexInputEvent).slice(-40) : publicEvents.filter(isCodexInputEvent).slice(-40),
    pendingInteractions,
    cancelRequestedAt: value.cancelRequestedAt,
    cancellationIntentId,
    terminalOrigin,
    terminationEscalated: value.terminationEscalated,
    error: value.error
  };
}

function readSessionDecision(value: unknown): SessionDecision | undefined {
  if (!isRecord(value)) return undefined;
  const requestedMode = value.requestedMode;
  const action = value.action;
  const reason = value.reason;
  const handoff = readBackendHandoffAudit(value.handoff);
  if (
    (requestedMode !== "auto" && requestedMode !== "new" && requestedMode !== "continue") ||
    (action !== "start" && action !== "continue") ||
    (reason !== "explicit-new" &&
      reason !== "explicit-thread" &&
      reason !== "activity-new" &&
      reason !== "activity-compatible" &&
      reason !== "activity-no-compatible" &&
      reason !== "recent-compatible" &&
      reason !== "compatible-session-busy" &&
      reason !== "no-compatible-session") ||
    !isOptionalString(value.threadId) ||
    (value.handoff !== undefined && !handoff)
  ) {
    return undefined;
  }
  return {
    requestedMode,
    action,
    reason,
    threadId: value.threadId,
    ...(handoff ? { handoff } : {})
  };
}

function readBackendHandoffAudit(value: unknown): BackendHandoffAudit | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.sourceBackend !== "mcp-server" && value.sourceBackend !== "app-server" && value.sourceBackend !== "codex-sdk") ||
    (value.targetBackend !== "mcp-server" && value.targetBackend !== "app-server" && value.targetBackend !== "codex-sdk") ||
    value.sourceBackend === value.targetBackend ||
    typeof value.sourceThreadId !== "string" ||
    !value.sourceThreadId ||
    value.sourceThreadId.length > 200 ||
    value.continuity !== "explicit-summary-only" ||
    typeof value.summarySha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.summarySha256)
  ) {
    return undefined;
  }
  return {
    sourceBackend: value.sourceBackend,
    targetBackend: value.targetBackend,
    sourceThreadId: value.sourceThreadId,
    continuity: "explicit-summary-only",
    summarySha256: value.summarySha256.toLowerCase()
  };
}

function readExecutionDecision(value: unknown): ExecutionDecision | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.source;
  const appliedAt = value.appliedAt;
  const catalogValidation = value.catalogValidation;
  const backendKind = value.backendKind;
  if (
    !Number.isInteger(value.policyRevision) ||
    (value.policyRevision as number) < 0 ||
    typeof value.catalogFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/i.test(value.catalogFingerprint) ||
    (catalogValidation !== "valid" &&
      catalogValidation !== "temporarily-unverified-with-last-known-good" &&
      catalogValidation !== "invalid") ||
    (backendKind !== "mcp-server" && backendKind !== "app-server" && backendKind !== "codex-sdk") ||
    (source !== "fixed" &&
      source !== "preferred" &&
      source !== "configured-fallback" &&
      source !== "caller" &&
      source !== "thread-inherited" &&
      source !== "backend-default" &&
      source !== "compatibility-fallback") ||
    (appliedAt !== "thread-start" && appliedAt !== "turn-start") ||
    typeof value.reason !== "string"
  ) {
    return undefined;
  }
  try {
    const effectiveSelection = validateModelSelection(value.effectiveSelection, "persisted effective selection");
    const requestedSelection = value.requestedSelection === undefined
      ? undefined
      : validateModelSelection(value.requestedSelection, "persisted requested selection");
    const normalizedSource = source === "preferred" ? "configured-fallback" : source;
    const fallbackWarning = typeof value.fallbackWarning === "string"
      ? value.fallbackWarning
      : typeof value.preferenceWarning === "string"
        ? value.preferenceWarning
        : undefined;
    return {
      policyRevision: value.policyRevision as number,
      catalogFingerprint: value.catalogFingerprint,
      catalogValidation,
      backendKind,
      ...(requestedSelection ? { requestedSelection } : {}),
      effectiveSelection,
      effectiveReasoningEffort:
        typeof value.effectiveReasoningEffort === "string"
          ? value.effectiveReasoningEffort
          : effectiveSelection.reasoningEffort,
      savedSelectionSupported:
        typeof value.savedSelectionSupported === "boolean" ? value.savedSelectionSupported : true,
      ...(fallbackWarning ? { fallbackWarning } : {}),
      source: normalizedSource,
      appliedAt,
      reason: value.reason
    };
  } catch {
    return undefined;
  }
}

function readProgress(value: unknown): Progress | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.progress !== "number" ||
    !Number.isFinite(value.progress) ||
    !isOptionalFiniteNumber(value.total) ||
    !isOptionalString(value.message)
  ) {
    return undefined;
  }
  return sanitizeProgress({
    progress: value.progress,
    total: value.total,
    message: value.message
  });
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isOptionalInteger(value: unknown): value is number | undefined {
  return value === undefined || Number.isInteger(value);
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 1);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function toolResultErrorMessage(result: ToolResult): string {
  for (const item of Array.isArray(result.content) ? result.content : []) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      const message = item.text.trim();
      if (message) return message.slice(0, 4_000);
    }
  }
  return "Codex upstream returned an error tool result.";
}

function extractResultBackendKind(result: ToolResult): CodexBackendKind | undefined {
  if (!isRecord(result.structuredContent)) return undefined;
  const value = result.structuredContent.backendKind;
  return value === "mcp-server" || value === "app-server" || value === "codex-sdk" ? value : undefined;
}

function safeRuntimeMetadata(value: unknown): UpstreamWorkerAssignment["runtime"] | undefined {
  const parsed = z.object({ codex: z.string().regex(/^\d+\.\d+\.\d+$/),
    sdk: z.string().regex(/^\d+\.\d+\.\d+$/).optional(), python: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    channel: z.literal("stable").optional(), requestedAuthMode: z.enum(["chatgpt", "api-key"]).optional(), resolvedAuthMode: z.enum(["chatgpt", "api-key"]).optional()
  }).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function extractResultThreadLineage(
  result: ToolResult,
  fallbackForkedFromThreadId?: string
): { sessionId?: string; forkedFromThreadId?: string } {
  if (!isRecord(result.structuredContent)) {
    return fallbackForkedFromThreadId ? { forkedFromThreadId: fallbackForkedFromThreadId } : {};
  }
  const sessionId = typeof result.structuredContent.sessionId === "string"
    ? result.structuredContent.sessionId.trim().slice(0, 200)
    : "";
  const forkedFromThreadId = typeof result.structuredContent.forkedFromThreadId === "string"
    ? result.structuredContent.forkedFromThreadId.trim().slice(0, 200)
    : fallbackForkedFromThreadId;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(forkedFromThreadId ? { forkedFromThreadId } : {})
  };
}

function extractResultTurnStatus(result: ToolResult): string | undefined {
  if (!isRecord(result.structuredContent)) return undefined;
  return typeof result.structuredContent.turnStatus === "string"
    ? result.structuredContent.turnStatus
    : undefined;
}

function retainBoundedResult(
  result: ToolResult,
  maxBytes: number,
  session: SessionDecision,
  cwd: string,
  allowedRoots: string[],
  steeringPrompts: readonly string[] = []
): { result: ToolResult; originalBytes: number; omitted: boolean } {
  const sanitized = sanitizeRetainedToolResult(
    result,
    cwd,
    allowedRoots,
    steeringPrompts
  );
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    serialized = undefined;
  }
  const originalBytes = serialized === undefined ? -1 : Buffer.byteLength(serialized, "utf8");
  if (originalBytes >= 0 && originalBytes <= maxBytes) {
    return { result: sanitized, originalBytes, omitted: false };
  }

  const threadId = extractThreadId(result) || session.threadId;
  const summary = {
    status: "completed",
    resultOmitted: true,
    originalBytes: originalBytes >= 0 ? originalBytes : null,
    maxRetainedBytes: maxBytes,
    threadId: threadId || null,
    message: "Codex completed, but its result exceeded the bridge retention limit and was omitted. Retry with a narrower prompt or raise CODEX_MCP_BRIDGE_MAX_JOB_RESULT_BYTES."
  };
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary
    },
    originalBytes,
    omitted: true
  };
}

function sanitizeRetainedToolResult(
  result: ToolResult,
  cwd: string,
  allowedRoots: string[],
  steeringPrompts: readonly string[] = []
): ToolResult {
  const replacements = [cwd, ...allowedRoots]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const sanitize = (value: unknown, depth: number, key?: string): unknown => {
    if (depth > 24 || value === null || value === undefined) return value === null ? null : undefined;
    if (typeof value === "string") {
      if (key && /^(?:password|passwd|token|api[_-]?key|secret|authorization)$/i.test(key)) {
        return "[REDACTED]";
      }
      let text = redactSensitiveText(
        redactSteeringPromptText(value, steeringPrompts)
      );
      for (const root of replacements) text = text.split(root).join(path.basename(root));
      return text;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      return value.map((entry) => sanitize(entry, depth + 1)).filter((entry) => entry !== undefined);
    }
    if (!isRecord(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value).flatMap(([entryKey, entry]) => {
        if (entryKey === "_meta") return [];
        const sanitizedEntry = sanitize(entry, depth + 1, entryKey);
        return sanitizedEntry === undefined
          ? []
          : [[redactSteeringPromptText(entryKey, steeringPrompts), sanitizedEntry]];
      })
    );
  };
  const sanitized = sanitize(result, 0);
  return isRecord(sanitized)
    ? (sanitized as ToolResult)
    : {
        content: [{ type: "text", text: "Codex returned no retainable result." }],
        structuredContent: { message: "Codex returned no retainable result." }
      };
}

function sanitizeTextForJob(
  value: string,
  cwd: string,
  allowedRoots: string[],
  steeringPrompts: readonly string[] = []
): string {
  let sanitized = redactSensitiveText(
    redactSteeringPromptText(value, steeringPrompts)
  );
  for (const root of [cwd, ...allowedRoots].filter(Boolean).sort((a, b) => b.length - a.length)) {
    sanitized = sanitized.split(root).join(path.basename(root));
  }
  return sanitized;
}

const STEERING_PROMPT_REDACTION_MARKER = "[steering input omitted]";

function redactSteeringPromptText(
  value: string,
  steeringPrompts: readonly string[]
): string {
  const prompts = [...new Set(steeringPrompts)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (prompts.length === 0) return value;

  let redacted = value;
  let matched = false;
  for (const prompt of prompts) {
    if (!redacted.includes(prompt)) continue;
    redacted = redacted.split(prompt).join(STEERING_PROMPT_REDACTION_MARKER);
    matched = true;
  }
  if (!matched) return value;

  // A marker or a concatenation created by a prior replacement could itself
  // contain another tracked prompt. Deletion-only cleanup strictly decreases
  // the string until no exact raw steering input remains.
  let changed = true;
  while (changed) {
    changed = false;
    for (const prompt of prompts) {
      if (!redacted.includes(prompt)) continue;
      redacted = redacted.split(prompt).join("");
      changed = true;
    }
  }
  return redacted;
}

function dashboardCardToolMetadata(): Record<string, unknown> {
  return {
    ui: { resourceUri: DASHBOARD_CARD_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": DASHBOARD_CARD_URI,
    "openai/widgetAccessible": true,
    "codex/uiContractGeneration": DASHBOARD_CARD_CONTRACT_GENERATION
  };
}

function codexTaskEnvelopeAnnotations(config: BridgeConfig) {
  // Contract v2 remains valid while the user switches access strategies, so
  // host consent metadata must advertise the installation's maximum possible
  // authority rather than the narrower setting active at list time.
  const exposesMutation = config.allowWorkspaceWrite || config.allowDangerFullAccess;
  const exposesOpenWorld = config.allowDangerFullAccess;
  return {
    readOnlyHint: false,
    destructiveHint: exposesMutation,
    idempotentHint: false,
    openWorldHint: exposesOpenWorld
  };
}

function forwardResult(
  result: ToolResult,
  job: CodexJob,
  preferences: BridgeUserSettings,
  registry?: CodexJobRegistry,
  replay = false
): ToolResult {
  const projection = taskProjectionForJob(job, preferences, registry, replay);
  const semantic = projection.structured;
  if (result.isError || job.status === "failed") {
    const error = normalizeStructuredError(
      retainedStructuredError(result) || {
        code: "UPSTREAM_TOOL_ERROR",
        message: toolResultErrorMessage(result)
      }
    );
    const structured = {
      ...semantic,
      state: "failed" as const,
      terminal: true,
      delivery: "none" as const,
      resultAvailability: "unavailable" as const,
      resultOmitted: false,
      error: taskStructuredErrorProjection(error)
    };
    return contractedToolResult(
      taskErrorResultContract,
      result,
      structured,
      { text: taskCompatibilityText(structured) },
      { isError: true }
    );
  }
  if (semantic.resultAvailability !== "delivered") {
    return contractedToolResult(
      taskStateResultContract,
      result,
      semantic,
      { text: taskCompatibilityText(semantic) }
    );
  }
  const primaryContent = primaryResultContent(result);
  const primaryAnswer = modelPrimaryAnswer(result);
  const deliveredSemantic = codexTaskOutputSchema.parse({
    ...semantic,
    answer: primaryAnswer.text,
    warnings: primaryAnswer.truncated
      ? [...semantic.warnings, MODEL_PRIMARY_ANSWER_TRUNCATION_WARNING]
      : semantic.warnings
  });
  const primaryBytes = primaryContent.reduce(
    (total, item) => total + (item.type === "text" ? Buffer.byteLength(item.text, "utf8") : 0),
    0
  );
  const primaryContract = toolOutputContract(
    "codex_task",
    "model-orchestrator-semantic",
    codexTaskOutputSchema,
    Math.max(1, primaryBytes, job.resultBytes || 0),
    "primary-payload"
  );
  return contractedToolResult(
    primaryContract,
    result,
    deliveredSemantic,
    { content: primaryContent }
  );
}

function taskResultForJob(
  job: CodexJob,
  staleAfterMs: number,
  preferences: BridgeUserSettings,
  registry: CodexJobRegistry | undefined,
  replay: boolean
): ToolResult {
  const projection = taskProjectionForJob(
    job,
    preferences,
    registry,
    replay,
    staleAfterMs
  );
  const structured = projection.structured;
  return contractedToolResult(
    structured.error ? taskErrorResultContract : taskStateResultContract,
    job,
    structured,
    { text: taskCompatibilityText(structured) },
    structured.error ? { isError: true } : {}
  );
}

function taskProjectionForJob(
  job: CodexJob,
  preferences: BridgeUserSettings,
  registry: CodexJobRegistry | undefined,
  replay: boolean,
  staleAfterMs = registry?.staleThresholdMs || 1
): {
  structured: z.infer<typeof codexTaskOutputSchema>;
} {
  const semantic = jobSemanticOutputSchema.parse(
    formatJobStatus(
      job,
      staleAfterMs,
      undefined,
      preferences,
      registry,
      replay
    )
  );
  const retainedAnswer = semantic.result.availability === "delivered" && job.result
    ? modelPrimaryAnswer(job.result)
    : undefined;
  const structured = codexTaskOutputSchema.parse({
    contractVersion: "4",
    kind: "task",
    state: semantic.status,
    terminal: semantic.terminal,
    delivery: semantic.delivery,
    replay: semantic.replay,
    jobId: semantic.jobId,
    activityId: semantic.activityId,
    agentId: semantic.agentId,
    threadId: semantic.threadId,
    projectName: semantic.projectName,
    requestId: semantic.requestId,
    approvedFollowups: semantic.approvedFollowups || null,
    jobVersion: semantic.versions.job,
    activityVersion: semantic.versions.activity ?? null,
    backend: semantic.backendKind,
    sandbox: semantic.sandbox,
    completionDeliveryPolicy: semantic.completionDeliveryPolicy,
    requestedModel: semantic.executionAudit?.requested?.model ?? null,
    requestedReasoningEffort: semantic.executionAudit?.requested?.reasoningEffort ?? null,
    actualModel: semantic.executionAudit?.actual.model ?? null,
    actualReasoningEffort: semantic.executionAudit?.actual.reasoningEffort ?? null,
    rerouted: Boolean(semantic.executionAudit?.reroute),
    rerouteReason: semantic.executionAudit?.reroute?.reason ?? null,
    resultAvailability: semantic.result.availability,
    resultOmitted: semantic.result.omitted,
    answer: retainedAnswer?.text || null,
    error: semantic.error ? taskStructuredErrorProjection(semantic.error) : null,
    warnings: retainedAnswer?.truncated
      ? [...semantic.warnings, MODEL_PRIMARY_ANSWER_TRUNCATION_WARNING]
      : semantic.warnings,
    nextActions: [
      ...semantic.nextActions.map(modelNextActionProjection),
      ...(semantic.terminal
        ? []
        : [guidance(
            semantic.completionDeliveryPolicy === "direct-wait"
              ? "Experimental direct-result mode applies to this Job. After every non-terminal return, inspect the supplied exact-Job input action before repeating a bounded terminal wait on this same Job. Review the terminal result and continue only already-approved work; stop at any new approval or user-input boundary. If the GPT run ends, the user must request an exact-Job read in the originating conversation; there is no automatic live-card fallback."
              : "This Job continues independently of the current GPT response. Query the exact Job when needed, answer pending questions, and retrieve its terminal result before reporting completion."
          )])
    ]
  });
  return { structured };
}

function statusToolResult(
  structured: z.infer<typeof codexStatusOutputSchema>,
  job: CodexJob,
  maxPrimaryBytes: number
): ToolResult {
  const detailResult = structured.items.find((item) => item.type === "job")?.result;
  if (
    job.status === "completed" &&
    !job.resultOmitted &&
    job.result &&
    detailResult?.availability === "delivered"
  ) {
    const primaryContent = primaryResultContent(job.result);
    const primaryAnswer = modelPrimaryAnswer(job.result);
    const answeredStructured = codexStatusOutputSchema.parse({
      ...structured,
      items: structured.items.map((item) =>
        item.type === "job" && item.id === job.jobId
          ? {
              ...item,
              answer: primaryAnswer.text,
              message:
                "Codex completed; the bounded model-authoritative answer is in this exact Job item. Tool content is a compatibility copy."
            }
          : item
      ),
      warnings: primaryAnswer.truncated
        ? [...structured.warnings, MODEL_PRIMARY_ANSWER_TRUNCATION_WARNING]
        : structured.warnings
    });
    const contentBytes = primaryContent.reduce(
      (total, item) => total + (item.type === "text" ? Buffer.byteLength(item.text, "utf8") : 0),
      0
    );
    const contract = toolOutputContract(
      "codex_status",
      "model-orchestrator-semantic",
      codexStatusOutputSchema,
      Math.max(1, contentBytes, maxPrimaryBytes),
      "primary-payload"
    );
    return contractedToolResult(contract, job, answeredStructured, { content: primaryContent });
  }
  return contractedToolResult(
    statusResultContract,
    job,
    structured,
    { text: statusCompatibilityText(structured) }
  );
}

function compactStatusProjection(
  value: Record<string, unknown>
): z.infer<typeof codexStatusOutputSchema> {
  const kind = value.kind;
  if (!["overview", "page", "activity", "thread", "job"].includes(String(kind))) {
    throw new Error("Status projection requires a recognized result kind.");
  }
  const scopeView = isRecord(value.scopeView) ? value.scopeView : {};
  const mode = scopeView.mode === "all" || scopeView.mode === "policy-only"
    ? scopeView.mode
    : "scoped";
  const source = scopeView.source === "host-metadata" ||
    scopeView.source === "explicit-compatibility"
    ? scopeView.source
    : undefined;
  const scope = { mode, ...(source ? { source } : {}) };
  const counts = statusCountsOutputSchema.parse(
    isRecord(value.scopeCounts) ? value.scopeCounts : statusDetailCounts(value)
  );
  let page: z.infer<typeof codexStatusOutputSchema>["page"];
  let detail: z.infer<typeof statusItemOutputSchema> | undefined;
  let items: z.infer<typeof statusItemOutputSchema>[] = [];
  if (kind === "overview") {
    items = [
      ...statusRows(value.sessions, "session"),
      ...statusRows(value.jobs, "job"),
      ...statusRows(value.activities, "activity"),
      ...statusRows(value.agents, "agent")
    ];
  } else if (kind === "page") {
    const query = isRecord(value.query) ? value.query : {};
    const collection = query.collection;
    if (collection !== "sessions" && collection !== "jobs" && collection !== "activities") {
      throw new Error("Status page projection requires its collection discriminator.");
    }
    const pagination = isRecord(value.pagination) ? value.pagination : {};
    page = {
      collection,
      offset: integerAtLeast(pagination.offset, 0),
      limit: integerAtLeast(pagination.limit, 1),
      returned: integerAtLeast(pagination.returned, 0),
      total: integerAtLeast(pagination.total, 0),
      hasMore: pagination.hasMore === true,
      ...(typeof pagination.nextCursor === "string"
        ? { nextCursor: pagination.nextCursor }
        : {})
    };
    const type = collection === "sessions"
      ? "session" as const
      : collection === "jobs"
        ? "job" as const
        : "activity" as const;
    items = statusRows(value.items, type);
  } else if (kind === "activity") {
    detail = statusItemProjection(value.activity, "activity");
    items = [
      ...statusRows(value.agents, "agent"),
      ...statusRows(value.jobs, "job"),
      ...stringArray(value.threads).map((threadId) =>
        statusItemOutputSchema.parse({ type: "thread", id: threadId, threadId })
      )
    ];
  } else if (kind === "thread") {
    const threadId = typeof value.threadId === "string" ? value.threadId : "unknown-thread";
    detail = statusItemOutputSchema.parse({ type: "thread", id: threadId, threadId });
    items = [
      ...(isRecord(value.agent) ? [statusItemProjection(value.agent, "agent")] : []),
      ...statusRows(value.activities, "activity"),
      ...statusRows(value.jobs, "job")
    ];
  } else {
    detail = statusItemProjection(value, "job");
  }
  if (kind !== "job") {
    items = items.map((item) =>
      item.type === "job" && item.result?.availability === "delivered"
        ? statusItemOutputSchema.parse({
            ...item,
            nextActions: [exactJobAnswerRetrievalAction(item.id)],
            message:
              "This summary does not include the Job answer; retrieve the exact Job before reporting its result."
          })
        : item
    );
  }
  return codexStatusOutputSchema.parse({
    kind,
    ...(Array.isArray(value.runtimes) ? { runtimes: stringArray(value.runtimes).slice(0, 2) } : {}),
    scope,
    counts,
    ...(page ? { page } : {}),
    items: detail ? [detail, ...items] : items,
    warnings: stringArray(value.warnings).slice(0, 20)
  });
}

function exactJobAnswerRetrievalAction(jobId: string): z.infer<typeof modelNextActionOutputSchema> {
  return statusAction(
    { query: { kind: "job", id: jobId } },
    "Retrieve this exact Job answer before reporting its result."
  );
}

function integerAtLeast(value: unknown, minimum: number): number {
  return Number.isInteger(value) && Number(value) >= minimum ? Number(value) : minimum;
}

function statusRows(
  value: unknown,
  type: z.infer<typeof statusItemOutputSchema>["type"]
): z.infer<typeof statusItemOutputSchema>[] {
  return Array.isArray(value)
    ? value.filter(isRecord).map((entry) => statusItemProjection(entry, type))
    : [];
}

function statusItemProjection(
  value: unknown,
  type: z.infer<typeof statusItemOutputSchema>["type"]
): z.infer<typeof statusItemOutputSchema> {
  const input = isRecord(value) ? value : {};
  const idKey = type === "session" || type === "thread" ? "threadId" : `${type}Id`;
  const id = typeof input[idKey] === "string" && input[idKey]
    ? input[idKey]
    : `unknown-${type}`;
  const state = [input.status, input.lifecycle, input.resumeAvailability]
    .find((entry): entry is string => typeof entry === "string");
  const label = [input.agentName, input.title, input.projectName]
    .find((entry): entry is string => typeof entry === "string");
  const versions = isRecord(input.versions) &&
    Number.isInteger(input.versions.job) && Number(input.versions.job) > 0
    ? {
        job: Number(input.versions.job),
        activity: Number.isInteger(input.versions.activity) && Number(input.versions.activity) > 0
          ? Number(input.versions.activity)
          : undefined
      }
    : undefined;
  const execution = typeof input.backendKind === "string" &&
    typeof input.sandbox === "string"
    ? {
        backend: input.backendKind,
        sandbox: input.sandbox
      }
    : undefined;
  const parsedResult = resultAvailabilityOutputSchema.safeParse(input.result);
  const inferredResult = !parsedResult.success && type === "job" && typeof input.status === "string"
    ? {
        availability: isActiveActivityJobStatus(input.status as CodexJobStatus)
          ? "pending" as const
          : input.status === "completed"
            ? input.resultOmitted === true
              ? "omitted" as const
              : "delivered" as const
            : "unavailable" as const,
        omitted: input.resultOmitted === true
      }
    : undefined;
  const error = isRecord(input.error)
    ? normalizeStructuredError(input.error)
    : typeof input.error === "string" && input.error
      ? normalizeStructuredError({ code: "JOB_FAILED", message: input.error })
      : undefined;
  const wait = jobWaitOutputSchema.safeParse(input.wait);
  return statusItemOutputSchema.parse({
    ...(Array.isArray(input.approvedFollowups) ? { approvedFollowups: input.approvedFollowups } : {}),
    ...(isRecord(input.inputs) ? { inputs: input.inputs } : {}),
    type,
    id,
    ...(label ? { label } : {}),
    ...(state ? { state } : {}),
    ...(Number.isInteger(input.version) && Number(input.version) > 0
      ? { version: input.version }
      : {}),
    ...(typeof input.activityId === "string" ? { activityId: input.activityId } : {}),
    ...(typeof input.agentId === "string" ? { agentId: input.agentId } : {}),
    ...(typeof input.threadId === "string" ? { threadId: input.threadId } : {}),
    ...(typeof input.terminal === "boolean" ? { terminal: input.terminal } : {}),
    ...(typeof input.delivery === "string" ? { delivery: input.delivery } : {}),
    ...(input.completionDeliveryPolicy === "live-card" || input.completionDeliveryPolicy === "direct-wait"
      ? { completionDeliveryPolicy: input.completionDeliveryPolicy }
      : {}),
    ...(isRecord(input.completionEvidence)
      ? { completionEvidence: input.completionEvidence }
      : {}),
    ...(typeof input.replay === "boolean" ? { replay: input.replay } : {}),
    ...(versions ? { versions } : {}),
    ...(execution ? { execution } : {}),
    ...(safeRuntimeMetadata(input.runtime) ? { runtime: Object.entries(safeRuntimeMetadata(input.runtime)!).map(([name, version]) => `${name}=${version}`).join("; ") } : {}),
    ...(parsedResult.success
      ? { result: modelResultAvailabilityProjection(parsedResult.data) }
      : inferredResult
        ? { result: inferredResult }
        : {}),
    ...(error ? { error } : {}),
    ...(wait.success ? { wait: wait.data } : {}),
    ...(() => {
      const actions = Array.isArray(input.nextActions)
        ? input.nextActions.map(modelNextActionProjection)
        : structuredErrorNextActions(input.error);
      return actions.length ? { nextActions: actions } : {};
    })(),
    ...(typeof input.message === "string" ? { message: input.message } : {})
  });
}

function statusDetailCounts(value: Record<string, unknown>): z.infer<typeof statusCountsOutputSchema> {
  const jobs = Array.isArray(value.jobs)
    ? value.jobs.filter(isRecord)
    : value.kind === "job"
      ? [value]
      : [];
  const activities = Array.isArray(value.activities)
    ? value.activities.filter(isRecord)
    : isRecord(value.activity)
      ? [value.activity]
      : value.kind === "job" && typeof value.activityId === "string"
        ? [{ activityId: value.activityId }]
        : [];
  const agents = Array.isArray(value.agents)
    ? value.agents.filter(isRecord)
    : isRecord(value.agent)
      ? [value.agent]
      : value.kind === "job" && typeof value.agentId === "string"
        ? [{ agentId: value.agentId }]
        : [];
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.filter(isRecord)
    : typeof value.threadId === "string" || stringArray(value.threads).length > 0
      ? Array.from({ length: Math.max(1, stringArray(value.threads).length) }, () => ({}))
      : [];
  return {
    sessions: sessions.length,
    jobs: jobs.length,
    runningJobs: jobs.filter((entry) =>
      typeof entry.status === "string" &&
      isActiveActivityJobStatus(entry.status as CodexJobStatus)
    ).length,
    activities: activities.length,
    agents: agents.length,
    orphanedAgents: agents.filter((entry) => entry.lifecycle === "orphaned").length
  };
}

function primaryResultContent(result: ToolResult): ToolResult["content"] {
  if (Array.isArray(result.content) && result.content.length > 0) return result.content;
  return [{ type: "text", text: "Codex completed without a model-readable text payload." }];
}

function modelPrimaryAnswer(result: ToolResult): { text: string; truncated: boolean } {
  const textBlocks = primaryResultContent(result).flatMap((item) =>
    item.type === "text" ? [item.text] : []
  );
  const joined = textBlocks.join("\n\n");
  const source = joined.length > 0
    ? joined
    : "Codex completed without a model-readable text payload.";
  const text = boundedUtf8JsonString(source, MODEL_PRIMARY_ANSWER_MAX_JSON_BYTES);
  return { text, truncated: text !== source };
}

function statusCompatibilityText(value: Record<string, unknown>): string {
  if (value.kind === "job") {
    const detail = Array.isArray(value.items) && isRecord(value.items[0])
      ? value.items[0]
      : value;
    const error = isRecord(detail.error) && typeof detail.error.message === "string"
      ? ` Error: ${detail.error.message}`
      : "";
    const availability = isRecord(detail.result) && typeof detail.result.availability === "string"
      ? ` Result: ${detail.result.availability}.`
      : "";
    return `Job ${String(detail.id || detail.jobId)} is ${String(detail.state || detail.status)}.${availability}${error}`;
  }
  if (value.kind === "overview" && isRecord(value.counts)) {
    return (
      `Status: ${String(value.counts.activities)} Activity(s), ` +
      `${String(value.counts.agents)} Agent(s), ${String(value.counts.runningJobs)} running job(s).`
    );
  }
  if (value.kind === "overview" && isRecord(value.scopeCounts)) {
    return (
      `Status: ${String(value.scopeCounts.activities)} Activity(s), ` +
      `${String(value.scopeCounts.agents)} Agent(s), ${String(value.scopeCounts.runningJobs)} running job(s).`
    );
  }
  if (value.kind === "activity" && isRecord(value.activity)) {
    return `Activity ${String(value.activity.activityId)} is ${String(value.activity.lifecycle)} with ${Array.isArray(value.jobs) ? value.jobs.length : 0} job(s).`;
  }
  if (value.kind === "thread") {
    return `Thread ${String(value.threadId)} has ${Array.isArray(value.jobs) ? value.jobs.length : 0} tracked job(s).`;
  }
  if (value.kind === "page" && isRecord(value.query)) {
    return `${Array.isArray(value.items) ? value.items.length : 0} ${String(value.query.collection)} item(s) returned.`;
  }
  return "Authoritative Codex status returned in structured content.";
}

function taskCompatibilityText(value: z.infer<typeof codexTaskOutputSchema>): string {
  if (value.error) {
    const actions = value.nextActions.length
      ? ` Next: ${value.nextActions.map(nextActionSummary).join(" ")}`
      : "";
    return `${value.error.code}: ${value.error.message}${actions}`;
  }
  if (value.state === "completed") {
    return value.resultOmitted
      ? "Codex completed, but the result was omitted by the retention limit."
      : "Codex completed; its bounded primary answer is in structured answer and tool content is a compatibility copy.";
  }
  if (value.state === "cancelled") {
    return "Codex was cancelled. Partial filesystem changes may remain.";
  }
  const dashboardAction = value.nextActions.find(
    (action) => action.kind === "tool" && action.tool === "codex_dashboard"
  );
  if (dashboardAction) {
    return (
      `Codex job ${value.jobId || "unassigned"} is ${value.state}. ` +
      `Required before replying: ${nextActionSummary(dashboardAction)}`
    );
  }
  const directWaitAction = value.nextActions.find(
    (action) => action.kind === "tool" &&
      action.tool === "codex_status" &&
      action.arguments.query?.kind === "job" &&
      action.arguments.query.waitFor === "terminal"
  );
  if (directWaitAction) {
    return (
      `Codex job ${value.jobId || "unassigned"} is ${value.state}. ` +
      `Required before replying: ${nextActionSummary(directWaitAction)} ` +
      "If this GPT run ends, later recovery requires a user request in the originating conversation; no automatic card fallback is sent."
    );
  }
  return `Codex job ${value.jobId || "unassigned"} is ${value.state}.`;
}

function modelNextActionProjection(
  value: unknown
): z.infer<typeof modelNextActionOutputSchema> {
  return projectModelNextAction(value);
}

function modelResultAvailabilityProjection(
  value: z.infer<typeof resultAvailabilityOutputSchema>
): z.infer<typeof modelResultAvailabilityOutputSchema> {
  return modelResultAvailabilityOutputSchema.parse({
    availability: value.availability,
    omitted: value.omitted
  });
}

function structuredErrorNextActions(value: unknown): z.infer<typeof modelNextActionOutputSchema>[] {
  const input = isRecord(value) ? value : {};
  const nextAction = isRecord(input.nextAction) && typeof input.nextAction.tool === "string"
    ? modelNextActionProjection(input.nextAction)
    : undefined;
  const nextActions = Array.isArray(input.nextActions)
    ? input.nextActions
        .map(modelNextActionProjection)
        .slice(0, 10)
    : [];
  return [...nextActions, ...(nextAction ? [nextAction] : [])].slice(0, 10);
}

function normalizeStructuredError(value: unknown): z.infer<typeof structuredErrorOutputSchema> {
  const input = isRecord(value) ? value : {};
  const code = typeof input.code === "string" && input.code.trim()
    ? input.code.trim().slice(0, 200)
    : "CODEX_ERROR";
  const message = typeof input.message === "string" && input.message.trim()
    ? input.message.trim().slice(0, 4_000)
    : "Codex returned an error without a message.";
  return structuredErrorOutputSchema.parse({
    code,
    message,
    ...(typeof input.retryable === "boolean" ? { retryable: input.retryable } : {}),
    ...(Array.isArray(input.missingFields)
      ? {
          missingFields: input.missingFields
            .filter((entry): entry is string => typeof entry === "string")
            .slice(0, 20)
        }
      : {}),
    ...(input.contextContinuity === "not-migrated"
      ? { contextContinuity: "not-migrated" as const }
      : {})
  });
}

function taskStructuredErrorProjection(
  value: unknown
): z.infer<typeof taskStructuredErrorOutputSchema> {
  const error = normalizeStructuredError(value);
  return taskStructuredErrorOutputSchema.parse({
    code: error.code,
    message: error.message,
    retryable: error.retryable ?? null,
    missingFields: error.missingFields ?? null,
    contextContinuity: error.contextContinuity ?? null
  });
}

function errorFromException(error: unknown): z.infer<typeof structuredErrorOutputSchema> {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const codeMatch = /^([A-Z][A-Z0-9_]{2,100}):\s*/.exec(rawMessage);
  const code = codeMatch?.[1] || "CODEX_TASK_FAILED";
  return normalizeStructuredError({
    code,
    message: codeMatch ? rawMessage.slice(codeMatch[0].length) : rawMessage,
    ...(
      code === "JOB_RETENTION_CAPACITY" || code === "STATE_STORAGE_UNAVAILABLE" ||
      code === "EXECUTION_UNAVAILABLE" || code === "CODEX_AUTH_UNAVAILABLE" ||
      code === "CODEX_AUTH_POLICY_UNAVAILABLE"
        ? { retryable: true }
        : {}
    )
  });
}

type ModelMutationToolName = keyof typeof modelMutationResultContracts;

function mutationToolResult(
  value: unknown,
  audience: "model" | "app",
  modelToolName?: ModelMutationToolName
): ToolResult {
  const publicValue = stripInternalProjectData(value);
  if (!isRecord(publicValue)) {
    throw new Error("A mutation result must be an object.");
  }
  const {
    warning,
    warnings: suppliedWarnings,
    forceStop,
    nextActions: suppliedNextActions,
    ...fields
  } = publicValue;
  const warnings = [
    ...(Array.isArray(suppliedWarnings)
      ? suppliedWarnings.filter((entry): entry is string => typeof entry === "string")
      : []),
    ...(typeof warning === "string" ? [warning] : [])
  ];
  const nextActions = [
    ...(Array.isArray(suppliedNextActions)
      ? suppliedNextActions.filter((entry) => isRecord(entry))
      : []),
    ...(isRecord(forceStop) ? [forceStop] : [])
  ];
  if (audience === "model" && !modelToolName) {
    throw new Error("A model-visible mutation projection requires its exact tool contract.");
  }
  const structured = audience === "model"
    ? (() => {
        const target = modelMutationTarget(fields, modelToolName as ModelMutationToolName);
        return modelMutationResultContracts[modelToolName as ModelMutationToolName].outputSchema.parse({
        kind: "mutation",
        ok: typeof fields.ok === "boolean" ? fields.ok : true,
        action: typeof fields.action === "string" ? fields.action : "mutation",
        ...(typeof fields.code === "string" ? { code: fields.code } : {}),
        ...(target ? { target } : {}),
        ...(
          modelToolName === "codex_activity_update" ||
          modelToolName === "codex_activity_cancel"
            ? {
                affectedJobIds: [...new Set([
                  ...stringArray(fields.cancelledJobIds),
                  ...stringArray(fields.affectedJobIds),
                  ...stringArray(fields.collateralJobIds)
                ])],
                policySource: "explicit-tool-input" as const,
                codexOutputCanMutatePolicy: false as const
              }
            : {}
        ),
        warnings,
        nextActions: nextActions.map(modelNextActionProjection)
      }) as Record<string, unknown>;
      })()
    : mutationOutputSchema.parse({
        kind: "mutation",
        ok: typeof fields.ok === "boolean" ? fields.ok : true,
        ...fields,
        warnings,
        nextActions
      }) as Record<string, unknown>;
  const contract: ToolResultContract<z.ZodType> = audience === "model"
    ? modelMutationResultContracts[modelToolName as ModelMutationToolName]
    : appMutationResultContract;
  const targetValue = isRecord(structured.target) ? structured.target.id : undefined;
  const job = isRecord(structured.job) ? structured.job : undefined;
  const agent = isRecord(structured.agent) ? structured.agent : undefined;
  const activity = isRecord(structured.activity) ? structured.activity : undefined;
  const target = targetValue || job?.jobId || agent?.agentId || activity?.activityId;
  const text = `${String(structured.action)}${target ? ` ${String(target)}` : ""}: ${structured.ok ? "succeeded" : structured.code || "not applied"}.`;
  return contractedToolResult(contract, value, structured, { text });
}

function steeringToolResult(value: unknown): ToolResult {
  const structured = codexSteerOutputSchema.parse(stripInternalProjectData(value));
  const target = structured.job?.jobId;
  const text = structured.ok
    ? `steer${target ? ` ${target}` : ""}: delivered.`
    : `steer${target ? ` ${target}` : ""}: ${structured.code || "not applied"}.`;
  return contractedToolResult(
    steerResultContract,
    value,
    structured,
    { text },
    structured.ok ? {} : { isError: true }
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function modelMutationTarget(
  fields: Record<string, unknown>,
  toolName: ModelMutationToolName
): z.infer<typeof mutationTargetOutputSchema> | null {
  const type = toolName === "codex_agent"
    ? "agent" as const
    : toolName === "codex_cancel"
      ? "job" as const
      : "activity" as const;
  const value = isRecord(fields[type]) ? fields[type] : undefined;
  const idKey = `${type}Id`;
  const id = value?.[idKey];
  if (typeof id !== "string" || !id) return null;
  const state = [value.status, value.lifecycle, value.state]
    .find((entry): entry is string => typeof entry === "string");
  return mutationTargetOutputSchema.parse({
    type,
    id,
    ...(state ? { state } : {}),
    ...(Number.isInteger(value.version) && Number(value.version) > 0
      ? { version: value.version }
      : {})
  });
}

function retainedStructuredError(result: ToolResult | undefined): Record<string, unknown> | undefined {
  if (!result || !isRecord(result.structuredContent) || !isRecord(result.structuredContent.error)) {
    return undefined;
  }
  return result.structuredContent.error;
}

function contractedToolResult<Schema extends z.ZodType>(
  contract: ToolResultContract<Schema>,
  canonical: unknown,
  structured: unknown,
  compatibility: { text?: string; content?: ToolResult["content"] },
  options: {
    isError?: boolean;
    appHydration?: Record<string, unknown>;
    protocolMeta?: Record<string, unknown>;
  } = {}
): ToolResult {
  if (contract.toolName === "codex_task") validateTaskOutput(structured);
  if (contract.toolName === "codex_status") validateModelVisibleStructuredOutput("codex_status", structured);
  if (contract.toolName === "codex_steer") validateSteerOutput(structured);
  return projectToolResult(contract, {
    canonical,
    authoritative: {
      channel: contract.channel,
      value: structured as z.input<Schema>
    },
    compatibility: {
      channel: "text-protocol-compatibility",
      ...compatibility
    },
    ...(options.isError ? { isError: true } : {}),
    ...(options.appHydration ? { appHydration: options.appHydration } : {}),
    ...(options.protocolMeta ? { protocolMeta: options.protocolMeta } : {})
  });
}

/**
 * `bridge_skill` is a model-facing read surface. Its compatibility channel is
 * intentionally a complete compact JSON mirror of the validated structured
 * result, so MCP hosts that consume `content` rather than `structuredContent`
 * receive the exact Markdown skill content, version metadata, and warnings.
 */
function bridgeSkillPrimaryContent(value: unknown): ToolResult["content"] {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error("bridge_skill cannot serialize its primary compatibility payload.");
  }
  return [{ type: "text", text }];
}

function stripInternalProjectData(value: unknown, depth = 0): unknown {
  if (depth > 20 || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => stripInternalProjectData(entry, depth + 1));
  }
  if (!isRecord(value)) return value;
  const hidden = new Set([
    "projectId",
    "project_id",
    "projectUuid",
    "project_uuid",
    "cwd",
    "projectCwd",
    "project_cwd",
    "projectCwdSnapshot",
    "project_cwd_snapshot"
  ]);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (hidden.has(key)) continue;
    const publicKey = key === "projectLabel" || key === "projectName" || key === "project_name_snapshot"
      ? "projectName"
      : key;
    output[publicKey] = stripInternalProjectData(entry, depth + 1);
  }
  return output;
}

function modelPolicyErrorResult(error: ModelPolicyError): ToolResult {
  return taskPreflightErrorResult({
    code: error.code,
    message: error.message.replace(`${error.code}: `, ""),
    policyRevision: error.policyRevision,
    nextActions: modelPolicyRecoveryActions(error)
  });
}

function executionPolicyChangedResult(error: ExecutionPolicyChangedError): ToolResult {
  return taskPreflightErrorResult({
    code: error.code,
    message: error.message.replace(`${error.code}: `, ""),
    retryable: true,
    nextActions: [guidance("The saved execution policy changed during admission. Retry the same codex_task contract with a new requestId.")]
  });
}

function executionEnvelopeChangedResult(error: ExecutionEnvelopeChangedError): ToolResult {
  return taskPreflightErrorResult({
    code: error.code,
    message: error.message.replace(`${error.code}: `, ""),
    retryable: true,
    nextActions: [
      "Refresh the Codex developer-mode connection: the installation/operator envelope or stable task contract changed.",
      "Retry with the new taskContractVersion and executionEnvelopeRef constants and a new requestId."
    ]
  });
}

function projectSelectionChangedResult(
  message: string,
  userSettings: UserSettingsStore,
  requested?: ProjectSelection
): ToolResult {
  return taskPreflightErrorResult({
    code: PROJECT_REGISTRY_CHANGED,
    message: "The selected project changed before admission. No work was admitted; resolve it through codex_status query kind=project and retry.",
    retryable: true,
    nextActions: projectRecoveryActions(userSettings, requested)
  });
}

function projectSelectionRequiredResult(
  message: string,
  userSettings: UserSettingsStore
): ToolResult {
  return taskPreflightErrorResult({
    code: "PROJECT_REQUIRED",
    message: message.replace("PROJECT_REQUIRED: ", ""),
    retryable: true,
    nextActions: projectRecoveryActions(userSettings)
  });
}

function projectStatusResult(name: string, userSettings: UserSettingsStore): ToolResult {
  const normalized = normalizeProjectName(name);
  const key = projectNameKey(normalized);
  const registry = userSettings.projectRegistry;
  const project = registry.selectableProjects.find(candidate => candidate.nameKey === key);
  const matches = registry.projects.filter(candidate => candidate.nameKey === key);
  const registered = matches.find(candidate => candidate.archivedAt === undefined) ?? matches[0];
  const code = registry.projects.length === 0 ? PROJECT_SETUP_REQUIRED
    : registered ? PROJECT_UNAVAILABLE : "PROJECT_NOT_FOUND";
  const result = {
    kind: "project" as const,
    project: project ? { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision } : null,
    ...(!project ? { error: {
      code, message: registry.projects.length === 0
        ? "No project is registered. No work was admitted."
        : registered?.archivedAt !== undefined
          ? `The requested project ${JSON.stringify(normalized)} is archived. No work was admitted.`
          : registered
            ? `The folder for requested project ${JSON.stringify(normalized)} is unavailable. No work was admitted.`
            : `No registered project has the exact name ${JSON.stringify(normalized)}. No work was admitted.`, retryable: true
    } } : {}),
    nextActions: project
      ? [projectSelectorRetryAction(project), guidance("Task permissions are determined by the bridge settings; do not send permission fields.")]
      : projectRecoveryActions(userSettings, { name: normalized }, registry)
  };
  return contractedToolResult(projectStatusResultContract, result, result,
    { text: project ? "Project selector resolved. No work was admitted." : result.error!.message },
    { isError: !project });
}

function projectRecoveryActions(
  userSettings: UserSettingsStore,
  requested?: RequestedProjectIdentity,
  registry = userSettings.projectRegistry
): z.infer<typeof modelNextActionOutputSchema>[] {
  return projectRecoveryGuidance(registry, requested, (names, remaining) =>
    guidance(
      `Look up the project intended by the user with codex_status query kind=project and the exact name. ` +
      `Selectable names include ${JSON.stringify(names)}${remaining ? ` (${remaining} more registered projects)` : ""}. ` +
      "Do not choose a first or sole project without an intended target."
    )
  );
}

function backendHandoffContractErrorResult(error: BackendHandoffContractError): ToolResult {
  return taskPreflightErrorResult({
    code: error.code,
    message: error.message.replace(`${error.code}: `, ""),
    retryable: true,
    contextContinuity: "not-migrated",
    nextActions: error.code === "BACKEND_HANDOFF_SUMMARY_REQUIRED"
      ? [
          guidance("Retry the existing Agent with context='fresh' and a concise explicit handoffSummary."),
          guidance("Only the summary is transferred; the original transcript, approvals, and backend state remain on the pinned Agent thread.")
        ]
      : [guidance("Remove handoffSummary unless this is an explicit existing-Agent backend change.")]
  });
}

function projectSetupRequiredResult(message: string): ToolResult {
  return taskPreflightErrorResult(
    {
      code: PROJECT_SETUP_REQUIRED,
      message: message.replace(`${PROJECT_SETUP_REQUIRED}: `, ""),
      nextActions: [settingsAction("Open settings and register the folder where Codex should work.")]
    },
    "setup-required"
  );
}

function agentThreadResumeErrorResult(error: AgentThreadResumeError): ToolResult {
  return taskPreflightErrorResult({
    code: error.code,
    message: error.message.replace(`${error.code}: `, ""),
    retryable: error.retryable,
    probe: error.probe,
    nextActions: error.code === "AGENT_ORPHANED"
      ? [guidance("Start an explicit fresh context for this Agent after reviewing the lost thread continuity.")]
      : error.code === "AGENT_THREAD_BUSY"
        ? [guidance("Wait for the active turn to finish and retry the same logical request.")]
        : [guidance("Retry the same logical request; do not replace or detach the Agent thread.")]
  });
}

function taskPreflightErrorResult(
  errorValue: unknown,
  status: "failed" | "setup-required" = "failed"
): ToolResult {
  const nextActions = structuredErrorNextActions(errorValue);
  const error = normalizeStructuredError(errorValue);
  const structured = codexTaskOutputSchema.parse({
    contractVersion: "4",
    kind: "task",
    state: status,
    terminal: true,
    delivery: "none",
    replay: false,
    jobId: null,
    activityId: null,
    agentId: null,
    threadId: null,
    projectName: null,
    requestId: null,
    approvedFollowups: null,
    jobVersion: null,
    activityVersion: null,
    backend: null,
    sandbox: null,
    completionDeliveryPolicy: null,
    requestedModel: null,
    requestedReasoningEffort: null,
    actualModel: null,
    actualReasoningEffort: null,
    rerouted: false,
    rerouteReason: null,
    resultAvailability: "unavailable",
    resultOmitted: false,
    answer: null,
    error: taskStructuredErrorProjection(error),
    warnings: [],
    nextActions
  });
  return contractedToolResult(
    taskErrorResultContract,
    errorValue,
    structured,
    { text: taskCompatibilityText(structured) },
    { isError: true }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInputInteraction(interaction: CodexPendingInteraction): boolean {
  return interaction.kind === "user-input" || interaction.kind === "mcp-elicitation";
}
