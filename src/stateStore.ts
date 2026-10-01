import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import {StateDatabaseShutdownFence} from "./stateDatabaseShutdownFence.js";
import type {ShutdownResult} from "./shutdown.js";
import { V31_COGATE_UNIFIED_MIGRATION_SCHEMA } from "./cogateUnifiedSchema.js";
import { assertCoGateUnifiedRuntimeAdmission } from "./cogateRuntimeAdmission.js";
import { loadSecurityHmacKeyring, SCOPE_HMAC_PURPOSE, EXECUTION_POLICY_HMAC_PURPOSE,
  SECURITY_ROTATION_REQUIRED_META_KEY, type SecurityHmacPurpose } from "./cogateLegacySecurityRead.js";
import { readCoGateScopeRoutingSnapshot, type CoGateScopeIdentity,
  type CoGateScopeRoutingInspection } from "./cogateScopeRoutingRead.js";
import { McpEventStore } from "./mcpEventStore.js";
import { TaskFollowupStore, issueApprovedFollowups, readFollowupReference, type ApprovedFollowup, type FollowupReference } from "./taskFollowups.js";
import { canonicalHumanText, parseJsonTextStrict } from "./textIntegrity.js";
import {
  CURRENT_STATE_SCHEMA,
  CURRENT_STATE_SCHEMA_VERSION,
  V20_ASYNC_EXECUTION_MIGRATION_SCHEMA,
  V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA,
  V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA,
  V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA,
  V26_MODEL_DESCRIPTION_VERSIONS_MIGRATION_SCHEMA,
  V27_DECISION_CARD_RETIREMENT_MIGRATION_SCHEMA,
  V28_JOB_HISTORY_INDEX_MIGRATION_SCHEMA,
  V29_BACKGROUND_WORK_INDEX_MIGRATION_SCHEMA,
  V30_SESSION_AUTH_BOUNDARY_MIGRATION_SCHEMA
} from "./stateSchema.js";
import type { ModelDescriptionHistoryPage, ModelDescriptionOverrides } from "./modelDescriptions.js";
import {
  MAINTENANCE_COMMAND_RECEIPT_RETENTION_BATCH,
  MAINTENANCE_COMMAND_RECEIPT_RETENTION_MS,
  OPERATIONAL_COMMAND_RECEIPT_RESULT_MAX_BYTES,
  V25_OPERATIONAL_COMMAND_RECEIPT_MIGRATION_SCHEMA,
  type OperationalCommandApplication,
  type OperationalCommandExecution,
  type OperationalCommandReceipt,
  type OperationalCommandReceiptInput
} from "./operationalCommandReceipt.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  STATE_MIGRATION_CATALOG_VERSION,
  SUPPORTED_STATE_SCHEMA_VERSIONS,
  stateMigration,
  stateMigrationPath,
  type StateMigrationCatalogEntry
} from "./stateCompatibility.js";
import {
  prepareStateDatabaseOpen,
  type StateDatabaseOpenLease,
  type StateMigrationLease
} from "./stateDatabaseLifecycle.js";
import {
  createMigrationBackupMetadata,
  migrationBackupMetadataPath,
  requireMigrationBackupMetadata
} from "./stateBackup.js";
import {
  V15_WORK_HISTORY_MIGRATION_SCHEMA,
  WorkHistoryStore,
  historyRetentionDays,
  type HistoryRetentionCandidate
} from "./workHistory.js";
import {
  V17_AUTOMATIC_RECOVERY_MIGRATION_SCHEMA,
  AutomaticRecoveryStore
} from "./automaticRecovery.js";
import {
  V14_EVENT_RETENTION_MIGRATION_SCHEMA,
  EventRetention,
  sanitizeRetainedJobSummary
} from "./eventRetention.js";
import {
  V14_THREAD_CONNECTION_MIGRATION_SCHEMA,
  ThreadConnectionStore,
  type ThreadPersistence
} from "./threadConnections.js";
import { QuestionStore, V13_QUESTION_STORE_MIGRATION_SCHEMA } from "./questionStore.js";
import { V24_DECISION_CARD_MIGRATION_SCHEMA } from "./decisionCardStore.js";
import {
  DashboardReadModel,
  StatusReadModel,
  type DashboardArchivedCounts,
  type DashboardArchivedJobRow,
  type DashboardRepresentativeOrder
} from "./stateReadModels.js";
import type {
  OperationalJobRetentionCommand,
  OperationalJobRetentionResult,
  OperationalStateOperationPhase
} from "./stateService.js";
import {
  ACTIVITY_COMPLETION_TRIGGERS,
  ACTIVITY_HANDOFF_POLICIES,
  ACTIVITY_JOB_STATUSES,
  ACTIVITY_KINDS,
  ACTIVITY_LIFECYCLES,
  ACTIVITY_VERIFICATION_STATES,
  ACTIVITY_WAITING_ON,
  deriveActivityBarrier,
  isActiveActivityJobStatus,
  isTerminalActivityJobStatus,
  valueIsOneOf,
  type ActivityCompletionTrigger,
  type ActivityHandoffPolicy,
  type ActivityJobCounts,
  type ActivityKind,
  type ActivityVerificationEvidence,
  type ActivityVerificationState,
  type BridgeActivity
} from "./activity.js";
import {
  AGENT_CONTEXT_MODES,
  AGENT_LIFECYCLES,
  canonicalAgentName,
  isAgentContextMode,
  isAgentLifecycle,
  normalizeAgentName,
  type ActivityAgentAssignment,
  type AgentContextMode,
  type BridgeAgent,
  type BridgeAgentLifecycle,
  type BridgeAgentThread
} from "./agent.js";
import {
  MAX_REGISTERED_PROJECTS,
  PROJECT_ARCHIVED,
  PROJECT_CWD_CONFLICT,
  PROJECT_CWD_STILL_PINNED,
  PROJECT_DELETE_REQUIRES_ARCHIVE,
  PROJECT_LIMIT_EXCEEDED,
  PROJECT_NAME_CONFLICT,
  PROJECT_NOT_FOUND,
  PROJECT_OPERATION_CONFLICT,
  PROJECT_REGISTRY_CHANGED,
  PROJECT_REGISTRY_REVISION_CONFLICT,
  PROJECT_SETUP_REQUIRED,
  PROJECT_UNAVAILABLE,
  canonicalProjectCwd,
  createProjectRef,
  PROJECT_CONTEXT_CONFLICT,
  normalizeProjectId,
  normalizeProjectName,
  normalizeProjectRef,
  projectNameKey,
  type ProjectRegistryOperation,
  type ProjectRegistrySnapshot,
  type RuntimeProjectSelection,
  type ProjectTarget
} from "./projectRegistry.js";
import {
  CANCELLATION_REASON_MAX_LENGTH,
  CANCELLATION_SOURCES,
  JOB_TERMINAL_ORIGINS,
  type BeginCancellationOperationInput,
  type CancellationIntentRecord,
  type CancellationIntentStatus,
  type CancellationOperationRecord,
  type CancellationOperationStatus,
  type CancellationPresentation,
  type CancellationSource,
  type CancellationTarget,
  type CreateCancellationIntentInput,
  type JobTerminalOrigin
} from "./cancellation.js";

export const STATE_DATABASE_BUSY_TIMEOUT_MS = 5_000;

const CURRENT_SCHEMA_VERSION = CURRENT_STATE_SCHEMA_VERSION;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANCELLATION_REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const TRANSPORT_OBSERVATION_LIMIT = 1_000;

type SessionRowInput = {
  threadId: string;
  authBoundary?: string;
  scopeId: string;
  backendKind?: string;
  cwd: string;
  sandbox?: string;
  sessionId?: string;
  forkedFromThreadId?: string;
  projectId?: string;
  projectName?: string;
  visibleInCodexApp?: boolean;
  persistence?: ThreadPersistence;
  selection?: unknown;
  policyRevision?: number;
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt: number;
};

type JobRowInput = {
  mcpPrincipal?: string;
  approvedFollowups?: ApprovedFollowup[];
  followup?: FollowupReference;
  jobId: string;
  scopeId: string;
  requestId: string;
  status: string;
  updatedAt: number;
  sourceThreadId?: string;
  activityId?: string;
  threadId?: string;
  backendKind?: string;
  bridgeInstanceId?: string;
  workerId?: string;
  workerGeneration?: number;
  workerPid?: number;
  threadPersistence?: ThreadPersistence;
  upstreamRequestId?: string;
  terminalVersion?: number;
  agentId?: string;
  contextMode?: AgentContextMode;
  projectId?: string;
  projectName?: string;
  cwd?: string;
  sandbox?: string;
  createdAt?: number;
  version?: number;
  lastProgressAt?: number;
  lastProgress?: unknown;
  publicEvents?: unknown[];
  inputEvents?: unknown[];
  pendingInteractions?: unknown[];
  sessionDecision?: { threadId?: string };
  terminalOrigin?: JobTerminalOrigin;
  cancellationIntentId?: string;
  completionDeliveryPolicy?: "live-card" | "direct-wait";
};

/**
 * A persisted Job payload hydrated with the canonical columns owned by the
 * state store. Feature-specific payload fields remain unknown, while callers
 * can safely inspect the durable handles and lifecycle fields below.
 */
export type StoredJobRecord = Record<string, unknown> & {
  jobId: string;
  scopeId: string;
  requestId: string;
  activityId: string;
  threadId?: string;
  sourceThreadId?: string;
  status: string;
  backendKind: string;
  projectId?: string;
  projectName?: string;
  cwd: string;
  sandbox: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  lastProgressAt: number;
};

type JobProgressStateInput = {
  updatedAt: number;
  version: number;
  lastProgressAt: number;
  lastProgress?: unknown;
  pendingInteractions: unknown[];
};

type JobProgressStorageRow = {
  job_id: string;
  request_id: string;
  activity_id: string;
  scope_id: string;
  status: string;
  agent_id: string | null;
};

type JobProgressUpdateResult = {
  row: JobProgressStorageRow;
  status: string;
  resumedFromTerminationFailure: boolean;
  agentStateChanged: boolean;
};

export type DashboardRetainedJobSummary = {
  jobId: string;
  scopeId: string;
  activityId: string;
  agentId?: string;
  backendKind?: string;
  status: string;
  createdAt?: number;
  updatedAt: number;
  execution?: {
    model: string;
    reasoningEffort: string;
    serviceTier?: string;
    reroutedModel?: string;
  };
};

export type ArchivedJobAdmissionReceipt = {
  jobId: string;
  requestId: string;
  status: string;
};

type JsonRow = { payload: string };
type CountRow = { count: number };
type ProjectStorageRow = {
  project_id: string;
  project_ref: string;
  project_revision: number;
  name: string;
  name_key: string;
  cwd: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  deleted_at: number | null;
};
type LegacyProjectStorageRow = Omit<
  ProjectStorageRow,
  "project_ref" | "project_revision" | "deleted_at"
>;
type ProjectRegistryStorageRow = {
  registry_revision: number;
  updated_at: number;
};
export type SettingsStorageRecord = {
  settingsRevision: number;
  updatedAt: number | null;
  payload: unknown;
};
type JobStorageRow = JsonRow & {
  job_id: string;
  scope_id: string;
  request_id: string;
  activity_id: string;
  thread_id: string | null;
  source_thread_id: string | null;
  backend_kind: string;
  bridge_instance_id: string | null;
  worker_id: string | null;
  worker_generation: number | null;
  upstream_request_id: string | null;
  terminal_version: number | null;
  agent_id: string | null;
  context_mode: string | null;
  project_id: string | null;
  project_name: string | null;
  cwd: string;
  sandbox: string;
  created_at: number;
  updated_at: number;
  job_version: number;
  last_progress_at: number;
  last_progress: string | null;
  terminal_origin: string | null;
  cancellation_intent_id: string | null;
  status: string;
  public_events: string;
  pending_interactions: string;
};
type PreviousJobRow = {
  scope_id: string;
  activity_id: string;
  thread_id: string | null;
  status: string;
  backend_kind: string;
  bridge_instance_id: string | null;
  terminal_version: number | null;
  agent_id: string | null;
  context_mode: string | null;
  source_thread_id: string | null;
  cwd: string;
  sandbox: string;
  created_at: number;
  job_version: number;
  last_progress_at: number;
  last_progress: string | null;
  terminal_origin: string | null;
  cancellation_intent_id: string | null;
  project_id: string | null;
  project_name: string | null;
  pinned_cwd: string | null;
  archived_at: number | null;
  completion_delivery_policy: string;
};
type ActivityStorageRow = {
  activity_id: string;
  scope_id: string;
  project_id: string | null;
  project_name: string | null;
  pinned_cwd: string | null;
  continuation_of_activity_id: string | null;
  card_generation: number;
  title: string;
  kind: string;
  handoff_policy: string;
  completion_trigger: string;
  lifecycle: string;
  waiting_on: string;
  verification: string;
  version: number;
  completion_version: number;
  legacy: number;
  created_at: number;
  updated_at: number;
  sealed_at: number | null;
  completed_at: number | null;
  total_jobs: number;
  running_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  interrupted_jobs: number;
  cancelled_jobs: number;
  terminal_jobs: number;
};

export type CreateActivityInput = {
  activityId?: string;
  scopeId: string;
  projectId?: string;
  projectName?: string;
  /** Internal canonical path; never include this in ordinary model-facing output. */
  projectCwd?: string;
  continuationOfActivityId?: string;
  title?: string;
  kind?: ActivityKind;
  handoffPolicy?: ActivityHandoffPolicy;
  completionTrigger?: ActivityCompletionTrigger;
  legacy?: boolean;
  now?: number;
};

type AgentStorageRow = {
  agent_id: string;
  scope_id: string;
  agent_name: string;
  normalized_name: string;
  lifecycle: string;
  current_thread_id: string | null;
  current_job_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
  orphaned_reason: string | null;
};

type AgentThreadStorageRow = {
  thread_id: string;
  session_id: string | null;
  agent_id: string;
  scope_id: string;
  project_id: string | null;
  project_name: string | null;
  backend_kind: string;
  cwd: string;
  sandbox: string;
  context_mode: string;
  is_current: number;
  linked_at: number;
  replaced_at: number | null;
  forked_from_thread_id: string | null;
};

export type ActivityProjectAdmission = {
  projectId: string;
  projectName: string;
  projectCwd: string;
};

type ActivityAgentStorageRow = {
  assignment_id: string;
  activity_id: string;
  agent_id: string;
  role: string;
  context_mode: string;
  assigned_at: number;
  released_at: number | null;
};

export type ActivityEventRecord = {
  eventId: number;
  activityId: string;
  scopeId: string;
  scopeVersion: number;
  eventType: string;
  createdAt: number;
  payload: unknown;
};

export type JobEventRecord = {
  eventId: number;
  jobId: string;
  activityId: string;
  scopeId: string;
  scopeVersion: number;
  eventType: string;
  status: string;
  createdAt: number;
  payload: unknown;
};

export type CompletionOutboxRecord = {
  outboxId: number;
  activityId: string;
  scopeId: string;
  completionVersion: number;
  channel: "notify" | "verify";
  payload: unknown;
  attemptCount: number;
  nextAttemptAt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  createdAt: number;
};

export const JOB_COMPLETION_DELIVERY_STATES = [
  "pending",
  "leased",
  "host-rejected",
  "host-accepted",
  "acceptance-unknown",
  "result-read"
] as const;
export type JobCompletionDeliveryState = (typeof JOB_COMPLETION_DELIVERY_STATES)[number];
export const JOB_COMPLETION_RESULT_READ_SOURCES = [
  "completion-receipt",
  "direct-job-query"
] as const;
export type JobCompletionResultReadSource =
  (typeof JOB_COMPLETION_RESULT_READ_SOURCES)[number];
export type JobCompletionDeliveryRecord = {
  jobId: string;
  scopeId: string;
  terminalVersion: number;
  receipt: string;
  state: JobCompletionDeliveryState;
  attemptCount: number;
  nextAttemptAt?: number;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  lastHostRejectedAt?: number;
  lastHostError?: string;
  hostAcceptedAt?: number;
  acceptanceUnknownAt?: number;
  resultReadAt?: number;
  resultReadSource?: JobCompletionResultReadSource;
  completionResultOfferedAt?: number;
  directResultOfferedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export const JOB_COMPLETION_MAX_DELIVERY_ATTEMPTS = 3;

/**
 * An accepted UI message cannot be observed end-to-end. Keep an uncertain
 * completion out of automatic retries until a future verified route can make
 * an explicit recovery decision.
 */
export const COMPLETION_OUTBOX_UNCERTAIN_HOLD_AT = 8_640_000_000_000_000;

export type BridgeInstanceRecord = {
  instanceId: string;
  startedAt: number;
  stoppedAt?: number;
  terminationReason?: string;
  processId: number;
};

export const TRANSPORT_OBSERVATION_KINDS = [
  "http-request-aborted",
  "http-response-detached",
  "mcp-handler-aborted",
  "status-wait-aborted",
  "activity-watch-aborted",
  "presentation-superseded"
] as const;

export type TransportObservationKind = (typeof TRANSPORT_OBSERVATION_KINDS)[number];

export type TransportObservationRecord = {
  observationId: number;
  kind: TransportObservationKind;
  scopeId?: string;
  jobId?: string;
  activityId?: string;
  toolName?: string;
  callerRequestDigest?: string;
  bridgeInstanceId: string;
  reasonCode: string;
  createdAt: number;
};

export const STEERING_DELIVERY_STATUSES = [
  "prepared",
  "dispatching",
  "delivered",
  "not-delivered",
  "uncertain"
] as const;

export type SteeringDeliveryStatus = (typeof STEERING_DELIVERY_STATUSES)[number];

export type SteeringDeliveryRecord = {
  scopeId: string;
  requestId: string;
  actionHash: string;
  jobId: string;
  expectedJobVersion: number;
  promptSha256: string;
  status: SteeringDeliveryStatus;
  bridgeInstanceId: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
  dispatchedAt?: number;
  completedAt?: number;
};

export type BeginSteeringDeliveryInput = {
  scopeId: string;
  requestId: string;
  actionHash: string;
  jobId: string;
  expectedJobVersion: number;
  promptSha256: string;
  now?: number;
};

export type BridgeStateStoreOptions = {
  file: string;
  /** Query-only projection connection. It never migrates or registers a writer. */
  readOnly?: boolean;
  /** Diagnostic SQL trace hook used by bounded-path audits and tests. */
  traceSql?: (sql: string) => void;
  /**
   * Privacy-safe transaction boundary used by an enclosing process
   * supervisor. It never receives SQL, identifiers, payloads, or results.
   */
  onTransactionPhase?: (phase: OperationalStateOperationPhase) => void;
  /**
   * Storage-boundary observations for fail-closed readiness. Callbacks are
   * diagnostic only and can never change transaction success or failure.
   */
  onTransactionCommitted?: () => void;
  onTransactionFailure?: (error: unknown) => void;
  /** Test hook fired in the crash window after schema commit and before provenance commit. */
  onMigrationSchemaCommitted?: (progress: StateMigrationProgress) => void;
  /** Test/diagnostic hook fired after each durable schema checkpoint. */
  onMigrationProgress?: (progress: StateMigrationProgress) => void;
};

export type StateMigrationProgress = {
  migrationId: string;
  sourceSchema: number;
  targetSchema: number;
  originalSourceSchema: number;
};

/**
 * Durable bridge state backed by one SQLite database. Registry snapshots are
 * retained for compatibility, while Activity/job state changes share one
 * transaction, one scope version, and an idempotent completion outbox.
 */
export class BridgeStateStore {
  readonly questions: QuestionStore;
  readonly threadConnections: ThreadConnectionStore;
  readonly eventRetention: EventRetention;
  readonly workHistory: WorkHistoryStore;
  readonly automaticRecovery: AutomaticRecoveryStore;
  readonly dashboardReadModel: DashboardReadModel;
  readonly statusReadModel: StatusReadModel;
  private database!: Database.Database;
  private databaseShutdown!: StateDatabaseShutdownFence;
  private readonly databaseLease: StateDatabaseOpenLease | null;
  private readonly migrationLease: StateMigrationLease | null;
  private readonly currentInstanceId = randomUUID();
  private transactionDepth = 0;
  private closed = false;

  constructor(private readonly options: BridgeStateStoreOptions) {
    if (!options.readOnly && options.file !== ":memory:") {
      mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
    }
    this.databaseLease = options.readOnly ? null : prepareStateDatabaseOpen(options.file);
    this.migrationLease = this.databaseLease?.requiresMigration
      ? this.databaseLease as StateMigrationLease
      : null;
    let openedDatabase: Database.Database | undefined;
    try {
      const databaseFile = this.databaseLease?.databaseFile ?? options.file;
      const databaseOptions = {
        ...(options.readOnly ? { readonly: true, fileMustExist: true } : {}),
        ...(options.traceSql
          ? { verbose: (message?: unknown) => options.traceSql?.(String(message ?? "")) }
          : {})
      };
      this.databaseShutdown = new StateDatabaseShutdownFence(new Database(databaseFile,databaseOptions));
      this.database = this.databaseShutdown.database;
      openedDatabase = this.database;
      this.database.pragma(`busy_timeout = ${STATE_DATABASE_BUSY_TIMEOUT_MS}`);
      if (options.readOnly) {
        this.database.pragma("query_only = ON");
        const existingVersion = this.getMeta("schema_version");
        if (existingVersion !== CURRENT_SCHEMA_VERSION) {
          throw new Error(
            `Read projection requires current state schema ${CURRENT_SCHEMA_VERSION}; ` +
            `found ${existingVersion ?? "unknown"}.`
          );
        }
        assertCoGateUnifiedRuntimeAdmission(this.database);
        this.questions = new QuestionStore(this.database, { readOnly: true });
        this.eventRetention = new EventRetention(this.database, {
          readSummary: (jobId) => this.readJobSummary(jobId),
          saveSummary: (jobId, summary) => this.saveJobSummary(jobId, summary)
        }, {
          deleteActivityEvents: (olderThan, batchSize, retainedLimit) =>
            this.deleteActivityEventsForRetention(olderThan, batchSize, retainedLimit),
          deleteExpiredResultHolds: (now, limit) =>
            this.deleteExpiredResultHoldsForRetention(now, limit)
        }, { readOnly: true });
        this.workHistory = new WorkHistoryStore(
          this.database,
          (candidate, now) => this.expireHistoryProjection(candidate, now)
        );
        this.automaticRecovery = new AutomaticRecoveryStore(this.database);
        this.threadConnections = new ThreadConnectionStore(this.database);
        this.dashboardReadModel = new DashboardReadModel(this.database);
        this.statusReadModel = new StatusReadModel(this.database);
        return;
      }
      if (this.migrationLease) this.claimExclusiveMigrationConnection();
      this.configureDatabaseConnection();
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS bridge_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `);

      const existingVersion = this.getMeta("schema_version");
      if (
        existingVersion !== undefined &&
        !SUPPORTED_STATE_SCHEMA_VERSIONS.has(Number(existingVersion))
      ) {
        throw new Error(`Unsupported bridge state database schema version: ${existingVersion}.`);
      }

      let reopenAfterMigration = false;
      if (existingVersion === undefined) {
        this.transaction(() => {
          this.database.exec(CURRENT_STATE_SCHEMA);
          this.database.exec(V20_ASYNC_EXECUTION_MIGRATION_SCHEMA);
          this.database.exec(V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA);
          this.database.exec(V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA);
          this.database.exec(V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA);
          this.database.exec(V24_DECISION_CARD_MIGRATION_SCHEMA);
          this.database.exec(V25_OPERATIONAL_COMMAND_RECEIPT_MIGRATION_SCHEMA);
          this.database.exec(V26_MODEL_DESCRIPTION_VERSIONS_MIGRATION_SCHEMA);
          this.database.exec(V27_DECISION_CARD_RETIREMENT_MIGRATION_SCHEMA);
          this.database.exec(V28_JOB_HISTORY_INDEX_MIGRATION_SCHEMA);
          this.database.exec(V29_BACKGROUND_WORK_INDEX_MIGRATION_SCHEMA);
          this.database.exec(V30_SESSION_AUTH_BOUNDARY_MIGRATION_SCHEMA);
          this.database.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA);
          this.setMeta("schema_version", CURRENT_SCHEMA_VERSION);
          this.setMeta("schema_v21_created_at", new Date().toISOString());
          this.setMeta("schema_v22_created_at", new Date().toISOString());
          this.setMeta("schema_v23_created_at", new Date().toISOString());
          this.setMeta("schema_v24_created_at", new Date().toISOString());
          this.setMeta("schema_v25_created_at", new Date().toISOString());
          this.setMeta("schema_v26_created_at", new Date().toISOString());
          this.setMeta("schema_v27_created_at", new Date().toISOString());
          this.setMeta("schema_v28_created_at", new Date().toISOString());
          this.setMeta("schema_v29_created_at", new Date().toISOString());
          this.setMeta("schema_v30_created_at", new Date().toISOString());
          this.setMeta("schema_v31_created_at", new Date().toISOString());
          this.setMeta("schema_v31_cogate_storage", "workspace-hmac-and-lineage-evidence-v1");
          this.setMeta("state_migration_catalog_version", String(STATE_MIGRATION_CATALOG_VERSION));
          this.setMeta("state_database_id", randomUUID());
          this.recordSchemaOrigin("fresh");
        });
      } else if (existingVersion !== CURRENT_SCHEMA_VERSION) {
        this.prepareV19Migration(existingVersion);
        this.migrateSupportedSchema();
        this.validateStateMigrationProvenance();
        this.migrationLease?.reportVerifying();
        this.verifyOpenDatabase();
        reopenAfterMigration = true;
      } else {
        this.reconcilePendingMigration();
        this.validateStateMigrationProvenance();
        if (this.migrationLease) {
          this.migrationLease.reportVerifying();
          this.verifyOpenDatabase();
          reopenAfterMigration = true;
        }
        if (
          this.getMeta("state_last_migration_id") === undefined &&
          this.getMeta("state_schema_origin") === undefined
        ) {
          this.transaction(() => this.recordSchemaOrigin("pre-contract-current"));
        }
      }
      if (reopenAfterMigration) {
        // Release SQLite's exclusive migration lock only while the alias-safe
        // startup lease is still held. A second current runtime cannot enter
        // before this instance has registered durable ownership below.
        this.database.close();
        openedDatabase = undefined;
        this.databaseShutdown = new StateDatabaseShutdownFence(new Database(databaseFile,databaseOptions));
        this.database = this.databaseShutdown.database;
        openedDatabase = this.database;
        this.database.pragma(`busy_timeout = ${STATE_DATABASE_BUSY_TIMEOUT_MS}`);
        this.configureDatabaseConnection();
      }
      this.questions = this.transaction(() => {
        const questions = new QuestionStore(this.database);
        if (Object.values(questions.startupMaintenance).some((count) => count > 0)) {
          this.setMeta("state_startup_maintenance_last", JSON.stringify({
            reason: "question-expiry-and-dispatch-recovery",
            at: new Date().toISOString(),
            ...questions.startupMaintenance
          }));
        }
        return questions;
      });
      this.eventRetention = new EventRetention(this.database, {
        readSummary: (jobId) => this.readJobSummary(jobId),
        saveSummary: (jobId, summary) => this.saveJobSummary(jobId, summary)
      }, {
        deleteActivityEvents: (olderThan, batchSize, retainedLimit) =>
          this.deleteActivityEventsForRetention(olderThan, batchSize, retainedLimit),
        deleteExpiredResultHolds: (now, limit) =>
          this.deleteExpiredResultHoldsForRetention(now, limit)
      });
      this.workHistory = new WorkHistoryStore(
        this.database,
        (candidate, now) => this.expireHistoryProjection(candidate, now)
      );
      this.automaticRecovery = new AutomaticRecoveryStore(this.database);
      this.threadConnections = new ThreadConnectionStore(this.database);
      this.dashboardReadModel = new DashboardReadModel(this.database);
      this.statusReadModel = new StatusReadModel(this.database);
      if (this.getMeta("state_database_id") === undefined) {
        this.transaction(() => this.setMeta("state_database_id", randomUUID()));
      }
      this.registerBridgeInstance();
      this.enforcePrivateFileModes();
      this.databaseLease?.complete();
    } catch (error) {
      try {
        openedDatabase?.close();
      } catch {
        // Preserve the original startup failure.
      }
      this.databaseLease?.fail(error);
      throw error;
    }
  }

  get persistent(): boolean {
    return this.options.file !== ":memory:";
  }

  get persistencePath(): string | null {
    return this.persistent ? this.options.file : null;
  }

  get schemaVersion(): number {
    return Number(this.getMeta("schema_version"));
  }

  get bridgeInstanceId(): string {
    return this.currentInstanceId;
  }

  /** Stable identity of this authoritative database across process generations. */
  get databaseId(): string {
    const value = this.getMeta("state_database_id");
    if (!value) throw new Error("STATE_DATABASE_ID_MISSING: Operational database identity is unavailable.");
    return value;
  }

  /** Test-only fault injection on the already-open writer connection. */
  freezePageCountForTesting(): number {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("State page-count fault injection is available only in tests.");
    }
    const pageCount = Number(this.database.pragma("page_count", { simple: true }));
    this.database.pragma(`max_page_count = ${pageCount}`);
    return pageCount;
  }

  /**
   * Apply one semantic state command and persist its compact result atomically.
   * Reusing a command ID with an identical payload returns the first result;
   * reusing it for different work is a hard conflict.
   */
  executeOperationalCommand<T extends Record<string, unknown>>(
    input: OperationalCommandReceiptInput,
    apply: () => OperationalCommandApplication<T>,
    observePhase?: (phase: OperationalStateOperationPhase) => void
  ): OperationalCommandExecution<T> {
    validateOperationalCommandReceiptInput(input);
    return this.transaction(() => {
      const existing = this.readOperationalCommandReceipt<T>(input.commandId);
      if (existing) {
        if (
          existing.operation !== input.operation ||
          existing.payloadSha256 !== input.payloadSha256 ||
          existing.aggregateKey !== input.aggregateKey
        ) {
          throw new Error(
            "STATE_COMMAND_CONFLICT: The command ID was already committed with a different payload."
          );
        }
        return { receipt: existing, replayed: true };
      }

      const applied = apply();
      if (
        applied.resultingVersion !== undefined &&
        (!Number.isSafeInteger(applied.resultingVersion) || applied.resultingVersion < 0)
      ) {
        throw new Error("STATE_COMMAND_RESULT_INVALID: resultingVersion must be a non-negative integer.");
      }
      const resultJson = JSON.stringify(applied.result);
      if (
        resultJson === undefined ||
        Buffer.byteLength(resultJson, "utf8") > OPERATIONAL_COMMAND_RECEIPT_RESULT_MAX_BYTES
      ) {
        throw new Error(
          `STATE_COMMAND_RESULT_TOO_LARGE: Command receipts are limited to ${OPERATIONAL_COMMAND_RECEIPT_RESULT_MAX_BYTES} bytes.`
        );
      }
      const parsedResult = parseJsonTextStrict(
        resultJson,
        "operational command receipt result"
      );
      if (!isRecord(parsedResult) || Array.isArray(parsedResult)) {
        throw new Error("STATE_COMMAND_RESULT_INVALID: Command receipt result must be a JSON object.");
      }
      const committedAt = input.committedAt ?? Date.now();
      if (!Number.isSafeInteger(committedAt) || committedAt < 0) {
        throw new Error("STATE_COMMAND_RECEIPT_INVALID: committedAt must be a non-negative integer.");
      }
      this.database.prepare(`
        INSERT INTO operational_command_receipts(
          command_id, operation, payload_sha256, aggregate_key, resulting_version,
          result, worker_generation, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.commandId,
        input.operation,
        input.payloadSha256,
        input.aggregateKey ?? null,
        applied.resultingVersion ?? null,
        resultJson,
        input.workerGeneration,
        committedAt
      );
      return {
        receipt: {
          commandId: input.commandId,
          operation: input.operation,
          payloadSha256: input.payloadSha256,
          ...(input.aggregateKey !== undefined ? { aggregateKey: input.aggregateKey } : {}),
          ...(applied.resultingVersion !== undefined
            ? { resultingVersion: applied.resultingVersion }
            : {}),
          result: parsedResult as T,
          workerGeneration: input.workerGeneration,
          committedAt
        },
        replayed: false
      };
    }, observePhase);
  }

  getOperationalCommandReceipt<T = unknown>(
    commandId: string
  ): OperationalCommandReceipt<T> | undefined {
    if (!UUID_PATTERN.test(commandId)) {
      throw new Error("STATE_COMMAND_RECEIPT_INVALID: commandId must be a UUID.");
    }
    return this.readOperationalCommandReceipt<T>(commandId);
  }

  getLastOperationalCommandCommitAt(): number | undefined {
    const row = this.database.prepare(`
      SELECT MAX(committed_at) AS committed_at
        FROM operational_command_receipts
    `).get() as { committed_at: number | null };
    return row.committed_at === null ? undefined : Number(row.committed_at);
  }

  /**
   * Delete only old idempotent maintenance receipts. Business commands keep
   * their domain request IDs as the long-lived idempotency authority and need
   * a separate reference-aware policy before they can enter this cleanup.
   */
  maintainOperationalCommandReceiptRetention(
    now = Date.now(),
    limit = MAINTENANCE_COMMAND_RECEIPT_RETENTION_BATCH
  ): { receiptsRemoved: number } {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("STATE_COMMAND_RECEIPT_RETENTION_INVALID: now must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("STATE_COMMAND_RECEIPT_RETENTION_INVALID: limit must be a positive integer.");
    }
    const boundedLimit = Math.min(MAINTENANCE_COMMAND_RECEIPT_RETENTION_BATCH, limit);
    const cutoff = Math.max(0, now - MAINTENANCE_COMMAND_RECEIPT_RETENTION_MS);
    return this.transaction(() => {
      const result = this.database.prepare(`
        DELETE FROM operational_command_receipts
         WHERE command_id IN (
           SELECT command_id
             FROM operational_command_receipts
            WHERE operation = 'maintain' AND committed_at < ?
            ORDER BY committed_at ASC, command_id ASC
            LIMIT ?
         )
      `).run(cutoff, boundedLimit);
      return { receiptsRemoved: result.changes };
    });
  }

  /** Record the point after which snapshot rollback could discard admitted work. */
  markServiceOpen(transport: "http" | "stdio"): void {
    this.transaction(() => {
      this.setMeta("state_runtime_product_version", PRODUCT_INFO.version);
      this.setMeta("state_runtime_build_id", BRIDGE_BUILD_INFO.id);
      const migrationId = this.getMeta("state_last_migration_id");
      if (!migrationId) return;
      this.setMeta("state_service_opened_after_migration", "1");
      this.setMeta("state_service_opened_at", new Date().toISOString());
      this.setMeta("state_service_opened_transport", transport);
      this.setMeta("state_service_opened_migration_id", migrationId);
    });
  }

  private claimExclusiveMigrationConnection(): void {
    const mode = String(this.database.pragma("locking_mode = EXCLUSIVE", { simple: true }));
    if (mode.toLowerCase() !== "exclusive") {
      throw new Error("Could not place the state database in exclusive migration mode.");
    }
    this.database.exec("BEGIN EXCLUSIVE");
    try {
      const version = this.getMeta("schema_version");
      if (version !== String(this.migrationLease?.observedSchema)) {
        throw new Error(
          `Bridge state schema changed to ${version ?? "unknown"} before exclusive migration access.`
        );
      }
      const liveOwners = (this.database.prepare(
        "SELECT DISTINCT process_id FROM bridge_instances WHERE stopped_at IS NULL"
      ).all() as Array<{ process_id: number }>).map((row) => Number(row.process_id))
        .filter((processId) => Number.isSafeInteger(processId) && processIsAlive(processId));
      if (liveOwners.length > 0) {
        throw new Error(
          `Bridge state upgrade requires every database owner to stop; live process(es): ${liveOwners.join(", ")}.`
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.inTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private configureDatabaseConnection(): void {
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
  }

  private verifyOpenDatabase(): void {
    if (this.getMeta("schema_version") !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Bridge state migration verification found schema ${this.getMeta("schema_version") ?? "unknown"}; ` +
        `expected ${CURRENT_SCHEMA_VERSION}.`
      );
    }
    const integrity = this.database.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (
      integrity.length !== 1 ||
      String(Object.values(integrity[0] || {})[0]).toLowerCase() !== "ok"
    ) {
      throw new Error("Bridge state migration failed PRAGMA integrity_check.");
    }
    const violations = this.database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `Bridge state migration produced ${violations.length} foreign-key violation(s).`
      );
    }
  }

  transaction<T>(
    operation: () => T,
    observePhase?: (phase: OperationalStateOperationPhase) => void
  ): T {
    if (this.options.readOnly) return operation();
    if (this.transactionDepth > 0) {
      this.observeTransactionPhase(observePhase, "executing");
      return operation();
    }
    this.observeTransactionPhase(observePhase, "write-lock-wait");
    try {
      this.database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      this.observeTransactionFailure(error);
      throw error;
    }
    this.transactionDepth += 1;
    try {
      this.observeTransactionPhase(observePhase, "executing");
      const result = operation();
      this.observeTransactionPhase(observePhase, "committing");
      this.database.exec("COMMIT");
      try {
        this.options.onTransactionCommitted?.();
      } catch {
        // Readiness diagnostics cannot change a committed transaction.
      }
      // The per-command observer owns its response boundary because it may
      // still need to persist/replay a receipt before replying. The enclosing
      // runtime observer only needs to know that this synchronous transaction
      // has released SQLite.
      this.observeTransactionPhase(undefined, "responding");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      this.observeTransactionFailure(error);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private observeTransactionPhase(
    observer: ((phase: OperationalStateOperationPhase) => void) | undefined,
    phase: OperationalStateOperationPhase
  ): void {
    try {
      this.options.onTransactionPhase?.(phase);
    } catch {
      // Diagnostics cannot change transaction semantics.
    }
    try {
      observer?.(phase);
    } catch {
      // Diagnostics cannot change transaction semantics.
    }
  }

  private observeTransactionFailure(error: unknown): void {
    try {
      this.options.onTransactionFailure?.(error);
    } catch {
      // Readiness diagnostics cannot replace the original transaction error.
    }
  }

  listSessions(): unknown[] {
    return this.database
      .prepare(`SELECT s.*,p.name AS project_name FROM sessions s
        LEFT JOIN projects p ON p.project_id=s.project_id
        ORDER BY s.last_used_at ASC`)
      .all()
      .map((value) => {
        const row = value as Record<string, unknown>;
        return {
          threadId: String(row.thread_id),
          ...(row.auth_boundary ? { authBoundary: String(row.auth_boundary) } : {}),
          scopeId: String(row.scope_id),
          backendKind: String(row.backend_kind),
          ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
          ...(row.forked_from_thread_id
            ? { forkedFromThreadId: String(row.forked_from_thread_id) }
            : {}),
          ...(row.visible_in_codex_app === null
            ? {}
            : { visibleInCodexApp: Number(row.visible_in_codex_app) === 1 }),
          persistence: row.persistence as ThreadPersistence,
          cwd: String(row.cwd),
          ...(row.project_id && row.project_name
            ? { projectId: String(row.project_id), projectName: String(row.project_name) }
            : {}),
          sandbox: String(row.sandbox),
          ...(row.selection
            ? { selection: parseCurrentPayload({ payload: String(row.selection) }, "session selection") }
            : {}),
          ...(row.policy_revision === null
            ? {}
            : { policyRevision: Number(row.policy_revision) }),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          lastUsedAt: Number(row.last_used_at)
        };
      });
  }

  listSessionProjectIdentities(): Array<{
    threadId: string;
    projectId?: string;
    projectName?: string;
  }> {
    return this.database.prepare(`
      SELECT s.thread_id,s.project_id,p.name AS project_name
        FROM sessions s
        LEFT JOIN projects p ON p.project_id=s.project_id
       ORDER BY s.thread_id
    `).all().map((row) => {
      const value = row as {
        thread_id: string;
        project_id: string | null;
        project_name: string | null;
      };
      return {
        threadId: value.thread_id,
        ...(value.project_id && value.project_name
          ? { projectId: value.project_id, projectName: value.project_name }
          : {})
      };
    });
  }

  upsertSession(session: SessionRowInput): void {
    this.transaction(() => {
      this.ensureScope(session.scopeId, session.lastUsedAt);
      const project = normalizeProjectIdentity(session.projectId, session.projectName);
      this.database
        .prepare(`
          INSERT INTO sessions(
            thread_id,scope_id,project_id,backend_kind,cwd,sandbox,session_id,
            forked_from_thread_id,persistence,visible_in_codex_app,selection,
            policy_revision,created_at,updated_at,last_used_at,auth_boundary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(thread_id) DO UPDATE SET
            scope_id = excluded.scope_id,
            cwd = excluded.cwd,
            project_id = excluded.project_id,
            backend_kind = excluded.backend_kind,
            sandbox = excluded.sandbox,
            session_id = COALESCE(excluded.session_id,sessions.session_id),
            forked_from_thread_id = COALESCE(excluded.forked_from_thread_id,sessions.forked_from_thread_id),
            persistence = excluded.persistence,
            visible_in_codex_app = COALESCE(excluded.visible_in_codex_app,sessions.visible_in_codex_app),
            selection = excluded.selection,
            policy_revision = excluded.policy_revision,
            updated_at = excluded.updated_at,
            last_used_at = excluded.last_used_at,
            auth_boundary = COALESCE(excluded.auth_boundary,sessions.auth_boundary)
        `)
        .run(
          session.threadId,
          session.scopeId,
          project?.projectId || null,
          normalizeOptionalString(session.backendKind) || "mcp-server",
          session.cwd,
          normalizeOptionalString(session.sandbox) || "workspace-write",
          normalizeOptionalString(session.sessionId) || null,
          normalizeOptionalString(session.forkedFromThreadId) || null,
          session.persistence || (session.visibleInCodexApp === true
            ? "persistent"
            : session.visibleInCodexApp === false ? "ephemeral" : "unknown"),
          session.visibleInCodexApp === undefined ? null : Number(session.visibleInCodexApp),
          session.selection === undefined ? null : JSON.stringify(session.selection),
          Number.isInteger(session.policyRevision) ? session.policyRevision : null,
          session.createdAt ?? session.lastUsedAt,
          session.updatedAt ?? session.lastUsedAt,
          session.lastUsedAt,
          session.authBoundary || null
        );
      this.threadConnections.register({ threadId: session.threadId, scopeId: session.scopeId,
        persistence: session.persistence || (session.visibleInCodexApp === true ? "persistent" : session.visibleInCodexApp === false ? "ephemeral" : "unknown") }, session.lastUsedAt);
    });
  }

  deleteSession(threadId: string): void {
    this.database.prepare(`DELETE FROM sessions WHERE thread_id = ?
      AND NOT EXISTS (SELECT 1 FROM agent_threads WHERE agent_threads.thread_id=sessions.thread_id)`).run(threadId);
  }

  countSessions(scopeId?: string): number {
    const row = scopeId
      ? this.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE scope_id = ?").get(scopeId)
      : this.database.prepare("SELECT COUNT(*) AS count FROM sessions").get();
    return Number((row as CountRow).count);
  }

  listJobs(): StoredJobRecord[] {
    return this.database
      .prepare(`
        SELECT j.payload,j.job_id,j.scope_id,j.request_id,j.activity_id,j.thread_id,
               j.source_thread_id,j.status,j.backend_kind,
               bridge_instance_id, worker_id, worker_generation, upstream_request_id,
               terminal_version,agent_id,context_mode,a.project_id,p.name AS project_name,
               j.cwd,j.sandbox,j.created_at,j.updated_at,j.job_version,j.last_progress_at,
               j.last_progress,j.terminal_origin,j.cancellation_intent_id,
               COALESCE((SELECT json_group_array(json(event.payload)) FROM (
                 SELECT payload FROM job_events
                  WHERE job_id=j.job_id AND event_type LIKE 'app-%'
                  ORDER BY event_id
               ) event),'[]') AS public_events,
               COALESCE((SELECT json_group_array(json(interaction.payload)) FROM (
                 SELECT json_patch(payload,json_object(
                   'interactionId',interaction_id,
                   'isBlocking',json(CASE is_blocking WHEN 1 THEN 'true' ELSE 'false' END)
                 )) AS payload FROM job_interactions
                  WHERE job_id=j.job_id ORDER BY position
               ) interaction),'[]') AS pending_interactions
          FROM jobs j
          JOIN activities a ON a.activity_id=j.activity_id
          LEFT JOIN projects p ON p.project_id=a.project_id
         WHERE j.archived_at IS NULL
         ORDER BY j.updated_at ASC
      `)
      .all()
      .map((row) => hydrateJobPayload(row as JobStorageRow));
  }

  /** Exact scoped admission proof after the result body leaves ordinary Job retention. */
  getArchivedJobAdmissionReceipt(
    scopeId: string,
    query: { kind: "job"; id: string } | { kind: "request"; requestId: string }
  ): ArchivedJobAdmissionReceipt | undefined {
    const column = query.kind === "job" ? "job_id" : "request_id";
    const value = query.kind === "job" ? query.id : query.requestId;
    const row = this.database.prepare(`
      SELECT job_id, request_id, status
        FROM jobs
       WHERE scope_id = ? AND ${column} = ? AND archived_at IS NOT NULL
    `).get(scopeId, value) as {
      job_id: string;
      request_id: string;
      status: string;
    } | undefined;
    return row
      ? { jobId: row.job_id, requestId: row.request_id, status: row.status }
      : undefined;
  }

  /** Includes completed and archived work when selecting the initial card scope. */
  hasDashboardWork(scopeId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM activities WHERE scope_id = ?
      UNION ALL
      SELECT 1 FROM jobs WHERE scope_id = ?
      LIMIT 1
    `).get(scopeId, scopeId));
  }

  /**
   * Returns bounded, result-free status history after ordinary Jobs are pruned.
   * Filter before the limit so newer work elsewhere cannot hide scoped history.
   * Older archived rows may lack start time or execution selection; callers
   * must not infer those values from the Agent's current session.
   */
  listDashboardRetainedJobs(limit = 10_000, scopeId?: string): DashboardRetainedJobSummary[] {
    const boundedLimit = Math.max(0, Math.min(100_000, Math.floor(limit)));
    if (boundedLimit === 0) return [];
    const rows = this.database
      .prepare(`
        SELECT job_id, scope_id, activity_id, agent_id, backend_kind,
               status, created_at, updated_at, summary
          FROM jobs
         WHERE archived_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM work_history_state h WHERE h.job_id=jobs.job_id AND h.expired_at IS NOT NULL)
           ${scopeId ? "AND scope_id = ?" : ""}
         ORDER BY updated_at DESC, job_id DESC
         LIMIT ?
      `)
      .all(...(scopeId ? [scopeId, boundedLimit] : [boundedLimit])) as Array<{
        job_id: string;
        scope_id: string;
        activity_id: string;
        agent_id: string | null;
        backend_kind: string | null;
        status: string;
        updated_at: number;
        created_at: number;
        summary: string;
      }>;
    return rows.map(decodeDashboardArchivedJob);
  }

  /** Bounded overview projection: at most `perAgentLimit` archived rows are
   * materialized per Agent, while the SQL window keeps exact history totals. */
  listDashboardArchivedJobsByAgent(
    scopeId?: string,
    perAgentLimit = 13,
    representativeOrder: DashboardRepresentativeOrder = "updated"
  ): {
    jobs: DashboardRetainedJobSummary[];
    totalsByAgent: Map<string, number>;
  } {
    const result = this.dashboardReadModel.archivedByAgent(
      scopeId,
      perAgentLimit,
      representativeOrder
    );
    return { jobs: result.rows.map(decodeDashboardArchivedJob), totalsByAgent: result.totalsByAgent };
  }

  listDashboardAgentRetainedJobs(scopeId: string, agentId: string, historyLimit = 12): {
    representative?: DashboardRetainedJobSummary;
    history: DashboardRetainedJobSummary[];
    total: number;
  } {
    const result = this.dashboardReadModel.agentHistory(scopeId, agentId, historyLimit);
    return {
      ...(result.representative
        ? { representative: decodeDashboardArchivedJob(result.representative) }
        : {}),
      history: result.history.map(decodeDashboardArchivedJob),
      total: result.total
    };
  }

  listDashboardRetainedJobsByIds(jobIds: readonly string[], scopeId?: string): DashboardRetainedJobSummary[] {
    return this.dashboardReadModel.archivedByIds(jobIds, scopeId).map(decodeDashboardArchivedJob);
  }

  dashboardJobSummaries(jobIds: readonly string[]): Map<string, Record<string, unknown>> {
    return new Map([...this.dashboardReadModel.summaries(jobIds)].map(([jobId, summary]) => {
      const parsed = parseCurrentPayload({payload:summary}, "dashboard job summary");
      return [jobId, sanitizeRetainedJobSummary(parsed)] as const;
    }));
  }

  dashboardArchivedCounts(scopeId?: string): DashboardArchivedCounts {
    return this.dashboardReadModel.archivedCounts(scopeId);
  }

  upsertJob(job: JobRowInput): void {
    this.transaction(() => this.upsertJobInternal(job));
  }

  maintainJobRetentionCandidates(
    command: OperationalJobRetentionCommand
  ): OperationalJobRetentionResult {
    return this.transaction(() => {
      const deadline = performance.now() + command.maxDurationMs;
      let remainingAdmissionReservations = command.admissionReservations;
      let removed = 0;
      const classifications: OperationalJobRetentionResult["classifications"] = [];
      for (const candidate of command.candidates) {
        if (
          removed >= command.maxRemoved ||
          classifications.length > 0 && performance.now() >= deadline
        ) break;
        const row = this.database.prepare(`
          SELECT status, updated_at, job_version
            FROM jobs
           WHERE job_id = ? AND archived_at IS NULL
        `).get(candidate.jobId) as {
          status: string;
          updated_at: number;
          job_version: number;
        } | undefined;
        if (
          !row ||
          !isTerminalActivityJobStatus(row.status) ||
          row.updated_at !== candidate.updatedAt ||
          row.job_version !== candidate.version
        ) {
          classifications.push({ ...candidate, disposition: "skipped" });
          continue;
        }
        if (
          this.retentionProtection(
            candidate.jobId,
            command.now,
            command.completionResultRecoveryMs
          ).length > 0
        ) {
          if (!candidate.knownProtected) {
            remainingAdmissionReservations = Math.max(0, remainingAdmissionReservations - 1);
          }
          classifications.push({ ...candidate, disposition: "protected" });
          continue;
        }
        if (candidate.knownProtected) remainingAdmissionReservations += 1;
        if (
          candidate.updatedAt >= command.cutoffAt &&
          remainingAdmissionReservations <= command.retentionTarget
        ) {
          classifications.push({ ...candidate, disposition: "retained" });
          continue;
        }
        if (this.deleteJob(candidate.jobId, command.now)) {
          removed += 1;
          remainingAdmissionReservations = Math.max(0, remainingAdmissionReservations - 1);
          classifications.push({ ...candidate, disposition: "removed" });
        } else {
          classifications.push({ ...candidate, disposition: "protected" });
        }
      }
      return { classifications, remainingAdmissionReservations };
    });
  }

  deleteJob(jobId: string, now = Date.now()): boolean {
    let archived = false;
    this.transaction(() => {
      if (this.retentionProtection(jobId, now).length) return;
      const row = this.database
        .prepare(`
          SELECT job_id, scope_id, request_id, status, updated_at, activity_id,
                 terminal_version
            FROM jobs
           WHERE job_id = ? AND archived_at IS NULL
        `)
        .get(jobId) as
        | {
            job_id: string;
            scope_id: string;
            request_id: string;
            status: string;
            updated_at: number;
            activity_id: string;
            terminal_version: number | null;
          }
        | undefined;
      if (!row) return;
      const scopeVersion = this.nextScopeVersion(row.scope_id, now);
      if (!this.eventRetention.summary(jobId).usage) {
        const usage = this.database.prepare("SELECT payload FROM job_events WHERE job_id=? AND event_type LIKE 'app-usage%' ORDER BY event_id DESC LIMIT 1").get(jobId) as JsonRow | undefined;
        if (usage) this.eventRetention.prepare({jobId,eventType:"app-usage",payload:parseStoredJson(usage.payload, "job event")}, true, false);
      }
      this.database
        .prepare("UPDATE jobs SET archived_at = ?, payload = ? WHERE job_id = ?")
        .run(now, JSON.stringify({ resultOmitted: true }), row.job_id);
      this.database.prepare("DELETE FROM job_events WHERE job_id=?").run(jobId);
      this.insertJobEvent({
        jobId: row.job_id,
        activityId: row.activity_id,
        scopeId: row.scope_id,
        scopeVersion,
        eventType: "retention-pruned",
        status: row.status,
        createdAt: now,
        payload: { resultBodyRetained: false }
      });
      this.touchActivity(row.activity_id, scopeVersion, now, "job-retention-pruned", {
        jobId: row.job_id
      });
      archived = true;
    });
    return archived;
  }

  retentionProtection(
    jobId: string,
    now = Date.now(),
    completionResultRecoveryMs = 0
  ): string[] {
    const row = this.database.prepare("SELECT status,activity_id,updated_at FROM jobs WHERE job_id=?").get(jobId) as {
      status:string;activity_id:string;updated_at:number;
    } | undefined;
    if (!row) return [];
    const reasons: string[] = [];
    if (this.mcpEvents.protectsResult(jobId, now)) reasons.push("mcp-event-result-recovery");
    if (isActiveActivityJobStatus(row.status)) reasons.push("active-work");
    if (this.database.prepare("SELECT 1 FROM job_interactions WHERE job_id=? AND is_blocking=1 LIMIT 1").get(jobId)) reasons.push("pending-interaction");
    if (this.database.prepare("SELECT 1 FROM completion_outbox WHERE activity_id=? AND delivered_at IS NULL AND acknowledged_at IS NULL LIMIT 1").get(row.activity_id)) reasons.push("undelivered-result");
    const completionDelivery = this.database.prepare(`SELECT state,completion_result_offered_at
      FROM job_completion_deliveries WHERE job_id=?`).get(jobId) as {
        state:string;completion_result_offered_at:number|null;
      } | undefined;
    if (completionDelivery) {
      const settings = this.getSettingsRecord()?.payload;
      const retentionDays = historyRetentionDays(
        isRecord(settings) ? settings.historyRetentionDays : undefined
      );
      const withinHistoryRetention = retentionDays === 0 ||
        now < row.updated_at + retentionDays * 86_400_000;
      if (
        !["pending", "result-read"].includes(completionDelivery.state) &&
        completionDelivery.completion_result_offered_at === null &&
        withinHistoryRetention
      ) {
        // No message body is stored. Keep the exact Job result available only
        // after a card crossed the send boundary, while delivery remains
        // unresolved and the selected run-history period has not expired.
        reasons.push("undelivered-chatgpt-result");
      } else if (
        completionDelivery.completion_result_offered_at !== null &&
        completionResultRecoveryMs > 0 &&
        now < completionDelivery.completion_result_offered_at + completionResultRecoveryMs
      ) {
        // Constructing a receipt response is not proof that ChatGPT received
        // it. Reuse the ordinary result-retention window as one bounded retry
        // grace rather than extending successful results to run-history expiry.
        reasons.push("chatgpt-result-recovery");
      }
    }
    const steering = this.uncertainResultState(jobId);
    const review = this.eventRetention.summary(jobId).uncertainResponseReview as {count?:number;latestUpdateAt?:number} | undefined;
    if (steering.pending || steering.count > 0 && (review?.count !== steering.count || review.latestUpdateAt !== steering.latestUpdateAt)) reasons.push("uncertain-response");
    if (this.database.prepare("SELECT 1 FROM cancellation_intents WHERE (target_job_id=? OR (target_kind='activity' AND target_activity_id=?)) AND status IN ('recorded','dispatched') LIMIT 1").get(jobId, row.activity_id)) reasons.push("pending-cancellation");
    if (this.database.prepare("SELECT 1 FROM result_holds WHERE job_id=? AND expires_at>?").get(jobId, now)) reasons.push("user-hold");
    return reasons;
  }

  holdResult(jobId: string, reason: string, expiresAt: number, now = Date.now()): void {
    if (!reason.trim() || reason.length > 200 || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 30 * 86400_000) {
      throw new Error("RESULT_HOLD_INVALID: Provide a reason and a renewable hold of at most 30 days.");
    }
    const job = this.database.prepare("SELECT 1 FROM jobs WHERE job_id=? AND archived_at IS NULL").get(jobId);
    if (!job) throw new Error("RESULT_NOT_RETAINED: An expired result cannot be restored by a hold.");
    this.database.prepare("INSERT OR REPLACE INTO result_holds(job_id,reason,expires_at) VALUES (?,?,?)").run(jobId, reason.trim(), expiresAt);
  }

  releaseResultHold(jobId: string): void { this.database.prepare("DELETE FROM result_holds WHERE job_id=?").run(jobId); }

  /** Explicit operator review releases only the result hold; delivery remains uncertain and cannot replay. */
  acknowledgeUncertainResultReview(jobId: string, now = Date.now()): void {
    this.transaction(() => {
      const job = this.database.prepare("SELECT status FROM jobs WHERE job_id=? AND archived_at IS NULL").get(jobId) as {status:string} | undefined;
      if (!job || !isTerminalActivityJobStatus(job.status)) throw new Error("RESULT_REVIEW_UNAVAILABLE: Review requires a retained terminal result.");
      const state = this.uncertainResultState(jobId);
      if (state.pending) throw new Error("RESULT_REVIEW_PENDING: Response dispatch is still in progress.");
      this.eventRetention.acknowledgeUncertainResultReview(jobId,state.count,state.latestUpdateAt,normalizeEventTimestamp(now));
    });
  }

  private uncertainResultState(jobId: string): {pending:number;count:number;latestUpdateAt:number} {
    return this.database.prepare(`SELECT COALESCE(SUM(status IN ('prepared','dispatching')),0) pending,
      COALESCE(SUM(status='uncertain'),0) count,COALESCE(MAX(CASE WHEN status='uncertain' THEN updated_at END),0) latestUpdateAt
      FROM steering_deliveries WHERE job_id=? AND status IN ('prepared','dispatching','uncertain')`).get(jobId) as {pending:number;count:number;latestUpdateAt:number};
  }

  maintainEventRetention(now = Date.now()): ReturnType<EventRetention["sweep"]> {
    return this.transaction(() => this.eventRetention.sweep(now));
  }

  maintainHistoryRetention(now = Date.now()): { historyRemoved: number } {
    return this.transaction(() => {
      const settings = this.getSettingsRecord()?.payload;
      const days = historyRetentionDays(isRecord(settings) ? settings.historyRetentionDays : undefined);
      const historyRemoved = this.workHistory.sweep(
        days,
        jobId => this.retentionProtection(jobId, now).length > 0,
        now
      );
      if (historyRemoved > 0) {
        this.setMeta("state_history_retention_last_run", JSON.stringify({
          reason: "configured-retention-policy",
          at: new Date(now).toISOString(),
          historyRetentionDays: days,
          historyRemoved
        }));
      }
      return { historyRemoved };
    });
  }

  maintainRecoveryRetention(now = Date.now()): ReturnType<AutomaticRecoveryStore["prune"]> {
    return this.transaction(() => {
      const settings = this.getSettingsRecord()?.payload;
      const days = historyRetentionDays(isRecord(settings) ? settings.historyRetentionDays : undefined);
      return this.automaticRecovery.prune(days, now);
    });
  }

  maintainQuestionRetention(now = Date.now()): ReturnType<QuestionStore["maintain"]> {
    return this.transaction(() => this.questions.maintain(now));
  }

  /** Compatibility entry point. Each domain commits an independent bounded
   * slice; no BEGIN IMMEDIATE spans the complete maintenance cycle. */
  maintainRetention(now = Date.now()): ReturnType<EventRetention["sweep"]> &
    ReturnType<AutomaticRecoveryStore["prune"]> & { historyRemoved: number } {
    const event = this.maintainEventRetention(now);
    const history = this.maintainHistoryRetention(now);
    const recovery = this.maintainRecoveryRetention(now);
    const report = { ...event, ...history, ...recovery };
    const settings = this.getSettingsRecord()?.payload;
    const days = historyRetentionDays(isRecord(settings) ? settings.historyRetentionDays : undefined);
    this.transaction(() => this.setMeta("state_retention_last_run", JSON.stringify({
      reason: "configured-retention-policy",
      at: new Date(now).toISOString(),
      historyRetentionDays: days,
      ...report
    })));
    return report;
  }

  private readJobSummary(jobId: string): Record<string, unknown> {
    const row = this.database.prepare("SELECT summary FROM jobs WHERE job_id=?")
      .get(jobId) as {summary:string} | undefined;
    return row
      ? sanitizeRetainedJobSummary(parseCurrentPayload({payload: row.summary}, "job summary"))
      : {};
  }

  private saveJobSummary(jobId: string, summary: Record<string, unknown>): void {
    this.database.prepare("UPDATE jobs SET summary=? WHERE job_id=?")
      .run(JSON.stringify(sanitizeRetainedJobSummary(summary)), jobId);
  }

  private deleteActivityEventsForRetention(
    olderThan: number,
    batchSize: number,
    retainedLimit: number
  ): number {
    const limitRemoved = this.database.prepare(`
      DELETE FROM activity_events WHERE event_id IN (
        SELECT event_id FROM activity_events
         ORDER BY event_id DESC LIMIT ? OFFSET ?
      )
    `).run(batchSize, retainedLimit).changes;
    const ageRemoved = this.database.prepare(`
      DELETE FROM activity_events WHERE event_id IN (
        SELECT event_id FROM activity_events
         WHERE created_at<? ORDER BY event_id LIMIT ?
      )
    `).run(olderThan, batchSize).changes;
    return limitRemoved + ageRemoved;
  }

  private deleteExpiredResultHoldsForRetention(now: number, limit: number): number {
    return this.database.prepare(`
      DELETE FROM result_holds WHERE job_id IN (
        SELECT job_id FROM result_holds WHERE expires_at<=? LIMIT ?
      )
    `).run(now, limit).changes;
  }

  /** Central Unit-of-Work command for the cross-domain history projection. */
  private expireHistoryProjection(candidate: HistoryRetentionCandidate, _now: number): void {
    const receipt = {resultOmitted:true,historyExpired:true};
    this.database.prepare("UPDATE jobs SET payload=?,summary='{}' WHERE job_id=?")
      .run(JSON.stringify(receipt), candidate.jobId);
    this.eventRetention.deleteJobEventsForHistory(candidate.jobId);
    this.database.prepare("DELETE FROM job_completion_deliveries WHERE job_id=?")
      .run(candidate.jobId);
  }

  replaceJobs(jobs: JobRowInput[]): void {
    this.replaceJobsInternal(jobs);
  }

  private replaceJobsInternal(jobs: JobRowInput[]): void {
    this.transaction(() => {
      const retainedIds = new Set(jobs.map((job) => job.jobId));
      const existing = this.database
        .prepare("SELECT job_id FROM jobs WHERE archived_at IS NULL")
        .all() as Array<{ job_id: string }>;
      for (const job of jobs) {
        this.upsertJobInternal(job);
      }
      for (const row of existing) {
        if (!retainedIds.has(row.job_id)) this.deleteJob(row.job_id);
      }
    });
  }

  countJobs(scopeId?: string, status?: string): number {
    let sql = "SELECT COUNT(*) AS count FROM jobs WHERE archived_at IS NULL";
    const parameters: string[] = [];
    if (scopeId) {
      sql += " AND scope_id = ?";
      parameters.push(scopeId);
    }
    if (status) {
      sql += " AND status = ?";
      parameters.push(status);
    }
    const row = this.database.prepare(sql).get(...parameters) as CountRow;
    return Number(row.count);
  }

  createActivity(input: CreateActivityInput): BridgeActivity {
    const activityId = normalizeUuid(input.activityId || randomUUID(), "activityId");
    const scopeId = normalizeUuid(input.scopeId, "scopeId");
    const kind = input.kind || "other";
    const handoffPolicy = input.handoffPolicy || "none";
    const completionTrigger = input.completionTrigger || "manual";
    assertActivityPolicy(kind, handoffPolicy, completionTrigger);
    let project = normalizeActivityProjectAdmission(
      input.projectId,
      input.projectName,
      input.projectCwd
    );
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      if (this.getActivityRow(activityId)) throw new Error("Activity id already exists.");
      this.ensureScope(scopeId, now);
      let continuationOfActivityId: string | undefined;
      if (input.continuationOfActivityId) {
        continuationOfActivityId = normalizeUuid(
          input.continuationOfActivityId,
          "continuationOfActivityId"
        );
        const source = this.requireActivity(continuationOfActivityId);
        if (source.scopeId !== scopeId) {
          throw new Error("The continuation Activity belongs to another conversation scope.");
        }
        const sourceProject = this.getActivityProjectAdmission(source.activityId);
        // A continuation link preserves lineage, not necessarily filesystem
        // identity: a fresh context may deliberately start the new Activity in
        // another registered project. When no new admission is supplied, keep
        // the source project for continue/fork and compatibility callers.
        project ||= sourceProject;
      }
      const scopeVersion = this.nextScopeVersion(scopeId, now);
      this.insertActivity({
        activityId,
        scopeId,
        ...project,
        continuationOfActivityId,
        title: canonicalActivityTitle(input.title || "Codex activity"),
        kind,
        handoffPolicy,
        completionTrigger,
        legacy: input.legacy || false,
        now
      });
      this.insertActivityEvent({
        activityId,
        scopeId,
        scopeVersion,
        eventType: "activity-created",
        createdAt: now,
        payload: {
          kind,
          handoffPolicy,
          completionTrigger,
          projectId: project?.projectId || null,
          continuationOfActivityId: continuationOfActivityId || null,
          cardGeneration: 1
        }
      });
      return this.requireActivity(activityId);
    });
  }

  getActivity(activityId: string): BridgeActivity | undefined {
    const row = this.getActivityRow(activityId);
    return row ? readActivityRow(row) : undefined;
  }

  listActivityProjectIdentities(): Array<{
    activityId: string;
    projectId: string;
    projectName: string;
  }> {
    return this.database.prepare(`
      SELECT a.activity_id,a.project_id,p.name AS project_name
        FROM activities a
        JOIN projects p ON p.project_id=a.project_id
       ORDER BY a.activity_id
    `).all().map((row) => {
      const value = row as { activity_id: string; project_id: string; project_name: string };
      return {
        activityId: value.activity_id,
        projectId: value.project_id,
        projectName: value.project_name
      };
    });
  }

  getActivityProjectAdmission(activityId: string): ActivityProjectAdmission | undefined {
    const row = this.getActivityRow(activityId);
    if (!row) return undefined;
    return readActivityProjectAdmission(row);
  }

  listActivities(scopeId?: string, limit = 100, offset = 0): BridgeActivity[] {
    const boundedLimit = Math.max(0, Math.min(1_000, limit));
    const boundedOffset = Math.max(0, offset);
    const rows = scopeId
      ? this.database
          .prepare(`SELECT a.*,p.name AS project_name FROM activities a
            LEFT JOIN projects p ON p.project_id=a.project_id
            WHERE a.scope_id = ? ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`)
          .all(scopeId, boundedLimit, boundedOffset)
      : this.database
          .prepare(`SELECT a.*,p.name AS project_name FROM activities a
            LEFT JOIN projects p ON p.project_id=a.project_id
            ORDER BY a.updated_at DESC LIMIT ? OFFSET ?`)
          .all(boundedLimit, boundedOffset);
    return (rows as ActivityStorageRow[]).map(readActivityRow);
  }

  /** Counts can include Activity-only conversations without loading their payloads. */
  listActivityScopeIds(): string[] {
    return (this.database.prepare("SELECT DISTINCT scope_id FROM activities").all() as Array<{ scope_id: string }>)
      .map(row => row.scope_id);
  }

  countActivities(scopeId?: string): number {
    const row = scopeId
      ? this.database.prepare("SELECT COUNT(*) AS count FROM activities WHERE scope_id = ?").get(scopeId)
      : this.database.prepare("SELECT COUNT(*) AS count FROM activities").get();
    return Number((row as { count?: number } | undefined)?.count || 0);
  }

  createAgent(input: {
    scopeId: string;
    agentId?: string;
    agentName: string;
    lifecycle?: BridgeAgentLifecycle;
    now?: number;
  }): BridgeAgent {
    const scopeId = normalizeUuid(input.scopeId, "agent scopeId");
    const agentId = normalizeUuid(input.agentId || randomUUID(), "agentId");
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      this.ensureScope(scopeId, now);
      if (this.getAgent(agentId)) throw new Error("Agent id already exists.");
      const { agentName, normalizedName } = canonicalAgentName(input.agentName);
      const lifecycle = input.lifecycle || "idle";
      if (!isAgentLifecycle(lifecycle)) throw new Error("Invalid Agent lifecycle.");
      try {
        this.database
          .prepare(`
            INSERT INTO agents(
              agent_id, scope_id, agent_name, normalized_name, lifecycle,
              current_thread_id, current_job_id, version, created_at, updated_at,
              orphaned_reason
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, NULL)
          `)
          .run(agentId, scopeId, agentName, normalizedName, lifecycle, now, now);
      } catch (error) {
        if (String(error).includes("agents.scope_id, agents.normalized_name")) {
          throw new Error("AGENT_NAME_CONFLICT: Agent names must be unique in this conversation.");
        }
        throw error;
      }
      this.nextScopeVersion(scopeId, now);
      return this.requireAgent(agentId);
    });
  }

  getAgent(agentId: string): BridgeAgent | undefined {
    const row = this.database
      .prepare("SELECT * FROM agents WHERE agent_id = ?")
      .get(agentId) as AgentStorageRow | undefined;
    return row ? readAgentRow(row) : undefined;
  }

  /** Stable keyset for background reconciliation. A restart may revisit rows,
   * but never needs to hydrate the entire Agent table before serving reads. */
  recoveryAgentIds(afterAgentId: string, limit: number): string[] {
    const boundedLimit = Math.max(1, Math.min(32, Math.floor(limit)));
    return (this.database.prepare(`SELECT agent_id FROM agents WHERE agent_id > ?
      ORDER BY agent_id LIMIT ?`).all(afterAgentId, boundedLimit) as Array<{agent_id:string}>)
      .map(row => row.agent_id);
  }

  getAgentForThread(threadId: string): BridgeAgent | undefined {
    const row = this.database
      .prepare(`
        SELECT a.* FROM agents a
        JOIN agent_threads t ON t.agent_id = a.agent_id
        WHERE t.thread_id = ?
      `)
      .get(threadId) as AgentStorageRow | undefined;
    return row ? readAgentRow(row) : undefined;
  }

  listAgents(scopeId?: string, limit = 100, offset = 0): BridgeAgent[] {
    const boundedLimit = Math.max(0, Math.min(1_000, limit));
    const boundedOffset = Math.max(0, offset);
    let sql = "SELECT * FROM agents";
    const parameters: Array<string | number> = [];
    const predicates: string[] = [];
    if (scopeId) {
      predicates.push("scope_id = ?");
      parameters.push(normalizeUuid(scopeId, "agent scopeId"));
    }
    if (predicates.length > 0) sql += ` WHERE ${predicates.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    parameters.push(boundedLimit, boundedOffset);
    return (this.database.prepare(sql).all(...parameters) as AgentStorageRow[]).map(readAgentRow);
  }

  countAgents(scopeId?: string): number {
    let sql = "SELECT COUNT(*) AS count FROM agents";
    const parameters: string[] = [];
    const predicates: string[] = [];
    if (scopeId) {
      predicates.push("scope_id = ?");
      parameters.push(normalizeUuid(scopeId, "agent scopeId"));
    }
    if (predicates.length > 0) sql += ` WHERE ${predicates.join(" AND ")}`;
    return Number((this.database.prepare(sql).get(...parameters) as CountRow).count);
  }

  countAgentsByLifecycle(lifecycle: BridgeAgentLifecycle, scopeId?: string): number {
    if (!isAgentLifecycle(lifecycle)) throw new Error("Invalid Agent lifecycle.");
    let sql = "SELECT COUNT(*) AS count FROM agents WHERE lifecycle = ?";
    const parameters: string[] = [lifecycle];
    if (scopeId) {
      sql += " AND scope_id = ?";
      parameters.push(normalizeUuid(scopeId, "agent scopeId"));
    }
    return Number((this.database.prepare(sql).get(...parameters) as CountRow).count);
  }

  listCurrentAgentThreads(): BridgeAgentThread[] {
    return (this.database
      .prepare(`SELECT t.*,s.session_id,s.scope_id,s.project_id,p.name AS project_name,
        s.backend_kind,s.cwd,s.sandbox,s.forked_from_thread_id
        FROM agent_threads t JOIN sessions s ON s.thread_id=t.thread_id
        LEFT JOIN projects p ON p.project_id=s.project_id
        WHERE t.is_current = 1 ORDER BY t.linked_at ASC`)
      .all() as AgentThreadStorageRow[]).map(readAgentThreadRow);
  }

  currentAgentThread(agentId: string): BridgeAgentThread | undefined {
    const row = this.database.prepare(`SELECT t.*,s.session_id,s.scope_id,s.project_id,
      p.name AS project_name,s.backend_kind,s.cwd,s.sandbox,s.forked_from_thread_id
      FROM agent_threads t JOIN sessions s ON s.thread_id=t.thread_id
      LEFT JOIN projects p ON p.project_id=s.project_id
      WHERE t.agent_id=? AND t.is_current=1`).get(agentId) as AgentThreadStorageRow | undefined;
    return row ? readAgentThreadRow(row) : undefined;
  }

  listAgentThreads(agentId: string): BridgeAgentThread[] {
    return (this.database
      .prepare(`SELECT t.*,s.session_id,s.scope_id,s.project_id,p.name AS project_name,
        s.backend_kind,s.cwd,s.sandbox,s.forked_from_thread_id
        FROM agent_threads t JOIN sessions s ON s.thread_id=t.thread_id
        LEFT JOIN projects p ON p.project_id=s.project_id
        WHERE t.agent_id = ? ORDER BY t.linked_at ASC`)
      .all(agentId) as AgentThreadStorageRow[]).map(readAgentThreadRow);
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
    now?: number;
  }): BridgeAgentThread {
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      const agent = this.requireAgent(input.agentId);
      if (!isAgentContextMode(input.contextMode)) throw new Error("Invalid Agent context mode.");
      const threadId = normalizeRequiredString(input.threadId, "threadId", 200);
      const cwd = normalizeRequiredString(input.cwd, "working directory", 4_000);
      const backendKind = normalizeRequiredString(input.backendKind, "backend kind", 100);
      const sandbox = normalizeRequiredString(input.sandbox, "sandbox", 100);
      let project = normalizeProjectIdentity(input.projectId, input.projectName);
      const owner = this.getAgentForThread(threadId);
      if (owner && owner.agentId !== agent.agentId) {
        throw new Error("The Codex thread is already owned by another bridge Agent.");
      }
      const existingSession = this.database
        .prepare(`SELECT s.thread_id,s.scope_id,s.project_id,p.name AS project_name,
          s.backend_kind,s.cwd,s.sandbox
          FROM sessions s LEFT JOIN projects p ON p.project_id=s.project_id
          WHERE s.thread_id = ?`)
        .get(threadId) as Pick<
          AgentThreadStorageRow,
          "thread_id" | "scope_id" | "project_id" | "project_name" | "backend_kind" | "cwd" | "sandbox"
        > | undefined;
      if (existingSession) {
        if (existingSession.scope_id !== agent.scopeId) {
          throw new Error(
            `${PROJECT_CONTEXT_CONFLICT}: An admitted Agent thread cannot change conversation scopes.`
          );
        }
        if (existingSession.cwd !== cwd) {
          throw new Error(
            `${PROJECT_CONTEXT_CONFLICT}: An admitted Agent thread cannot change working folders.`
          );
        }
        if (existingSession.backend_kind !== backendKind) {
          throw new Error(
            `${PROJECT_CONTEXT_CONFLICT}: An admitted Agent thread cannot change execution backends.`
          );
        }
        if (existingSession.sandbox !== sandbox) {
          throw new Error(
            `${PROJECT_CONTEXT_CONFLICT}: An admitted Agent thread cannot change sandbox modes.`
          );
        }
        const existingProject = readThreadProjectIdentity(existingSession);
        if (
          existingProject &&
          project &&
          existingProject.projectId !== project.projectId
        ) {
          throw new Error(
            `${PROJECT_CONTEXT_CONFLICT}: An admitted Agent thread cannot change projects.`
          );
        }
        project ||= existingProject;
      }
      const forkedFromThreadId = input.forkedFromThreadId
        ? normalizeRequiredString(input.forkedFromThreadId, "forkedFromThreadId", 200)
        : undefined;
      const sessionId = input.sessionId
        ? normalizeRequiredString(input.sessionId, "sessionId", 200)
        : undefined;
      this.database.prepare(`
        INSERT INTO sessions(
          thread_id,scope_id,project_id,backend_kind,cwd,sandbox,session_id,
          forked_from_thread_id,persistence,visible_in_codex_app,selection,
          policy_revision,created_at,updated_at,last_used_at
        ) VALUES (?,?,?,?,?,?,?,?, 'unknown',NULL,NULL,NULL,?,?,?)
        ON CONFLICT(thread_id) DO UPDATE SET
          project_id=COALESCE(sessions.project_id,excluded.project_id),
          backend_kind=excluded.backend_kind,
          sandbox=excluded.sandbox,
          session_id=COALESCE(excluded.session_id,sessions.session_id),
          forked_from_thread_id=COALESCE(excluded.forked_from_thread_id,sessions.forked_from_thread_id),
          updated_at=MAX(sessions.updated_at,excluded.updated_at),
          last_used_at=MAX(sessions.last_used_at,excluded.last_used_at)
      `).run(
        threadId,
        agent.scopeId,
        project?.projectId || null,
        backendKind,
        cwd,
        sandbox,
        sessionId || null,
        forkedFromThreadId || null,
        now,
        now,
        now
      );
      this.database
        .prepare(`
          UPDATE agent_threads
             SET is_current = 0, replaced_at = COALESCE(replaced_at, ?)
           WHERE agent_id = ? AND is_current = 1 AND thread_id <> ?
        `)
        .run(now, agent.agentId, threadId);
      this.database
        .prepare(`
          INSERT INTO agent_threads(
            thread_id,agent_id,context_mode,is_current,linked_at,replaced_at
          ) VALUES (?, ?, ?, 1, ?, NULL)
          ON CONFLICT(thread_id) DO UPDATE SET
            context_mode = excluded.context_mode,
            is_current = 1,
            replaced_at = NULL
        `)
        .run(
          threadId,
          agent.agentId,
          input.contextMode,
          now
        );
      this.database
        .prepare(`
          UPDATE agents
             SET current_thread_id = ?, lifecycle = CASE WHEN lifecycle = 'orphaned' THEN 'idle' ELSE lifecycle END,
                 orphaned_reason = NULL, version = version + 1, updated_at = ?
           WHERE agent_id = ?
        `)
        .run(threadId, now, agent.agentId);
      this.threadConnections?.supersedeHandoffs(agent.agentId, threadId, now);
      this.nextScopeVersion(agent.scopeId, now);
      const row = this.database
        .prepare(`SELECT t.*,s.session_id,s.scope_id,s.project_id,p.name AS project_name,
          s.backend_kind,s.cwd,s.sandbox,s.forked_from_thread_id
          FROM agent_threads t JOIN sessions s ON s.thread_id=t.thread_id
          LEFT JOIN projects p ON p.project_id=s.project_id WHERE t.thread_id = ?`)
        .get(threadId) as AgentThreadStorageRow;
      return readAgentThreadRow(row);
    });
  }

  assignAgent(input: {
    activityId: string;
    agentId: string;
    contextMode: AgentContextMode;
    role?: string;
    now?: number;
  }): ActivityAgentAssignment {
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      const activity = this.requireActivity(input.activityId);
      const agent = this.requireAgent(input.agentId);
      if (activity.scopeId !== agent.scopeId) {
        throw new Error("The Activity and Agent belong to different conversation scopes.");
      }
      if (!isAgentContextMode(input.contextMode)) throw new Error("Invalid Agent context mode.");
      const existing = this.database
        .prepare(`
          SELECT * FROM activity_agents
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .get(activity.activityId, agent.agentId) as ActivityAgentStorageRow | undefined;
      if (existing) return readActivityAgentRow(existing);
      const assignmentId = randomUUID();
      this.database
        .prepare(`
          INSERT INTO activity_agents(
            assignment_id, activity_id, agent_id, role, context_mode, assigned_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        `)
        .run(
          assignmentId,
          activity.activityId,
          agent.agentId,
          normalizeOptionalBoundedText(input.role, 80) || "primary",
          input.contextMode,
          now
        );
      this.nextScopeVersion(activity.scopeId, now);
      return readActivityAgentRow(
        this.database
          .prepare("SELECT * FROM activity_agents WHERE assignment_id = ?")
          .get(assignmentId) as ActivityAgentStorageRow
      );
    });
  }

  listActivityAgentAssignments(activityId?: string, agentId?: string): ActivityAgentAssignment[] {
    let sql = "SELECT * FROM activity_agents";
    const parameters: string[] = [];
    const predicates: string[] = [];
    if (activityId) {
      predicates.push("activity_id = ?");
      parameters.push(activityId);
    }
    if (agentId) {
      predicates.push("agent_id = ?");
      parameters.push(agentId);
    }
    if (predicates.length > 0) sql += ` WHERE ${predicates.join(" AND ")}`;
    sql += " ORDER BY assigned_at ASC";
    return (this.database.prepare(sql).all(...parameters) as ActivityAgentStorageRow[])
      .map(readActivityAgentRow);
  }

  listScopeActivityAgentAssignments(scopeId: string): ActivityAgentAssignment[] {
    const normalizedScopeId = normalizeUuid(scopeId, "assignment scopeId");
    return (this.database.prepare(`
      SELECT aa.*
        FROM activity_agents aa
        JOIN activities a ON a.activity_id = aa.activity_id
       WHERE a.scope_id = ?
       ORDER BY aa.assigned_at ASC, aa.assignment_id ASC
    `).all(normalizedScopeId) as ActivityAgentStorageRow[]).map(readActivityAgentRow);
  }

  releaseAgentAssignment(activityId: string, agentId: string, now = Date.now()): ActivityAgentAssignment | undefined {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      const agent = this.requireAgent(agentId);
      if (activity.scopeId !== agent.scopeId) {
        throw new Error("The Activity and Agent belong to different conversation scopes.");
      }
      const row = this.database
        .prepare(`
          SELECT * FROM activity_agents
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .get(activityId, agentId) as ActivityAgentStorageRow | undefined;
      if (!row) return undefined;
      this.database
        .prepare("UPDATE activity_agents SET released_at = ? WHERE assignment_id = ?")
        .run(now, row.assignment_id);
      this.nextScopeVersion(activity.scopeId, now);
      return { ...readActivityAgentRow(row), releasedAt: now };
    });
  }

  detachIdleAgentAssignment(input: {
    activityId: string;
    agentId: string;
    expectedAgentVersion: number;
    now?: number;
  }): {
    agent: BridgeAgent;
    assignment: ActivityAgentAssignment;
    alreadyReleased: boolean;
  } {
    const now = input.now ?? Date.now();
    return this.transaction(() => {
      const activity = this.requireActivity(input.activityId);
      const agent = this.requireAgent(input.agentId);
      if (activity.scopeId !== agent.scopeId) {
        throw new Error("The Activity and Agent belong to different conversation scopes.");
      }
      if (agent.version !== input.expectedAgentVersion) {
        throw new Error(
          `AGENT_VERSION_CHANGED: Agent version changed from ${input.expectedAgentVersion} to ${agent.version}. Refresh authoritative state before retrying recovery detach.`
        );
      }
      if (agent.lifecycle === "active" || agent.lifecycle === "waiting-input" || agent.currentJobId) {
        throw new Error(
          `AGENT_BUSY: Agent has active job ${agent.currentJobId || "unknown"}. Force-stop that job and wait for terminal settlement before recovery detach.`
        );
      }

      const active = this.database
        .prepare(`
          SELECT * FROM activity_agents
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .get(activity.activityId, agent.agentId) as ActivityAgentStorageRow | undefined;
      if (!active) {
        const historical = this.database
          .prepare(`
            SELECT * FROM activity_agents
             WHERE activity_id = ? AND agent_id = ? AND released_at IS NOT NULL
             ORDER BY assigned_at DESC LIMIT 1
          `)
          .get(activity.activityId, agent.agentId) as ActivityAgentStorageRow | undefined;
        if (!historical) {
          throw new Error("The exact Activity assignment does not exist for this Agent.");
        }
        return {
          agent,
          assignment: readActivityAgentRow(historical),
          alreadyReleased: true
        };
      }

      this.database
        .prepare("UPDATE activity_agents SET released_at = ? WHERE assignment_id = ?")
        .run(now, active.assignment_id);
      this.database
        .prepare("UPDATE agents SET version = version + 1, updated_at = ? WHERE agent_id = ?")
        .run(now, agent.agentId);
      this.nextScopeVersion(activity.scopeId, now);
      return {
        agent: this.requireAgent(agent.agentId),
        assignment: { ...readActivityAgentRow(active), releasedAt: now },
        alreadyReleased: false
      };
    });
  }

  setAgentExecutionState(
    agentId: string,
    lifecycle: Extract<BridgeAgentLifecycle, "idle" | "active" | "waiting-input" | "orphaned">,
    options: { currentJobId?: string; orphanedReason?: string; now?: number } = {}
  ): BridgeAgent {
    const now = options.now ?? Date.now();
    return this.transaction(() => {
      const agent = this.requireAgent(agentId);
      const currentJobId = lifecycle === "active" || lifecycle === "waiting-input"
        ? normalizeRequiredString(options.currentJobId, "current job id", 200)
        : undefined;
      const orphanedReason = lifecycle === "orphaned"
        ? normalizeRequiredString(options.orphanedReason, "orphaned reason", 1_000)
        : undefined;
      this.database
        .prepare(`
          UPDATE agents SET lifecycle = ?, current_job_id = ?, orphaned_reason = ?,
                            version = version + 1, updated_at = ?
           WHERE agent_id = ?
        `)
        .run(lifecycle, currentJobId || null, orphanedReason || null, now, agent.agentId);
      this.nextScopeVersion(agent.scopeId, now);
      return this.requireAgent(agent.agentId);
    });
  }

  renameAgent(agentId: string, name: string, now = Date.now()): BridgeAgent {
    return this.transaction(() => {
      const agent = this.requireAgent(agentId);
      const { agentName, normalizedName } = canonicalAgentName(name);
      try {
        this.database
          .prepare(`
            UPDATE agents SET agent_name = ?, normalized_name = ?, version = version + 1, updated_at = ?
             WHERE agent_id = ?
          `)
          .run(agentName, normalizedName, now, agent.agentId);
      } catch (error) {
        if (String(error).includes("agents.scope_id, agents.normalized_name")) {
          throw new Error("AGENT_NAME_CONFLICT: Agent names must be unique in this conversation.");
        }
        throw error;
      }
      this.nextScopeVersion(agent.scopeId, now);
      return this.requireAgent(agent.agentId);
    });
  }

  getAgentMutation(scopeId: string, requestId: string): { actionHash: string; result: unknown } | undefined {
    const row = this.database
      .prepare("SELECT action_hash, result FROM agent_mutations WHERE scope_id = ? AND request_id = ?")
      .get(scopeId, requestId) as { action_hash: string; result: string } | undefined;
    return row
      ? {
          actionHash: row.action_hash,
          result: parseCurrentPayload({ payload: row.result }, "Agent mutation result")
        }
      : undefined;
  }

  recordAgentMutation(scopeId: string, requestId: string, actionHash: string, result: unknown, now = Date.now()): void {
    this.database
      .prepare(`
        INSERT INTO agent_mutations(scope_id, request_id, action_hash, result, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(scopeId, requestId, actionHash, JSON.stringify(result), now);
  }

  getSteeringDelivery(
    scopeId: string,
    requestId: string
  ): SteeringDeliveryRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM steering_deliveries WHERE scope_id = ? AND request_id = ?"
      )
      .get(scopeId, requestId) as Record<string, unknown> | undefined;
    return row ? readSteeringDeliveryRow(row) : undefined;
  }

  listSteeringDeliveries(scopeId?: string): SteeringDeliveryRecord[] {
    const rows = scopeId
      ? this.database
          .prepare(
            "SELECT * FROM steering_deliveries WHERE scope_id = ? ORDER BY created_at ASC"
          )
          .all(scopeId)
      : this.database
          .prepare("SELECT * FROM steering_deliveries ORDER BY created_at ASC")
          .all();
    return (rows as Array<Record<string, unknown>>).map(readSteeringDeliveryRow);
  }

  beginSteeringDelivery(input: BeginSteeringDeliveryInput): SteeringDeliveryRecord {
    const scopeId = normalizeUuid(input.scopeId, "steering scopeId");
    const requestId = normalizeUuid(input.requestId, "steering requestId");
    const actionHash = normalizeDigest(input.actionHash, "steering actionHash");
    const jobId = normalizeRequiredString(input.jobId, "steering jobId", 200);
    const expectedJobVersion = normalizeExpectedVersion(input.expectedJobVersion);
    const promptSha256 = normalizeDigest(input.promptSha256, "steering prompt digest");
    const now = normalizeEventTimestamp(input.now ?? Date.now());
    return this.transaction(() => {
      const existing = this.getSteeringDelivery(scopeId, requestId);
      if (existing) {
        if (existing.actionHash !== actionHash) {
          throw new Error(
            "STEERING_REQUEST_CONFLICT: requestId was already used for a different steering payload in this scope."
          );
        }
        return existing;
      }
      this.ensureScope(scopeId, now);
      this.database
        .prepare(`
          INSERT INTO steering_deliveries(
            scope_id, request_id, action_hash, job_id, expected_job_version,
            prompt_sha256, status, bridge_instance_id, result,
            created_at, updated_at, dispatched_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, ?, ?, NULL, NULL)
        `)
        .run(
          scopeId,
          requestId,
          actionHash,
          jobId,
          expectedJobVersion,
          promptSha256,
          this.currentInstanceId,
          now,
          now
        );
      return this.getSteeringDelivery(scopeId, requestId) as SteeringDeliveryRecord;
    });
  }

  markSteeringDeliveryDispatching(
    scopeId: string,
    requestId: string,
    actionHash: string,
    now = Date.now()
  ): SteeringDeliveryRecord {
    return this.transaction(() => {
      const delivery = this.requireSteeringDelivery(scopeId, requestId, actionHash);
      if (delivery.status === "dispatching" || delivery.status === "delivered") return delivery;
      if (delivery.status !== "prepared") {
        throw new Error(
          `Invalid steering delivery status transition: ${delivery.status} -> dispatching.`
        );
      }
      if (delivery.bridgeInstanceId !== this.currentInstanceId) {
        throw new Error(
          "DELIVERY_UNCERTAIN: A previous bridge instance owns this steering delivery boundary."
        );
      }
      this.database
        .prepare(`
          UPDATE steering_deliveries
             SET status = 'dispatching', updated_at = ?, dispatched_at = ?
           WHERE scope_id = ? AND request_id = ?
        `)
        .run(now, now, delivery.scopeId, delivery.requestId);
      return this.getSteeringDelivery(delivery.scopeId, delivery.requestId) as SteeringDeliveryRecord;
    });
  }

  completeSteeringDelivery(
    scopeId: string,
    requestId: string,
    actionHash: string,
    status: Extract<SteeringDeliveryStatus, "delivered" | "not-delivered" | "uncertain">,
    result: unknown,
    now = Date.now()
  ): SteeringDeliveryRecord {
    return this.transaction(() => {
      const delivery = this.requireSteeringDelivery(scopeId, requestId, actionHash);
      if (
        delivery.status === "delivered" ||
        delivery.status === "not-delivered" ||
        delivery.status === "uncertain"
      ) {
        if (delivery.status !== status) {
          throw new Error(
            `Invalid steering delivery status transition: ${delivery.status} -> ${status}.`
          );
        }
        return delivery;
      }
      if (status === "delivered" && delivery.status !== "dispatching") {
        throw new Error("A steering delivery cannot be marked delivered before dispatch begins.");
      }
      this.database
        .prepare(`
          UPDATE steering_deliveries
             SET status = ?, result = ?, updated_at = ?, completed_at = ?
           WHERE scope_id = ? AND request_id = ?
        `)
        .run(
          status,
          JSON.stringify(result),
          now,
          now,
          delivery.scopeId,
          delivery.requestId
        );
      return this.getSteeringDelivery(delivery.scopeId, delivery.requestId) as SteeringDeliveryRecord;
    });
  }

  getCancellationOperation(
    scopeId: string,
    requestId: string
  ): CancellationOperationRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM cancellation_operations WHERE scope_id = ? AND request_id = ?"
      )
      .get(scopeId, requestId) as Record<string, unknown> | undefined;
    return row ? readCancellationOperationRow(row) : undefined;
  }

  listCancellationOperations(scopeId?: string): CancellationOperationRecord[] {
    const rows = scopeId
      ? this.database
          .prepare(
            "SELECT * FROM cancellation_operations WHERE scope_id = ? ORDER BY created_at ASC"
          )
          .all(scopeId)
      : this.database
          .prepare("SELECT * FROM cancellation_operations ORDER BY created_at ASC")
          .all();
    return (rows as Array<Record<string, unknown>>).map(readCancellationOperationRow);
  }

  beginCancellationOperation(input: BeginCancellationOperationInput): {
    operation: CancellationOperationRecord;
    intent: CancellationIntentRecord;
  } {
    const normalized = normalizeCancellationOperationInput(input);
    return this.transaction(() => {
      const existing = this.getCancellationOperation(normalized.scopeId, normalized.requestId);
      if (existing) {
        if (existing.actionHash !== normalized.actionHash) {
          throw new Error(
            "CANCELLATION_REQUEST_CONFLICT: requestId was already used for a different cancellation payload in this scope."
          );
        }
        throw new Error(
          "CANCELLATION_REQUEST_EXISTS: The cancellation operation was already durably recorded."
        );
      }
      this.ensureScope(normalized.scopeId, normalized.now);
      this.assertCancellationTarget(normalized.scopeId, normalized.target);
      const intentId = randomUUID();
      this.database
        .prepare(`
          INSERT INTO cancellation_operations(
            scope_id, request_id, root_intent_id, action_hash, source, tool_name,
            action_name, target_kind, target_job_id, target_activity_id,
            target_agent_id, target_thread_id, target_turn_id, target_presentation_id,
            expected_version, caller_presentation_kind, caller_presentation_id,
            widget_instance_present, widget_instance_digest, card_generation,
            caller_request_digest, bridge_instance_id, reason_code, reason_text, status,
            result, created_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', NULL, ?, NULL)
        `)
        .run(
          normalized.scopeId,
          normalized.requestId,
          intentId,
          normalized.actionHash,
          normalized.source,
          normalized.toolName,
          normalized.actionName,
          normalized.target.kind,
          normalized.target.jobId || null,
          normalized.target.activityId,
          normalized.target.agentId || null,
          normalized.target.threadId || null,
          normalized.target.turnId || null,
          normalized.target.presentationId || null,
          normalized.expectedVersion,
          normalized.callerPresentation?.kind || null,
          normalized.callerPresentation?.activityPresentationId || null,
          normalized.widgetProof ? 1 : 0,
          normalized.widgetProof?.instanceDigest || null,
          normalized.widgetProof?.cardGeneration || null,
          normalized.callerRequestDigest || null,
          this.currentInstanceId,
          normalized.reasonCode,
          normalized.reason || null,
          normalized.now
        );
      this.insertCancellationIntent({
        intentId,
        scopeId: normalized.scopeId,
        requestId: normalized.requestId,
        cascadeId: intentId,
        source: normalized.source,
        toolName: normalized.toolName,
        actionName: normalized.actionName,
        target: normalized.target,
        expectedVersion: normalized.expectedVersion,
        callerPresentation: normalized.callerPresentation,
        widgetProof: normalized.widgetProof,
        callerRequestDigest: normalized.callerRequestDigest,
        reasonCode: normalized.reasonCode,
        now: normalized.now
      });
      const intent = this.requireCancellationIntent(intentId);
      this.recordCancellationIntentEvent(intent, "cancellation-intent-recorded", normalized.now);
      return {
        operation: this.getCancellationOperation(
          normalized.scopeId,
          normalized.requestId
        ) as CancellationOperationRecord,
        intent
      };
    });
  }

  createCancellationIntent(input: CreateCancellationIntentInput): CancellationIntentRecord {
    const normalized = normalizeCancellationIntentInput(input);
    return this.transaction(() => {
      const operation = this.getCancellationOperation(normalized.scopeId, normalized.requestId);
      if (!operation) {
        throw new Error(
          "CANCELLATION_PROVENANCE_REQUIRED: Child cancellation intent requires a durable parent operation."
        );
      }
      if (operation.status !== "recorded") {
        throw new Error("A completed cancellation operation cannot accept another child intent.");
      }
      const parent = this.requireCancellationIntent(normalized.parentIntentId);
      if (
        parent.scopeId !== normalized.scopeId ||
        parent.requestId !== normalized.requestId ||
        parent.cascadeId !== normalized.cascadeId
      ) {
        throw new Error("Cancellation parent/cascade correlation does not match the durable operation.");
      }
      this.assertCancellationTarget(normalized.scopeId, normalized.target);
      const intentId = randomUUID();
      this.insertCancellationIntent({ ...normalized, intentId });
      const intent = this.requireCancellationIntent(intentId);
      this.recordCancellationIntentEvent(intent, "cancellation-intent-recorded", normalized.now);
      return intent;
    });
  }

  getCancellationIntent(intentId: string): CancellationIntentRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM cancellation_intents WHERE intent_id = ?")
      .get(intentId) as Record<string, unknown> | undefined;
    return row ? readCancellationIntentRow(row) : undefined;
  }

  listCancellationIntents(options: {
    scopeId?: string;
    requestId?: string;
    jobId?: string;
    activityId?: string;
  } = {}): CancellationIntentRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.scopeId) {
      clauses.push("scope_id = ?");
      values.push(options.scopeId);
    }
    if (options.requestId) {
      clauses.push("request_id = ?");
      values.push(options.requestId);
    }
    if (options.jobId) {
      clauses.push("target_job_id = ?");
      values.push(options.jobId);
    }
    if (options.activityId) {
      clauses.push("target_activity_id = ?");
      values.push(options.activityId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database
      .prepare(`SELECT * FROM cancellation_intents${where} ORDER BY created_at ASC, rowid ASC`)
      .all(...values) as Array<Record<string, unknown>>;
    return rows.map(readCancellationIntentRow);
  }

  setCancellationIntentStatus(
    intentId: string,
    status: Exclude<CancellationIntentStatus, "recorded">,
    now = Date.now()
  ): CancellationIntentRecord {
    return this.transaction(() => {
      const current = this.requireCancellationIntent(intentId);
      if (current.status === status) return current;
      const terminal = current.status === "succeeded" ||
        current.status === "failed" ||
        current.status === "no-op";
      if (
        terminal ||
        (current.status === "recorded" && status === "succeeded")
      ) {
        throw new Error(
          `Invalid cancellation intent status transition: ${current.status} -> ${status}.`
        );
      }
      this.database
        .prepare(`
          UPDATE cancellation_intents
             SET status = ?,
                 dispatched_at = CASE WHEN ? = 'dispatched' THEN COALESCE(dispatched_at, ?) ELSE dispatched_at END,
                 completed_at = CASE WHEN ? IN ('succeeded','failed','no-op') THEN COALESCE(completed_at, ?) ELSE completed_at END
           WHERE intent_id = ?
        `)
        .run(status, status, now, status, now, intentId);
      const updated = this.requireCancellationIntent(intentId);
      this.recordCancellationIntentEvent(updated, `cancellation-intent-${status}`, now);
      return updated;
    });
  }

  completeCancellationOperation(
    scopeId: string,
    requestId: string,
    result: unknown,
    status: Exclude<CancellationOperationStatus, "recorded"> = "completed",
    now = Date.now()
  ): CancellationOperationRecord {
    return this.transaction(() => {
      const operation = this.getCancellationOperation(scopeId, requestId);
      if (!operation) throw new Error("Unknown durable cancellation operation.");
      if (operation.status !== "recorded") {
        if (operation.status === status) return operation;
        throw new Error("A cancellation operation already has a terminal outcome.");
      }
      this.database
        .prepare(`
          UPDATE cancellation_operations
             SET status = ?, result = ?, completed_at = ?
           WHERE scope_id = ? AND request_id = ? AND status = 'recorded'
        `)
        .run(status, JSON.stringify(result), now, scopeId, requestId);
      return this.getCancellationOperation(scopeId, requestId) as CancellationOperationRecord;
    });
  }

  recordTransportObservation(input: {
    kind: TransportObservationKind;
    scopeId?: string;
    jobId?: string;
    activityId?: string;
    toolName?: string;
    callerRequestDigest?: string;
    reasonCode: string;
    now?: number;
  }): TransportObservationRecord {
    if (!TRANSPORT_OBSERVATION_KINDS.includes(input.kind)) {
      throw new Error("Unsupported transport observation kind.");
    }
    const now = input.now ?? Date.now();
    const reasonCode = normalizeReasonCode(input.reasonCode);
    const toolName = input.toolName
      ? normalizeRequiredString(input.toolName, "transport observation tool", 100)
      : undefined;
    const callerRequestDigest = normalizeOptionalDigest(input.callerRequestDigest);
    const scopeId = input.scopeId ? normalizeUuid(input.scopeId, "observation scopeId") : undefined;
    return this.transaction(() => {
      const result = this.database
        .prepare(`
          INSERT INTO transport_observations(
            kind, scope_id, job_id, activity_id, tool_name, caller_request_digest,
            bridge_instance_id, reason_code, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.kind,
          scopeId || null,
          normalizeOptionalString(input.jobId) || null,
          normalizeOptionalString(input.activityId) || null,
          toolName || null,
          callerRequestDigest || null,
          this.currentInstanceId,
          reasonCode,
          now
        );
      this.database
        .prepare(`
          DELETE FROM transport_observations
           WHERE observation_id NOT IN (
             SELECT observation_id FROM transport_observations
              ORDER BY observation_id DESC LIMIT ?
           )
        `)
        .run(TRANSPORT_OBSERVATION_LIMIT);
      const row = this.database
        .prepare("SELECT * FROM transport_observations WHERE observation_id = ?")
        .get(Number(result.lastInsertRowid)) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Transport observation was not durably recorded.");
      return readTransportObservationRow(row);
    });
  }

  listTransportObservations(kind?: TransportObservationKind): TransportObservationRecord[] {
    const rows = kind
      ? this.database
          .prepare("SELECT * FROM transport_observations WHERE kind = ? ORDER BY observation_id ASC")
          .all(kind)
      : this.database
          .prepare("SELECT * FROM transport_observations ORDER BY observation_id ASC")
          .all();
    return (rows as Array<Record<string, unknown>>).map(readTransportObservationRow);
  }

  setActivityPolicy(
    activityId: string,
    policy: {
      handoffPolicy?: ActivityHandoffPolicy;
      completionTrigger?: ActivityCompletionTrigger;
      kind?: ActivityKind;
    },
    now = Date.now()
  ): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      if (activity.lifecycle !== "open") {
        throw new Error("Activity policy can only change while the Activity is open.");
      }
      const kind = policy.kind || activity.kind;
      const handoffPolicy = policy.handoffPolicy || activity.handoffPolicy;
      const completionTrigger = policy.completionTrigger || activity.completionTrigger;
      assertActivityPolicy(kind, handoffPolicy, completionTrigger);
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET kind = ?, handoff_policy = ?, completion_trigger = ?,
                 verification = CASE WHEN ? = 'verify' THEN verification ELSE 'not-required' END,
                 version = version + 1, updated_at = ?
           WHERE activity_id = ?
        `)
        .run(kind, handoffPolicy, completionTrigger, handoffPolicy, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "policy-updated",
        createdAt: now,
        payload: { kind, handoffPolicy, completionTrigger }
      });
      return this.requireActivity(activityId);
    });
  }

  sealActivity(activityId: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireActivity(activityId);
      if (activity.lifecycle !== "open") {
        throw new Error("Only an open Activity can be sealed.");
      }
      if (activity.counts.total === 0) {
        throw new Error("An Activity must contain at least one Codex job before it can be sealed.");
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'sealed', sealed_at = ?, updated_at = ?, version = version + 1
           WHERE activity_id = ?
        `)
        .run(now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "activity-sealed",
        createdAt: now,
        payload: {}
      });
      this.reconcileActivity(activityId, scopeVersion, now);
      return this.requireActivity(activityId);
    });
  }

  completeActivity(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "completed");
      this.assertNoRunningJobs(activity, "complete");
      if (activity.verification === "pending" || activity.verification === "verifying") {
        throw new Error("Finish Activity verification before completing the Activity.");
      }
      if (activity.handoffPolicy === "verify" && activity.verification !== "verified") {
        throw new Error(
          "A verify Activity cannot be completed before verification passes. Start verification first."
        );
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      const completionVersion = activity.completionVersion + 1;
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'completed', waiting_on = 'none', verification = 'not-required',
                 version = version + 1,
                 completion_version = ?, updated_at = ?, completed_at = ?
           WHERE activity_id = ?
        `)
        .run(completionVersion, now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "activity-completed",
        createdAt: now,
        payload: { source: "explicit-update", reason: normalizeOptionalBoundedText(reason, 2_000) || null }
      });
      if (activity.handoffPolicy === "notify") {
        this.insertCompletionOutbox({
          activityId,
          scopeId: activity.scopeId,
          completionVersion,
          channel: "notify",
          createdAt: now,
          payload: {
            activityId,
            completionVersion,
            channel: "notify",
            counts: activity.counts,
            requiresResultVerification: false,
            source: "explicit-update"
          }
        });
      }
      return this.requireActivity(activityId);
    });
  }

  abandonActivity(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "abandoned");
      this.assertNoRunningJobs(activity, "abandon");
      return this.transitionActivityTerminal(
        activity,
        "abandoned",
        "activity-abandoned",
        { reason: normalizeOptionalBoundedText(reason, 2_000) || null },
        now
      );
    });
  }

  beginActivityTermination(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "terminating");
      if (activity.lifecycle === "terminating") return activity;
      if (activity.counts.running === 0) {
        throw new Error("Cannot terminate an Activity that has no active child jobs.");
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'terminating', waiting_on = 'codex',
                 version = version + 1, updated_at = ?
           WHERE activity_id = ?
        `)
        .run(now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "activity-terminating",
        createdAt: now,
        payload: {
          reason: normalizeOptionalBoundedText(reason, 2_000) || null,
          partialFilesystemChangesMayRemain: true
        }
      });
      return this.requireActivity(activityId);
    });
  }

  cancelActivity(activityId: string, reason?: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "cancelled");
      this.assertNoRunningJobs(activity, "cancel");
      return this.transitionActivityTerminal(
        activity,
        "cancelled",
        "activity-cancelled",
        {
          reason: normalizeOptionalBoundedText(reason, 2_000) || null,
          partialFilesystemChangesMayRemain: true
        },
        now
      );
    });
  }

  startActivityVerification(activityId: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "verified");
      if (activity.handoffPolicy !== "verify") {
        throw new Error("Only an Activity with handoffPolicy='verify' can start verification.");
      }
      this.assertNoRunningJobs(activity, "start verification for");
      if (activity.counts.total === 0) {
        throw new Error("An Activity must contain at least one Codex job before verification starts.");
      }
      if (activity.counts.completed === 0) {
        throw new Error("Verification requires at least one completed child job with an outcome to inspect.");
      }
      if (
        activity.verification !== "not-required" &&
        activity.verification !== "pending" &&
        activity.verification !== "failed"
      ) {
        throw new Error(`Activity verification cannot start from '${activity.verification}'.`);
      }
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'sealed', sealed_at = COALESCE(sealed_at, ?),
                 waiting_on = 'verification', verification = 'verifying',
                 version = version + 1, updated_at = ?
           WHERE activity_id = ?
        `)
        .run(now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "verification-started",
        createdAt: now,
        payload: { previousVerification: activity.verification }
      });
      this.acknowledgeCompletionOutbox(activityId, "verify", now);
      return this.requireActivity(activityId);
    });
  }

  passActivityVerification(
    activityId: string,
    evidence: ActivityVerificationEvidence,
    now = Date.now()
  ): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "verified");
      if (activity.lifecycle !== "sealed" || activity.verification !== "verifying") {
        throw new Error("Activity verification can pass only after verification has started.");
      }
      this.assertNoRunningJobs(activity, "verify");
      const normalizedEvidence = normalizeVerificationEvidence(evidence);
      this.assertEvidenceJobsBelongToActivity(activityId, normalizedEvidence.jobIds || []);
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      const completionVersion = activity.completionVersion + 1;
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'completed', waiting_on = 'none', verification = 'verified',
                 version = version + 1, completion_version = ?, updated_at = ?, completed_at = ?
           WHERE activity_id = ?
        `)
        .run(completionVersion, now, now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "verification-passed",
        createdAt: now,
        payload: { evidence: normalizedEvidence }
      });
      return this.requireActivity(activityId);
    });
  }

  failActivityVerification(activityId: string, reason: string, now = Date.now()): BridgeActivity {
    return this.transaction(() => {
      const activity = this.requireMutableActivity(activityId, "verification failed");
      if (activity.verification !== "pending" && activity.verification !== "verifying") {
        throw new Error("Activity verification can fail only while pending or verifying.");
      }
      const normalizedReason = normalizeRequiredBoundedText(reason, "Verification failure reason", 2_000);
      const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
      this.database
        .prepare(`
          UPDATE activities
             SET lifecycle = 'open', sealed_at = NULL, waiting_on = 'orchestrator',
                 verification = 'failed', version = version + 1, updated_at = ?, completed_at = NULL
           WHERE activity_id = ?
        `)
        .run(now, activityId);
      this.insertActivityEvent({
        activityId,
        scopeId: activity.scopeId,
        scopeVersion,
        eventType: "verification-failed",
        createdAt: now,
        payload: { reason: normalizedReason }
      });
      this.acknowledgeCompletionOutbox(activityId, "verify", now);
      return this.requireActivity(activityId);
    });
  }

  getScopeVersion(scopeId: string): number {
    const row = this.database
      .prepare("SELECT version FROM scopes WHERE scope_id = ?")
      .get(scopeId) as { version: number } | undefined;
    return row?.version || 0;
  }

  listActivityEvents(activityId?: string): ActivityEventRecord[] {
    const rows = activityId
      ? this.database
          .prepare("SELECT * FROM activity_events WHERE activity_id = ? ORDER BY event_id ASC")
          .all(activityId)
      : this.database.prepare("SELECT * FROM activity_events ORDER BY event_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      eventId: Number(row.event_id),
      activityId: String(row.activity_id),
      scopeId: String(row.scope_id),
      scopeVersion: Number(row.scope_version),
      eventType: String(row.event_type),
      createdAt: Number(row.created_at),
      payload: parseCurrentPayload({ payload: String(row.payload) }, "activity event")
    }));
  }

  listJobEvents(jobId?: string): JobEventRecord[] {
    const rows = jobId
      ? this.database.prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY event_id ASC").all(jobId)
      : this.database.prepare("SELECT * FROM job_events ORDER BY event_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      eventId: Number(row.event_id),
      jobId: String(row.job_id),
      activityId: String(row.activity_id),
      scopeId: String(row.scope_id),
      scopeVersion: Number(row.scope_version),
      eventType: String(row.event_type),
      status: String(row.status),
      createdAt: Number(row.created_at),
      payload: parseCurrentPayload({ payload: String(row.payload) }, "job event")
    }));
  }

  recordJobTelemetryEvent(
    jobId: string,
    eventType: string,
    payload: unknown,
    createdAt = Date.now(),
    waitingOn?: "codex" | "user",
    state?: JobProgressStateInput
  ): number {
    return this.transaction(() => {
      const update = state ? this.updateJobProgressStateInternal(jobId, state) : undefined;
      const row = update?.row || this.getJobProgressStorageRow(jobId);
      if (!row) throw new Error("Cannot attach telemetry to an unknown Codex job.");
      const scopeVersion = this.nextRuntimeScopeVersion(row.scope_id, createdAt);
      if (update?.resumedFromTerminationFailure) {
        this.insertJobEvent({
          jobId: row.job_id,
          activityId: row.activity_id,
          scopeId: row.scope_id,
          scopeVersion,
          eventType: "job-running",
          status: "running",
          createdAt: state?.updatedAt ?? createdAt,
          payload: { resumedFrom: "termination-failed" }
        });
      }
      this.insertJobEvent({
        jobId: row.job_id,
        activityId: row.activity_id,
        scopeId: row.scope_id,
        scopeVersion,
        eventType: normalizeEventType(eventType),
        status: update?.status || row.status,
        createdAt,
        payload
      });
      if (waitingOn) {
        this.database
          .prepare(`
            UPDATE activities
               SET waiting_on = ?, updated_at = ?, version = version + 1
             WHERE activity_id = ? AND lifecycle IN ('open','sealed','terminating')
          `)
          .run(waitingOn, createdAt, row.activity_id);
        this.insertActivityEvent({
          activityId: row.activity_id,
          scopeId: row.scope_id,
          scopeVersion,
          eventType: waitingOn === "user" ? "activity-waiting-user" : "activity-waiting-codex",
          createdAt,
          payload: { jobId: row.job_id }
        });
      }
      return scopeVersion;
    });
  }

  updateJobProgressState(jobId: string, state: JobProgressStateInput): boolean {
    return this.transaction(() => {
      const update = this.updateJobProgressStateInternal(jobId, state);
      if (!update.resumedFromTerminationFailure && !update.agentStateChanged) return false;
      const scopeVersion = this.nextRuntimeScopeVersion(update.row.scope_id, state.updatedAt);
      if (update.resumedFromTerminationFailure) {
        this.insertJobEvent({
          jobId: update.row.job_id,
          activityId: update.row.activity_id,
          scopeId: update.row.scope_id,
          scopeVersion,
          eventType: "job-running",
          status: "running",
          createdAt: state.updatedAt,
          payload: { resumedFrom: "termination-failed" }
        });
      }
      return true;
    });
  }

  getJobCompletionDelivery(
    jobId: string,
    scopeId?: string
  ): JobCompletionDeliveryRecord | undefined {
    const row = scopeId
      ? this.database.prepare(
          "SELECT * FROM job_completion_deliveries WHERE job_id=? AND scope_id=?"
        ).get(
          normalizeUuid(jobId, "completion delivery jobId"),
          normalizeUuid(scopeId, "completion delivery scopeId")
        )
      : this.database.prepare(
          "SELECT * FROM job_completion_deliveries WHERE job_id=?"
        ).get(normalizeUuid(jobId, "completion delivery jobId"));
    return row ? readJobCompletionDeliveryRow(row as Record<string, unknown>) : undefined;
  }

  getJobCompletionDeliveryByReceipt(
    receipt: string,
    scopeId: string
  ): JobCompletionDeliveryRecord | undefined {
    const row = this.database.prepare(
      "SELECT * FROM job_completion_deliveries WHERE receipt=? AND scope_id=?"
    ).get(
      normalizeJobCompletionReceipt(receipt),
      normalizeUuid(scopeId, "completion delivery scopeId")
    ) as Record<string, unknown> | undefined;
    return row ? readJobCompletionDeliveryRow(row) : undefined;
  }

  claimJobCompletionDelivery(
    jobId: string,
    scopeId: string,
    leaseOwner: string,
    leaseMs = 20_000,
    now = Date.now()
  ): JobCompletionDeliveryRecord | undefined {
    const normalizedJobId = normalizeUuid(jobId, "completion delivery jobId");
    const normalizedScopeId = normalizeUuid(scopeId, "completion delivery scopeId");
    const normalizedLeaseOwner = normalizeUuid(leaseOwner, "completion delivery leaseOwner");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60_000) {
      throw new Error("COMPLETION_LEASE_INVALID: Lease duration must be between 1 and 60 seconds.");
    }
    return this.transaction(() => {
      // A process can disappear after crossing the host-send boundary. Once a
      // lease expires, never infer that no message was sent and never resend.
      this.database.prepare(`
        UPDATE job_completion_deliveries
           SET state='acceptance-unknown', lease_owner=NULL, lease_expires_at=NULL,
               acceptance_unknown_at=COALESCE(acceptance_unknown_at,?), updated_at=?
         WHERE job_id=? AND scope_id=? AND state='leased' AND lease_expires_at<=?
      `).run(now, now, normalizedJobId, normalizedScopeId, now);
      const result = this.database.prepare(`
        UPDATE job_completion_deliveries
           SET state='leased', attempt_count=attempt_count+1,
               lease_owner=?, lease_expires_at=?, next_attempt_at=NULL, updated_at=?
         WHERE job_id=? AND scope_id=?
           AND attempt_count < ?
           AND EXISTS (
             SELECT 1 FROM jobs
              WHERE jobs.job_id=job_completion_deliveries.job_id
                AND COALESCE(json_extract(jobs.payload,'$.completionDeliveryPolicy'),'live-card')='live-card'
           )
           AND (
             state='pending' OR
             (state='host-rejected' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?)
           )
      `).run(
        normalizedLeaseOwner,
        now + leaseMs,
        now,
        normalizedJobId,
        normalizedScopeId,
        JOB_COMPLETION_MAX_DELIVERY_ATTEMPTS,
        now
      );
      if (result.changes !== 1) return undefined;
      return this.getJobCompletionDelivery(normalizedJobId, normalizedScopeId);
    });
  }

  markJobCompletionHostAccepted(input: {
    jobId: string;
    scopeId: string;
    receipt: string;
    leaseOwner: string;
    now?: number;
  }): JobCompletionDeliveryRecord {
    return this.finishJobCompletionLease(input, "host-accepted");
  }

  markJobCompletionAcceptanceUnknown(input: {
    jobId: string;
    scopeId: string;
    receipt: string;
    leaseOwner: string;
    now?: number;
  }): JobCompletionDeliveryRecord {
    return this.finishJobCompletionLease(input, "acceptance-unknown");
  }

  markJobCompletionHostRejected(input: {
    jobId: string;
    scopeId: string;
    receipt: string;
    leaseOwner: string;
    error?: string;
    now?: number;
  }): JobCompletionDeliveryRecord {
    const now = normalizeEventTimestamp(input.now ?? Date.now());
    const jobId = normalizeUuid(input.jobId, "completion delivery jobId");
    const scopeId = normalizeUuid(input.scopeId, "completion delivery scopeId");
    const receipt = normalizeJobCompletionReceipt(input.receipt);
    const owner = normalizeUuid(input.leaseOwner, "completion delivery leaseOwner");
    const error = input.error?.trim().slice(0, 500) || null;
    return this.transaction(() => {
      const current = this.getJobCompletionDelivery(jobId, scopeId);
      if (!current || current.receipt !== receipt) {
        throw new Error("COMPLETION_DELIVERY_UNAVAILABLE: Exact completion delivery is unavailable.");
      }
      if (current.state === "result-read") return current;
      if (current.state !== "leased" || current.leaseOwner !== owner) {
        throw new Error("COMPLETION_LEASE_MISMATCH: Completion delivery lease is missing or owned by another card.");
      }
      const nextAttemptAt = current.attemptCount < JOB_COMPLETION_MAX_DELIVERY_ATTEMPTS
        ? now + Math.min(120_000, 5_000 * 2 ** Math.max(0, current.attemptCount - 1))
        : null;
      this.database.prepare(`
        UPDATE job_completion_deliveries
           SET state='host-rejected', next_attempt_at=?, lease_owner=NULL,
               lease_expires_at=NULL, last_host_rejected_at=?, last_host_error=?, updated_at=?
         WHERE job_id=? AND scope_id=? AND receipt=? AND state='leased' AND lease_owner=?
      `).run(nextAttemptAt, now, error, now, jobId, scopeId, receipt, owner);
      return this.requireJobCompletionDelivery(jobId, scopeId);
    });
  }

  releaseJobCompletionDelivery(input: {
    jobId: string;
    scopeId: string;
    receipt: string;
    leaseOwner: string;
    now?: number;
  }): JobCompletionDeliveryRecord {
    const now = normalizeEventTimestamp(input.now ?? Date.now());
    const jobId = normalizeUuid(input.jobId, "completion delivery jobId");
    const scopeId = normalizeUuid(input.scopeId, "completion delivery scopeId");
    const receipt = normalizeJobCompletionReceipt(input.receipt);
    const owner = normalizeUuid(input.leaseOwner, "completion delivery leaseOwner");
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE job_completion_deliveries
           SET state='pending', attempt_count=MAX(0,attempt_count-1),
               next_attempt_at=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=?
         WHERE job_id=? AND scope_id=? AND receipt=? AND state='leased' AND lease_owner=?
      `).run(now, jobId, scopeId, receipt, owner);
      if (result.changes !== 1) {
        throw new Error("COMPLETION_LEASE_MISMATCH: Completion delivery lease is missing or owned by another card.");
      }
      return this.requireJobCompletionDelivery(jobId, scopeId);
    });
  }

  recordJobCompletionResultOffer(input: {
    scopeId: string;
    source: JobCompletionResultReadSource;
    jobId?: string;
    receipt?: string;
    now?: number;
  }): JobCompletionDeliveryRecord | undefined {
    const scopeId = normalizeUuid(input.scopeId, "completion delivery scopeId");
    const timestamp = normalizeEventTimestamp(input.now ?? Date.now());
    if (input.source === "completion-receipt") {
      if (!input.receipt || input.jobId) {
        throw new Error("COMPLETION_RESULT_OFFER_INVALID: Receipt offer requires only an exact receipt.");
      }
      const receipt = normalizeJobCompletionReceipt(input.receipt);
      const result = this.database.prepare(`
        UPDATE job_completion_deliveries
           SET completion_result_offered_at=COALESCE(completion_result_offered_at,?),
               updated_at=CASE WHEN completion_result_offered_at IS NULL THEN ? ELSE updated_at END
         WHERE receipt=? AND scope_id=?
      `).run(timestamp, timestamp, receipt, scopeId);
      if (result.changes !== 1) {
        throw new Error("COMPLETION_DELIVERY_UNAVAILABLE: Exact completion delivery is unavailable.");
      }
      return this.getJobCompletionDeliveryByReceipt(receipt, scopeId);
    }
    if (!input.jobId || input.receipt) {
      throw new Error("COMPLETION_RESULT_OFFER_INVALID: Direct offer requires only an exact Job.");
    }
    const jobId = normalizeUuid(input.jobId, "completion delivery jobId");
    this.database.prepare(`
      UPDATE job_completion_deliveries
         SET direct_result_offered_at=COALESCE(direct_result_offered_at,?),
             updated_at=CASE WHEN direct_result_offered_at IS NULL THEN ? ELSE updated_at END
       WHERE job_id=? AND scope_id=?
    `).run(timestamp, timestamp, jobId, scopeId);
    return this.getJobCompletionDelivery(jobId, scopeId);
  }

  listCompletionOutbox(activityId?: string): CompletionOutboxRecord[] {
    const rows = activityId
      ? this.database
          .prepare("SELECT * FROM completion_outbox WHERE activity_id = ? ORDER BY outbox_id ASC")
          .all(activityId)
      : this.database.prepare("SELECT * FROM completion_outbox ORDER BY outbox_id ASC").all();
    return (rows as Array<Record<string, unknown>>).map(readCompletionOutboxRow);
  }

  listPendingCompletionOutbox(scopeId: string, limit = 20): CompletionOutboxRecord[] {
    const now = Date.now();
    const rows = this.database
      .prepare(`
          SELECT * FROM completion_outbox
         WHERE scope_id = ? AND delivered_at IS NULL AND acknowledged_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC LIMIT ?
      `)
      .all(scopeId, now, Math.max(0, Math.min(100, limit)));
    return (rows as Array<Record<string, unknown>>).map(readCompletionOutboxRow);
  }

  /**
   * Native completion alerts have no conversation-card capability. Limit this
   * cross-scope read to terminal notify records and expose only an opaque
   * projection through the private companion service.
   */
  listPendingNotifyCompletionOutbox(limit = 20): CompletionOutboxRecord[] {
    const now = Date.now();
    const rows = this.database
      .prepare(`
          SELECT * FROM completion_outbox
           WHERE channel = 'notify' AND delivered_at IS NULL AND acknowledged_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (lease_owner IS NULL OR lease_expires_at <= ?)
           ORDER BY created_at ASC LIMIT ?
      `)
      .all(now, now, Math.max(0, Math.min(100, limit)));
    return (rows as Array<Record<string, unknown>>).map(readCompletionOutboxRow);
  }

  getCompletionOutbox(outboxId: number): CompletionOutboxRecord | undefined {
    if (!Number.isSafeInteger(outboxId) || outboxId < 1) return undefined;
    const row = this.database
      .prepare("SELECT * FROM completion_outbox WHERE outbox_id = ?")
      .get(outboxId) as Record<string, unknown> | undefined;
    return row ? readCompletionOutboxRow(row) : undefined;
  }

  listPendingCompletionActivityIds(scopeId: string): string[] {
    const rows = this.database
      .prepare(`
        SELECT DISTINCT activity_id
          FROM completion_outbox
         WHERE scope_id = ? AND delivered_at IS NULL AND acknowledged_at IS NULL
         ORDER BY activity_id ASC
      `)
      .all(normalizeUuid(scopeId, "completion outbox scopeId")) as Array<{ activity_id: string }>;
    return rows.map((row) => row.activity_id);
  }

  claimCompletionOutbox(
    outboxId: number,
    scopeId: string,
    leaseOwner: string,
    leaseMs = 60_000,
    now = Date.now()
  ): CompletionOutboxRecord | undefined {
    return this.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE completion_outbox
             SET lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL,
                 attempt_count = attempt_count + 1
           WHERE outbox_id = ? AND scope_id = ?
             AND delivered_at IS NULL AND acknowledged_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
        `)
        .run(leaseOwner, now + leaseMs, outboxId, scopeId, now, now, leaseOwner);
      if (result.changes !== 1) return undefined;
      const row = this.database
        .prepare("SELECT * FROM completion_outbox WHERE outbox_id = ?")
        .get(outboxId) as Record<string, unknown> | undefined;
      return row ? readCompletionOutboxRow(row) : undefined;
    });
  }

  markCompletionOutboxDelivered(
    outboxId: number,
    scopeId: string,
    leaseOwner: string,
    now = Date.now()
  ): CompletionOutboxRecord {
    return this.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE completion_outbox
             SET delivered_at = COALESCE(delivered_at, ?), lease_owner = NULL,
                 lease_expires_at = NULL, next_attempt_at = NULL
           WHERE outbox_id = ? AND scope_id = ? AND (lease_owner = ? OR delivered_at IS NOT NULL)
        `)
        .run(now, outboxId, scopeId, leaseOwner);
      if (result.changes !== 1) throw new Error("Completion handoff lease is missing or owned by another widget.");
      const row = this.database
        .prepare("SELECT * FROM completion_outbox WHERE outbox_id = ?")
        .get(outboxId) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Unknown completion handoff event.");
      return readCompletionOutboxRow(row);
    });
  }

  releaseCompletionOutbox(
    outboxId: number,
    scopeId: string,
    leaseOwner: string
  ): void {
    this.database
      .prepare(`
        UPDATE completion_outbox SET lease_owner = NULL, lease_expires_at = NULL
         WHERE outbox_id = ? AND scope_id = ? AND lease_owner = ? AND delivered_at IS NULL
      `)
      .run(outboxId, scopeId, leaseOwner);
  }

  markCompletionOutboxUncertain(
    outboxId: number,
    scopeId: string,
    leaseOwner: string
  ): CompletionOutboxRecord {
    return this.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE completion_outbox
             SET lease_owner = NULL, lease_expires_at = NULL,
                 next_attempt_at = ?
           WHERE outbox_id = ? AND scope_id = ? AND lease_owner = ?
             AND delivered_at IS NULL AND acknowledged_at IS NULL
        `)
        .run(COMPLETION_OUTBOX_UNCERTAIN_HOLD_AT, outboxId, scopeId, leaseOwner);
      if (result.changes !== 1) {
        throw new Error("Completion handoff lease is missing or owned by another widget.");
      }
      const row = this.database
        .prepare("SELECT * FROM completion_outbox WHERE outbox_id = ?")
        .get(outboxId) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Unknown completion handoff event.");
      return readCompletionOutboxRow(row);
    });
  }

  listBridgeInstances(): BridgeInstanceRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM bridge_instances ORDER BY started_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      instanceId: String(row.instance_id),
      startedAt: Number(row.started_at),
      stoppedAt: optionalNumber(row.stopped_at),
      terminationReason: optionalString(row.termination_reason),
      processId: Number(row.process_id)
    }));
  }

  getSettingsRecord(): SettingsStorageRecord | undefined {
    const row = this.database
      .prepare(`
        SELECT payload, settings_revision, updated_at
          FROM user_settings WHERE singleton = 1
      `)
      .get() as (JsonRow & { settings_revision: number; updated_at: number | null }) | undefined;
    return row
      ? {
          settingsRevision: row.settings_revision,
          updatedAt: row.updated_at,
          payload: parseCurrentPayload(row, "settings")
        }
      : undefined;
  }

  getSettings(): unknown | undefined {
    return this.getSettingsRecord()?.payload;
  }

  getSettingsRevision(): number {
    return this.getSettingsRecord()?.settingsRevision || 0;
  }

  assertSettingsRevision(expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error("SETTINGS_REVISION_CONFLICT: Invalid expected settings revision.");
    }
    if (this.getSettingsRevision() !== expectedRevision) {
      throw new Error(
        "SETTINGS_REVISION_CONFLICT: Settings changed after this card was opened."
      );
    }
  }

  /** Write one ordinary-settings generation. Caller decides whether the value is a no-op. */
  writeSettings(
    settings: unknown,
    expectedRevision: number,
    now = Date.now()
  ): SettingsStorageRecord {
    return this.transaction(() => {
      this.assertSettingsRevision(expectedRevision);
      const nextRevision = expectedRevision + 1;
      this.database
        .prepare(`
          INSERT INTO user_settings(singleton, payload, settings_revision, updated_at)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            payload = excluded.payload,
            settings_revision = excluded.settings_revision,
            updated_at = excluded.updated_at
        `)
        .run(JSON.stringify(settings), nextRevision, now);
      return {
        settingsRevision: nextRevision,
        updatedAt: now,
        payload: structuredClone(settings)
      };
    });
  }

  modelDescriptionHistoryIds(): string[] {
    return (this.database.prepare(`
      SELECT DISTINCT model_id FROM model_description_versions ORDER BY model_id
    `).all() as Array<{ model_id: string }>).map((row) => row.model_id);
  }

  modelDescriptionHistory(
    modelId: string,
    beforeVersion: number | undefined,
    limit: number
  ): ModelDescriptionHistoryPage {
    const rows = this.database.prepare(`
      SELECT version, description, created_at FROM model_description_versions
       WHERE model_id = ? AND version < ? ORDER BY version DESC LIMIT ?
    `).all(modelId, beforeVersion ?? Number.MAX_SAFE_INTEGER, limit + 1) as Array<{
      version: number; description: string | null; created_at: number | null
    }>;
    const visible = rows.slice(0, limit);
    return {
      kind: "model-description-history",
      modelId,
      versions: visible.map((row) => ({
        version: row.version,
        description: row.description,
        createdAt: row.created_at === null ? null : new Date(row.created_at).toISOString()
      })),
      nextBeforeVersion: rows.length > limit ? visible.at(-1)!.version : null
    };
  }

  appendModelDescriptionVersionChanges(
    previous: ModelDescriptionOverrides,
    next: ModelDescriptionOverrides,
    now: number
  ): void {
    const insert = this.database.prepare(`
      INSERT INTO model_description_versions(model_id, version, description, created_at)
      SELECT ?, COALESCE(MAX(version), 0) + 1, ?, ?
        FROM model_description_versions WHERE model_id = ?
    `);
    for (const modelId of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      const before = Object.prototype.hasOwnProperty.call(previous, modelId) ? previous[modelId] : null;
      const after = Object.prototype.hasOwnProperty.call(next, modelId) ? next[modelId] : null;
      if (before !== after) insert.run(modelId, after, now, modelId);
    }
  }

  getProjectRegistrySnapshot(): ProjectRegistrySnapshot {
    const registry = this.database
      .prepare(`
        SELECT registry_revision, updated_at
          FROM project_registry WHERE singleton = 1
      `)
      .get() as ProjectRegistryStorageRow | undefined;
    if (!registry) throw new Error("Project registry metadata is missing.");
    const rows = this.database
      .prepare(`
        SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
               created_at, updated_at, archived_at, deleted_at
          FROM projects
         WHERE deleted_at IS NULL
         ORDER BY sort_order ASC, created_at ASC, project_id ASC
      `)
      .all() as ProjectStorageRow[];
    return {
      registryRevision: registry.registry_revision,
      updatedAt: registry.updated_at,
      projects: rows.map(readProjectStorageRow)
    };
  }

  getProjectRegistryRevision(): number {
    const row = this.database
      .prepare("SELECT registry_revision FROM project_registry WHERE singleton = 1")
      .get() as { registry_revision: number } | undefined;
    if (!row) throw new Error("Project registry metadata is missing.");
    return row.registry_revision;
  }

  assertProjectRegistryRevision(expectedRevision: number): void {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error(
        `${PROJECT_REGISTRY_REVISION_CONFLICT}: Invalid expected project registry revision.`
      );
    }
    if (this.getProjectRegistryRevision() !== expectedRevision) {
      throw new Error(
        `${PROJECT_REGISTRY_REVISION_CONFLICT}: Project settings changed after this card was opened.`
      );
    }
  }

  /** Runtime authority for fresh admission, including legacy cached descriptors. */
  resolveProjectSelection(
    selection: RuntimeProjectSelection,
    allowedRoots: readonly string[]
  ): ProjectTarget {
    return this.transaction(() => {
      let project: ProjectTarget;
      if ("registryRevision" in selection) {
        const registryRevision = this.getProjectRegistryRevision();
        if (
          !Number.isInteger(selection.registryRevision) ||
          selection.registryRevision < 0 ||
          selection.registryRevision !== registryRevision
        ) {
          throw new Error(
            `${PROJECT_REGISTRY_CHANGED}: Project choices changed. Refresh the tool descriptor and retry.`
          );
        }
        const nameKey = projectNameKey(selection.name);
        const rows = this.database
          .prepare(`
            SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
                   created_at, updated_at, archived_at, deleted_at
              FROM projects
             WHERE name_key = ? AND archived_at IS NULL AND deleted_at IS NULL
          `)
          .all(nameKey) as ProjectStorageRow[];
        if (rows.length !== 1) {
          throw new Error(`${PROJECT_NOT_FOUND}: No active project has that exact normalized name.`);
        }
        project = readProjectStorageRow(rows[0] as ProjectStorageRow);
      } else {
        const projectRef = normalizeProjectRef(selection.projectRef);
        const row = this.database
          .prepare(`
            SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
                   created_at, updated_at, archived_at, deleted_at
              FROM projects
             WHERE project_ref = ? AND deleted_at IS NULL
          `)
          .get(projectRef) as ProjectStorageRow | undefined;
        if (!row) {
          throw new Error(`${PROJECT_NOT_FOUND}: Unknown project selection reference.`);
        }
        project = readProjectStorageRow(row);
        if (
          !Number.isInteger(selection.projectRevision) ||
          selection.projectRevision < 1 ||
          selection.projectRevision !== project.projectRevision
        ) {
          throw new Error(
            `${PROJECT_REGISTRY_CHANGED}: The selected project changed. Refresh the tool descriptor and retry.`
          );
        }
        if (normalizeProjectName(selection.name) !== project.name) {
          throw new Error(
            `${PROJECT_REGISTRY_CHANGED}: The selected project name changed. Refresh the tool descriptor and retry.`
          );
        }
        if (project.archivedAt !== undefined) {
          throw new Error(`${PROJECT_NOT_FOUND}: The selected project is archived.`);
        }
      }
      let canonical: string;
      try {
        canonical = canonicalProjectCwd(project.cwd, allowedRoots);
      } catch {
        throw new Error(
          `${PROJECT_UNAVAILABLE}: The selected project folder is unavailable. Check it in Codex settings.`
        );
      }
      if (canonical !== project.cwd) {
        throw new Error(
          `${PROJECT_UNAVAILABLE}: The selected project folder no longer has its admitted canonical identity.`
        );
      }
      return project;
    });
  }

  applyProjectOperations(
    operations: readonly ProjectRegistryOperation[],
    expectedRevision: number,
    allowedRoots: readonly string[],
    now = Date.now()
  ): ProjectRegistrySnapshot {
    if (operations.length > MAX_REGISTERED_PROJECTS * 2) {
      throw new Error(
        `PROJECT_OPERATION_LIMIT: At most ${MAX_REGISTERED_PROJECTS * 2} project operations are allowed per save.`
      );
    }
    return this.transaction(() => {
      this.assertProjectRegistryRevision(expectedRevision);
      const seen = new Map<string, Set<ProjectRegistryOperation["kind"]>>();
      for (const operation of operations) {
        if (operation.kind === "add" || operation.kind === "reorder") continue;
        const projectId = normalizeProjectId(operation.projectId);
        const kinds = seen.get(projectId) || new Set<ProjectRegistryOperation["kind"]>();
        if (
          kinds.has(operation.kind) ||
          kinds.has("archive") ||
          kinds.has("restore") ||
          kinds.has("delete") ||
          operation.kind === "archive" && kinds.size > 0 ||
          operation.kind === "restore" && kinds.size > 0 ||
          operation.kind === "delete" && kinds.size > 0
        ) {
          throw new Error(
            `${PROJECT_OPERATION_CONFLICT}: Conflicting operations target one project.`
          );
        }
        kinds.add(operation.kind);
        seen.set(projectId, kinds);
      }

      let changed = false;
      const changedProjectIds = new Set<string>();
      for (const operation of operations) {
        if (operation.kind === "add") {
          const count = Number((this.database
            .prepare("SELECT COUNT(*) AS count FROM projects WHERE deleted_at IS NULL")
            .get() as CountRow).count);
          if (count >= MAX_REGISTERED_PROJECTS) {
            throw new Error(
              `${PROJECT_LIMIT_EXCEEDED}: At most ${MAX_REGISTERED_PROJECTS} projects may be registered.`
            );
          }
          const name = normalizeProjectName(operation.project.name);
          const nameKey = projectNameKey(name);
          const cwd = canonicalProjectCwd(operation.project.cwd, allowedRoots);
          const projectId = randomUUID();
          const projectRef = createProjectRef();
          this.assertActiveProjectUniqueness(nameKey, cwd);
          this.assertProjectCwdReusable(cwd, projectId);
          const maxSort = this.database
            .prepare("SELECT MAX(sort_order) AS value FROM projects WHERE deleted_at IS NULL")
            .get() as { value: number | null };
          this.database
            .prepare(`
              INSERT INTO projects(
                project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
                created_at, updated_at, archived_at
              ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, NULL)
            `)
            .run(
              projectId,
              projectRef,
              name,
              nameKey,
              cwd,
              (maxSort.value ?? -1) + 1,
              now,
              now
            );
          changed = true;
          continue;
        }

        if (operation.kind === "reorder") {
          const active = this.database
            .prepare("SELECT project_id FROM projects WHERE archived_at IS NULL AND deleted_at IS NULL ORDER BY sort_order, created_at")
            .all() as Array<{ project_id: string }>;
          const requested = operation.projectIds.map(normalizeProjectId);
          if (
            requested.length !== active.length ||
            new Set(requested).size !== requested.length ||
            active.some(({ project_id }) => !requested.includes(project_id))
          ) {
            throw new Error("PROJECT_REORDER_INVALID: Reorder must contain every active project exactly once.");
          }
          requested.forEach((projectId, index) => {
            const current = active.findIndex(({ project_id }) => project_id === projectId);
            if (current !== index) {
              this.database
                .prepare("UPDATE projects SET sort_order = ?, updated_at = ? WHERE project_id = ?")
                .run(index, now, projectId);
              changed = true;
            }
          });
          continue;
        }

        const projectId = normalizeProjectId(operation.projectId);
        const row = this.requireProjectStorageRow(projectId);
        if (operation.kind === "rename") {
          if (row.archived_at !== null) {
            throw new Error(`${PROJECT_ARCHIVED}: Restore an archived project to change its active name.`);
          }
          const name = normalizeProjectName(operation.name);
          const nameKey = projectNameKey(name);
          this.assertActiveProjectUniqueness(nameKey, undefined, projectId);
          if (row.name !== name || row.name_key !== nameKey) {
            this.database
              .prepare("UPDATE projects SET name = ?, name_key = ?, updated_at = ? WHERE project_id = ?")
              .run(name, nameKey, now, projectId);
            changed = true;
            changedProjectIds.add(projectId);
          }
          continue;
        }
        if (operation.kind === "relocate") {
          if (row.archived_at !== null) {
            throw new Error(`${PROJECT_ARCHIVED}: Restore an archived project to relocate it.`);
          }
          const cwd = canonicalProjectCwd(operation.cwd, allowedRoots);
          this.assertActiveProjectUniqueness(undefined, cwd, projectId);
          this.assertProjectCwdReusable(cwd, projectId);
          if (row.cwd !== cwd) {
            this.database
              .prepare("UPDATE projects SET cwd = ?, updated_at = ? WHERE project_id = ?")
              .run(cwd, now, projectId);
            changed = true;
            changedProjectIds.add(projectId);
          }
          continue;
        }
        if (operation.kind === "archive") {
          if (row.archived_at === null) {
            this.database
              .prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE project_id = ?")
              .run(now, now, projectId);
            changed = true;
            changedProjectIds.add(projectId);
          }
          continue;
        }
        if (operation.kind === "delete") {
          if (row.archived_at === null) {
            throw new Error(
              `${PROJECT_DELETE_REQUIRES_ARCHIVE}: Archive the project before deleting its registration.`
            );
          }
          this.database
            .prepare("UPDATE projects SET deleted_at = ?, updated_at = ? WHERE project_id = ?")
            .run(now, now, projectId);
          changed = true;
          changedProjectIds.add(projectId);
          continue;
        }

        if (row.archived_at === null) {
          if (operation.name !== undefined || operation.cwd !== undefined) {
            throw new Error(`${PROJECT_OPERATION_CONFLICT}: The project is already active.`);
          }
          continue;
        }
        const name = normalizeProjectName(operation.name ?? row.name);
        const nameKey = projectNameKey(name);
        const cwd = canonicalProjectCwd(operation.cwd ?? row.cwd, allowedRoots);
        this.assertActiveProjectUniqueness(nameKey, cwd, projectId);
        this.assertProjectCwdReusable(cwd, projectId);
        this.database
          .prepare(`
            UPDATE projects
               SET name = ?, name_key = ?, cwd = ?, archived_at = NULL, updated_at = ?
             WHERE project_id = ?
          `)
          .run(name, nameKey, cwd, now, projectId);
        changed = true;
        changedProjectIds.add(projectId);
      }

      if (changed) {
        const bumpProjectRevision = this.database.prepare(`
          UPDATE projects
             SET project_revision = project_revision + 1
           WHERE project_id = ?
        `);
        for (const projectId of changedProjectIds) bumpProjectRevision.run(projectId);
        this.database
          .prepare(`
            UPDATE project_registry
               SET registry_revision = registry_revision + 1, updated_at = ?
             WHERE singleton = 1
          `)
          .run(now);
      }
      return this.getProjectRegistrySnapshot();
    });
  }

  private requireProjectStorageRow(projectId: string): ProjectStorageRow {
    const row = this.database
      .prepare(`
        SELECT project_id, project_ref, project_revision, name, name_key, cwd, sort_order,
               created_at, updated_at, archived_at, deleted_at
          FROM projects WHERE project_id = ? AND deleted_at IS NULL
      `)
      .get(projectId) as ProjectStorageRow | undefined;
    if (!row) throw new Error(`${PROJECT_NOT_FOUND}: Unknown project.`);
    return row;
  }

  private assertActiveProjectUniqueness(
    nameKey: string | undefined,
    cwd: string | undefined,
    excludingProjectId?: string
  ): void {
    if (nameKey !== undefined) {
      const conflict = this.database
        .prepare(`
          SELECT 1 FROM projects
           WHERE name_key = ? AND archived_at IS NULL AND deleted_at IS NULL
             AND (? IS NULL OR project_id <> ?)
           LIMIT 1
        `)
        .get(nameKey, excludingProjectId || null, excludingProjectId || null);
      if (conflict) {
        throw new Error(`${PROJECT_NAME_CONFLICT}: An active project already has that name.`);
      }
    }
    if (cwd !== undefined) {
      const conflict = this.database
        .prepare(`
          SELECT 1 FROM projects
           WHERE cwd = ? AND archived_at IS NULL AND deleted_at IS NULL
             AND (? IS NULL OR project_id <> ?)
           LIMIT 1
        `)
        .get(cwd, excludingProjectId || null, excludingProjectId || null);
      if (conflict) {
        throw new Error(`${PROJECT_CWD_CONFLICT}: An active project already uses that folder.`);
      }
    }
  }

  private assertProjectCwdReusable(cwd: string, projectId: string): void {
    const pinned = this.database.prepare(`
      SELECT 1 FROM activities
       WHERE pinned_cwd = ? AND project_id IS NOT ?
         AND lifecycle IN ('open','sealed','terminating')
      UNION ALL
      SELECT 1 FROM agent_threads t JOIN sessions s ON s.thread_id=t.thread_id
        JOIN agents a ON a.agent_id = t.agent_id
       WHERE s.cwd = ? AND s.project_id IS NOT ? AND t.is_current = 1
         AND a.lifecycle <> 'orphaned'
      UNION ALL
      SELECT 1 FROM jobs j JOIN activities a ON a.activity_id=j.activity_id
       WHERE j.cwd = ? AND a.project_id IS NOT ? AND j.archived_at IS NULL
         AND j.status IN ('running','terminating','termination-failed')
      LIMIT 1
    `).get(cwd, projectId, cwd, projectId, cwd, projectId);
    if (pinned) {
      throw new Error(
        `${PROJECT_CWD_STILL_PINNED}: Another project's resumable context still owns that folder.`
      );
    }
  }

  private requireSteeringDelivery(
    scopeId: string,
    requestId: string,
    actionHash: string
  ): SteeringDeliveryRecord {
    const normalizedScopeId = normalizeUuid(scopeId, "steering scopeId");
    const normalizedRequestId = normalizeUuid(requestId, "steering requestId");
    const normalizedActionHash = normalizeDigest(actionHash, "steering actionHash");
    const delivery = this.getSteeringDelivery(normalizedScopeId, normalizedRequestId);
    if (!delivery) throw new Error("Unknown steering delivery request.");
    if (delivery.actionHash !== normalizedActionHash) {
      throw new Error(
        "STEERING_REQUEST_CONFLICT: requestId was already used for a different steering payload in this scope."
      );
    }
    return delivery;
  }

  /** Internal composition only: keys stay in the single runtime owner. No
   * state-service/IPC command exposes this method or serializes key material.
   * Empty upstream state retains its original generation-one meta encoding;
   * any versioned/partial CoGate state must validate the paired keyrings. */
  activeSecurityHmacKey(purpose: SecurityHmacPurpose, createIfMissing = false): {
    generation: number; secret: Buffer
  } {
    if (purpose !== SCOPE_HMAC_PURPOSE && purpose !== EXECUTION_POLICY_HMAC_PURPOSE) {
      throw new Error("Invalid runtime HMAC purpose.");
    }
    const readOrCreate = () => {
      this.#assertHmacStateSchema();
      if (this.#hasVersionedSecurityHmacState()) {
        const key = loadSecurityHmacKeyring(this.database, purpose).active;
        return { generation: key.generation, secret: Buffer.from(key.secret) };
      }
      // No table/marker may silently downgrade an incomplete conversion to a
      // newly generated legacy secret. This also preserves the activation gate.
      assertCoGateUnifiedRuntimeAdmission(this.database);
      const name = purpose === SCOPE_HMAC_PURPOSE ? "scope_hmac_secret_v1" : "execution_policy_hmac_secret_v1";
      const encoded = this.#securityMeta(name);
      if (encoded !== undefined) {
        const secret = Buffer.from(encoded, "base64url");
        if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
          throw new Error(`Invalid persisted ${purpose === SCOPE_HMAC_PURPOSE ? "conversation-scope" : purpose} HMAC key.`);
        }
        return { generation: 1, secret };
      }
      if (createIfMissing !== true || this.readOnly) throw new Error(`Runtime requires an existing ${purpose} HMAC key.`);
      const secret = randomBytes(32);
      this.setMeta(name, secret.toString("base64url"));
      return { generation: 1, secret: Buffer.from(secret) };
    };
    return createIfMissing === true && !this.readOnly
      ? this.transaction(readOrCreate) : this.#withSecurityReadSnapshot(readOrCreate);
  }

  /** Correlation routing only, using the owner's current snapshot. No scope,
   * alias, membership, Job, writer or dispatch authority is created here. */
  conversationScopeRouting(identity: CoGateScopeIdentity): CoGateScopeRoutingInspection | undefined {
    return this.#withSecurityReadSnapshot(() => {
      this.#assertHmacStateSchema();
      if (!this.#hasVersionedSecurityHmacState()) {
        assertCoGateUnifiedRuntimeAdmission(this.database);
        return undefined;
      }
      return readCoGateScopeRoutingSnapshot(this.database, identity, 31);
    });
  }

  /** Existing aliases are correlation lookups, never membership or admission. */
  canonicalConversationScopeId(scopeId: string): string {
    if (typeof scopeId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scopeId)) {
      throw new Error("Invalid conversation scope id.");
    }
    return this.#withSecurityReadSnapshot(() => {
      this.#assertHmacStateSchema();
      if (!this.#hasVersionedSecurityHmacState()) {
        assertCoGateUnifiedRuntimeAdmission(this.database);
        return scopeId;
      }
      const ring = loadSecurityHmacKeyring(this.database, SCOPE_HMAC_PURPOSE);
      const canonical = this.database.prepare("SELECT scope_id FROM main.scopes WHERE scope_id=?").get(scopeId);
      const alias = this.database.prepare(`SELECT canonical_scope_id,key_generation,rotation_id
        FROM main.scope_aliases WHERE alias_scope_id=?`).get(scopeId) as {
          canonical_scope_id: string; key_generation: number; rotation_id: string
        } | undefined;
      if (canonical && alias) throw new Error("SECURITY_SCOPE_ALIAS_COLLISION");
      if (!alias) return scopeId;
      const key = [ring.active, ...ring.retired].find(key => key.generation === alias.key_generation);
      if (!key || key.rotationId !== alias.rotation_id) throw new Error("SECURITY_SCOPE_ALIAS_PROVENANCE_CONFLICT");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(alias.canonical_scope_id) ||
        !this.database.prepare("SELECT 1 FROM main.scopes WHERE scope_id=?").get(alias.canonical_scope_id)) {
        throw new Error("SECURITY_SCOPE_LOOKUP_CANONICAL_MISSING");
      }
      return alias.canonical_scope_id;
    });
  }

  #securityMeta(key: string): string | undefined {
    return (this.database.prepare("SELECT value FROM main.bridge_meta WHERE key=?").get(key) as
      { value: string } | undefined)?.value;
  }

  #hasVersionedSecurityHmacState(): boolean {
    return this.#securityMeta(SECURITY_ROTATION_REQUIRED_META_KEY) !== undefined ||
      Boolean(this.database.prepare("SELECT 1 FROM main.security_hmac_keys LIMIT 1").get());
  }

  #assertHmacStateSchema(): void {
    if (this.database.prepare("SELECT 1 FROM temp.sqlite_master LIMIT 1").get()) {
      throw new Error("Runtime HMAC state rejects TEMP objects.");
    }
    const objects = this.database.prepare(`SELECT type,name,tbl_name AS tableName,sql
      FROM main.sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7) != 'sqlite_'
      ORDER BY type,name`).all();
    if (this.#securityMeta("schema_version") !== "31" ||
      createHash("sha256").update(JSON.stringify(objects)).digest("hex") !==
      "2ced184f0b7de991be944c28fdf5219f16863ae69d645e7092b75aadd377e79a") {
      throw new Error("Runtime HMAC state requires the fixed unified31 schema.");
    }
  }

  #withSecurityReadSnapshot<T>(read: () => T): T {
    if (this.database.inTransaction) return read();
    this.database.exec("BEGIN");
    try { return read(); }
    finally { if (this.database.inTransaction) this.database.exec("ROLLBACK"); }
  }

  getMeta(key: string): string | undefined {
    const row = this.database
      .prepare("SELECT value FROM bridge_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.database
      .prepare(`
        INSERT INTO bridge_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  /** Narrow UoW storage for bounded protocol metadata journals. */
  listMeta(prefix: string, limit: number, afterKey?: string): Array<{ key: string; value: string }> {
    return this.database.prepare("SELECT key,value FROM bridge_meta WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?")
      .all(prefix, prefix + "\uffff", afterKey || "", limit) as Array<{ key: string; value: string }>;
  }

  deleteMeta(key: string): void { this.database.prepare("DELETE FROM bridge_meta WHERE key=?").run(key); }

  get mcpEvents(): McpEventStore { return new McpEventStore(this); }
  get taskFollowups(): TaskFollowupStore { return new TaskFollowupStore(this); }
  get readOnly(): boolean { return this.options.readOnly === true; }

  isEventProjectAvailable(projectId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM projects WHERE project_id=? AND archived_at IS NULL").get(projectId));
  }

  /** Revalidate the predecessor at the same atomic followup admission boundary. */
  followupParent(jobId: string, scopeId: string, version: number): {
    threadId: string | null; sandbox: string; selection: Record<string, unknown> | null
  } | undefined {
    const row = this.database.prepare(`SELECT j.thread_id AS threadId,j.sandbox,
      json_extract(j.payload,'$.executionDecision.effectiveSelection') AS selection
      FROM jobs j JOIN job_completion_deliveries d ON d.job_id=j.job_id
      WHERE j.job_id=? AND j.scope_id=? AND j.job_version=? AND j.status='completed'
        AND j.archived_at IS NULL AND (d.direct_result_offered_at IS NOT NULL OR d.completion_result_offered_at IS NOT NULL)`)
      .get(jobId, scopeId, version) as { threadId: string | null; sandbox: string; selection: string | null } | undefined;
    return row ? { ...row, selection: row.selection ? JSON.parse(row.selection) : null } : undefined;
  }

  pinNonforcingShutdown(): true {return this.databaseShutdown.pinNonforcingShutdown();}

  observeNonforcingExit(): ShutdownResult {return this.databaseShutdown.observeNonforcingExit();}

  /** Resource-only close: preserve the bridge instance and retirement evidence. */
  closeNonforcing(): ShutdownResult {
    const result = this.databaseShutdown.closeNonforcing();
    if (result.exited) this.closed = true;
    return result;
  }

  close(): void {
    if (this.closed) return;
    if (this.options.readOnly) {
      this.database.close();
      this.closed = true;
      return;
    }
    const now = Date.now();
    this.database
      .prepare(`
        UPDATE bridge_instances
           SET stopped_at = ?, termination_reason = 'clean-shutdown'
         WHERE instance_id = ? AND stopped_at IS NULL
      `)
      .run(now, this.currentInstanceId);
    this.database.close();
    this.closed = true;
  }

  private migrationBackupPath(sourceVersion: string): string {
    return `${this.migrationLease?.databaseFile ?? this.options.file}.pre-v${sourceVersion}-to-v${CURRENT_SCHEMA_VERSION}.sqlite`;
  }

  private prepareV19Migration(currentVersion: string): void {
    const recordedSource = this.getMeta("schema_v19_upgrade_source");
    if (
      recordedSource !== undefined &&
      (!SUPPORTED_STATE_SCHEMA_VERSIONS.has(Number(recordedSource)) || recordedSource === CURRENT_SCHEMA_VERSION)
    ) {
      throw new Error(`Invalid schema v19 migration source marker: ${recordedSource}.`);
    }

    let databaseId = this.getMeta("state_database_id");
    if (recordedSource !== undefined && databaseId === undefined) {
      throw new Error(
        "Schema v19 migration cannot resume because the source database identity marker is missing."
      );
    }
    if (databaseId === undefined) {
      databaseId = randomUUID();
      this.transaction(() => this.setMeta("state_database_id", databaseId as string));
    }

    if (this.persistent) {
      if (recordedSource === undefined) {
        this.createMigrationBackup(currentVersion, databaseId);
      } else {
        this.requireMigrationBackup(recordedSource, databaseId);
        if (
          currentVersion !== recordedSource &&
          this.getMeta("state_last_migration_id") === undefined &&
          this.getMeta("state_migration_pending") === undefined &&
          this.getMeta("state_migration_provenance_gap") === undefined
        ) {
          this.transaction(() => this.setMeta(
            "state_migration_provenance_gap",
            JSON.stringify({
              kind: "pre-contract-intermediate-checkpoint",
              originalSourceSchema: Number(recordedSource),
              observedSchema: Number(currentVersion),
              recordedAt: new Date().toISOString()
            })
          ));
        }
      }
    }
    if (recordedSource === undefined) {
      this.transaction(() => this.setMeta("schema_v19_upgrade_source", currentVersion));
    }
  }

  private createMigrationBackup(sourceVersion: string, databaseId: string): void {
    this.migrationLease?.reportBackup();
    const backup = this.migrationBackupPath(sourceVersion);
    // One compact recovery point is enough for a retryable transition. Reusing
    // it after the source marker is recorded prevents failed starts from
    // accumulating full database copies. Before the marker exists, replace any
    // stale file left by an older database that previously occupied this path.
    rmSync(backup, { force: true });
    rmSync(
      migrationBackupMetadataPath(
        this.migrationLease?.databaseFile ?? this.options.file,
        Number(sourceVersion),
        Number(CURRENT_SCHEMA_VERSION)
      ),
      { force: true }
    );
    this.database.prepare("VACUUM INTO ?").run(backup);
    chmodSync(backup, 0o600);
    createMigrationBackupMetadata({
      databaseFile: this.migrationLease?.databaseFile ?? this.options.file,
      backupFile: backup,
      databaseId,
      sourceSchema: Number(sourceVersion),
      targetSchema: Number(CURRENT_SCHEMA_VERSION)
    });
    this.requireMigrationBackup(sourceVersion, databaseId);
  }

  private requireMigrationBackup(sourceVersion: string, databaseId: string): void {
    const backup = this.migrationBackupPath(sourceVersion);
    if (!existsSync(backup)) {
      throw new Error(
        `Schema v19 migration cannot resume because its original v${sourceVersion} recovery backup is missing.`
      );
    }
    chmodSync(backup, 0o600);
    requireMigrationBackupMetadata({
      databaseFile: this.migrationLease?.databaseFile ?? this.options.file,
      backupFile: backup,
      databaseId,
      sourceSchema: Number(sourceVersion),
      targetSchema: Number(CURRENT_SCHEMA_VERSION)
    });
  }

  private migrateSupportedSchema(): void {
    this.reconcilePendingMigration();
    const originalSourceSchema = Number(
      this.getMeta("schema_v19_upgrade_source") || this.getMeta("schema_version")
    );
    this.runMigration("3", "4", originalSourceSchema, () => this.migrateV3ToV4());
    this.runMigration("4", "5", originalSourceSchema, () => this.migrateV4ToV5());
    this.runMigration("5", "6", originalSourceSchema, () => this.migrateV5ToV6());
    this.runMigration("6", "7", originalSourceSchema, () => this.migrateV6ToV7());
    this.runMigration("7", "8", originalSourceSchema, () => this.migrateV7ToV8());
    this.runMigration("8", "9", originalSourceSchema, () => this.migrateV8ToV9());
    this.runMigration("9", "10", originalSourceSchema, () => this.migrateV9ToV10());
    this.runMigration("10", "11", originalSourceSchema, () => this.migrateV10ToV11());
    this.runMigration("11", "12", originalSourceSchema, () => this.migrateV11ToV12());
    this.runMigration("12", "13", originalSourceSchema, () => this.migrateV12ToV13());
    this.runMigration("13", "14", originalSourceSchema, () => this.migrateV13ToV14());
    this.runMigration("14", "15", originalSourceSchema, () => this.migrateV14ToV15());
    if (["15", "16"].includes(this.getMeta("schema_version") || "")) {
      const source = this.getMeta("schema_version") as "15" | "16";
      this.runMigration(source, "17", originalSourceSchema, () => this.migrateV15OrV16ToV17());
    }
    this.runMigration("17", "18", originalSourceSchema, () => this.migrateV17ToV18());
    this.runMigration("18", "19", originalSourceSchema, () => this.migrateV18ToV19());
    this.runMigration("19", "20", originalSourceSchema, () => this.migrateV19ToV20());
    this.runMigration("20", "21", originalSourceSchema, () => this.migrateV20ToV21());
    this.runMigration("21", "22", originalSourceSchema, () => this.migrateV21ToV22());
    this.runMigration("22", "23", originalSourceSchema, () => this.migrateV22ToV23());
    this.runMigration("23", "24", originalSourceSchema, () => this.migrateV23ToV24());
    this.runMigration("24", "25", originalSourceSchema, () => this.migrateV24ToV25());
    this.runMigration("25", "26", originalSourceSchema, () => this.migrateV25ToV26());
    this.runMigration("26", "27", originalSourceSchema, () => this.migrateV26ToV27());
    this.runMigration("27", "28", originalSourceSchema, () => this.migrateV27ToV28());
    this.runMigration("28", "29", originalSourceSchema, () => this.migrateV28ToV29());
    this.runMigration("29", "30", originalSourceSchema, () => this.migrateV29ToV30());
    this.runMigration("30", "31", originalSourceSchema, () => this.migrateV30ToV31());
    if (this.getMeta("schema_version") !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`Bridge state migration stopped at unsupported schema version ${this.getMeta("schema_version")}.`);
    }
  }

  private runMigration(
    sourceSchema: string,
    targetSchema: string,
    originalSourceSchema: number,
    migrate: () => void
  ): void {
    if (this.getMeta("schema_version") !== sourceSchema) return;
    const entry = stateMigration(Number(sourceSchema), Number(targetSchema));
    const progress = {
      migrationId: entry.id,
      sourceSchema: Number(sourceSchema),
      targetSchema: Number(targetSchema),
      originalSourceSchema
    };
    this.recordPendingMigration(entry, originalSourceSchema);
    this.migrationLease?.reportMigration(entry);
    migrate();
    this.options.onMigrationSchemaCommitted?.(progress);
    this.finalizeMigrationProvenance(entry, originalSourceSchema);
    this.migrationLease?.reportCheckpoint(entry);
    this.options.onMigrationProgress?.(progress);
  }

  private recordPendingMigration(
    entry: StateMigrationCatalogEntry,
    originalSourceSchema: number
  ): void {
    const pending = {
      id: entry.id,
      fromSchema: entry.fromSchema,
      toSchema: entry.toSchema,
      implementationSha256: entry.sha256,
      originalSourceSchema,
      productVersion: PRODUCT_INFO.version,
      buildId: BRIDGE_BUILD_INFO.id,
      startedAt: new Date().toISOString()
    };
    this.transaction(() => {
      const existing = this.getMeta("state_migration_pending");
      if (existing !== undefined) {
        const parsed = legacyJsonRecord(existing);
        if (
          parsed?.id !== entry.id ||
          parsed?.fromSchema !== entry.fromSchema ||
          parsed?.toSchema !== entry.toSchema ||
          parsed?.implementationSha256 !== entry.sha256 ||
          parsed?.originalSourceSchema !== originalSourceSchema
        ) {
          throw new Error(`Pending state migration provenance conflicts with ${entry.id}.`);
        }
      } else {
        this.setMeta("state_migration_pending", JSON.stringify(pending));
      }
    });
  }

  private finalizeMigrationProvenance(
    entry: StateMigrationCatalogEntry,
    originalSourceSchema: number
  ): void {
    const pending = legacyJsonRecord(this.getMeta("state_migration_pending"));
    if (
      pending?.id !== entry.id ||
      pending.fromSchema !== entry.fromSchema ||
      pending.toSchema !== entry.toSchema ||
      pending.implementationSha256 !== entry.sha256 ||
      pending.originalSourceSchema !== originalSourceSchema ||
      typeof pending.productVersion !== "string" ||
      typeof pending.buildId !== "string" ||
      typeof pending.startedAt !== "string" ||
      !Number.isFinite(Date.parse(pending.startedAt))
    ) {
      throw new Error(`State migration checkpoint ${entry.id} has no matching pending provenance.`);
    }
    const appliedAt = new Date().toISOString();
    const applied = {
      id: entry.id,
      fromSchema: entry.fromSchema,
      toSchema: entry.toSchema,
      implementationSha256: entry.sha256,
      originalSourceSchema,
      productVersion: String(pending.productVersion),
      buildId: String(pending.buildId),
      appliedAt
    };
    this.transaction(() => {
      const key = `state_migration:${entry.id}`;
      const existing = this.getMeta(key);
      if (existing !== undefined) {
        this.assertMigrationProvenanceRecord(existing, entry, originalSourceSchema);
      } else {
        this.setMeta(key, JSON.stringify(applied));
      }
      this.setMeta("state_migration_catalog_version", String(STATE_MIGRATION_CATALOG_VERSION));
      this.setMeta("state_last_migration_id", entry.id);
      if (entry.toSchema === Number(CURRENT_SCHEMA_VERSION)) {
        this.setMeta("state_last_migration_source_schema", String(originalSourceSchema));
        this.setMeta("state_last_migration_target_schema", String(entry.toSchema));
        this.setMeta("state_last_migration_completed_at", appliedAt);
        this.setMeta("state_service_opened_after_migration", "0");
        this.database.prepare(`DELETE FROM bridge_meta WHERE key IN (
          'schema_v19_upgrade_source','state_service_opened_at',
          'state_service_opened_transport','state_service_opened_migration_id'
        )`).run();
      }
      this.database.prepare("DELETE FROM bridge_meta WHERE key='state_migration_pending'").run();
    });
  }

  private reconcilePendingMigration(): void {
    const raw = this.getMeta("state_migration_pending");
    if (raw === undefined) return;
    const pending = legacyJsonRecord(raw);
    const fromSchema = Number(pending?.fromSchema);
    const toSchema = Number(pending?.toSchema);
    const originalSourceSchema = Number(pending?.originalSourceSchema);
    const entry = Number.isSafeInteger(fromSchema) && Number.isSafeInteger(toSchema)
      ? stateMigration(fromSchema, toSchema)
      : null;
    if (
      !entry ||
      pending?.id !== entry.id ||
      pending.implementationSha256 !== entry.sha256 ||
      !SUPPORTED_STATE_SCHEMA_VERSIONS.has(originalSourceSchema)
    ) {
      throw new Error("Pending state migration provenance is invalid or references changed code.");
    }
    const currentSchema = Number(this.getMeta("schema_version"));
    if (currentSchema === fromSchema) return;
    if (currentSchema !== toSchema) {
      throw new Error(
        `Pending state migration ${entry.id} stopped at unexpected schema ${currentSchema}.`
      );
    }
    if (toSchema === Number(CURRENT_SCHEMA_VERSION) && this.persistent) {
      const databaseId = this.getMeta("state_database_id");
      if (!databaseId) {
        throw new Error("Completed state migration checkpoint has no logical database identity.");
      }
      this.requireMigrationBackup(String(originalSourceSchema), databaseId);
    }
    this.finalizeMigrationProvenance(entry, originalSourceSchema);
  }

  private validateStateMigrationProvenance(): void {
    const lastMigrationId = this.getMeta("state_last_migration_id");
    if (lastMigrationId === undefined) return;
    const originalSourceSchema = Number(
      this.getMeta("state_last_migration_source_schema") ||
      this.getMeta("schema_v19_upgrade_source")
    );
    if (!SUPPORTED_STATE_SCHEMA_VERSIONS.has(originalSourceSchema)) {
      throw new Error("State migration provenance has no supported original source schema.");
    }
    const currentSchema = Number(this.getMeta("schema_version"));
    const completePath = stateMigrationPath(originalSourceSchema);
    let pathStart = 0;
    const gapRaw = this.getMeta("state_migration_provenance_gap");
    if (gapRaw !== undefined) {
      const gap = legacyJsonRecord(gapRaw);
      const observedSchema = Number(gap?.observedSchema);
      const gapIndex = completePath.findIndex((entry) => entry.toSchema === observedSchema);
      if (
        gap?.kind !== "pre-contract-intermediate-checkpoint" ||
        gap?.originalSourceSchema !== originalSourceSchema ||
        gapIndex < 0 ||
        typeof gap.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(gap.recordedAt))
      ) {
        throw new Error("State migration provenance gap marker is invalid.");
      }
      pathStart = gapIndex + 1;
    }
    const expected: StateMigrationCatalogEntry[] = [];
    for (const entry of completePath.slice(pathStart)) {
      if (entry.toSchema > currentSchema) break;
      expected.push(entry);
      if (entry.toSchema === currentSchema) break;
    }
    if (expected.at(-1)?.toSchema !== currentSchema) {
      throw new Error(`State migration provenance cannot reach schema ${currentSchema}.`);
    }
    for (const entry of expected) {
      const raw = this.getMeta(`state_migration:${entry.id}`);
      if (raw === undefined) {
        throw new Error(`State migration provenance is missing ${entry.id}.`);
      }
      this.assertMigrationProvenanceRecord(raw, entry, originalSourceSchema);
    }
    if (lastMigrationId !== expected.at(-1)?.id) {
      throw new Error("State last-migration identity does not match its applied path.");
    }
  }

  private assertMigrationProvenanceRecord(
    raw: string,
    entry: StateMigrationCatalogEntry,
    originalSourceSchema: number
  ): void {
    const parsed = legacyJsonRecord(raw);
    if (
      parsed?.id !== entry.id ||
      parsed.fromSchema !== entry.fromSchema ||
      parsed.toSchema !== entry.toSchema ||
      parsed.implementationSha256 !== entry.sha256 ||
      parsed.originalSourceSchema !== originalSourceSchema ||
      typeof parsed.productVersion !== "string" ||
      typeof parsed.buildId !== "string" ||
      typeof parsed.appliedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.appliedAt))
    ) {
      throw new Error(`State migration provenance conflicts with ${entry.id}.`);
    }
  }

  private recordSchemaOrigin(kind: "fresh" | "pre-contract-current"): void {
    this.setMeta("state_schema_origin", JSON.stringify({
      kind,
      schema: Number(CURRENT_SCHEMA_VERSION),
      productVersion: PRODUCT_INFO.version,
      buildId: BRIDGE_BUILD_INFO.id,
      recordedAt: new Date().toISOString()
    }));
  }

  private migrateV3ToV4(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE agents (
            agent_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            agent_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            lifecycle TEXT NOT NULL CHECK(lifecycle IN ('idle','active','waiting-input','archived','orphaned')),
            current_thread_id TEXT,
            current_job_id TEXT,
            version INTEGER NOT NULL CHECK(version >= 1),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER,
            orphaned_reason TEXT,
            UNIQUE(scope_id, normalized_name)
          ) STRICT;
          CREATE INDEX agents_scope_state_recent
            ON agents(scope_id, lifecycle, updated_at DESC);

          CREATE TABLE agent_threads (
            thread_id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            backend_kind TEXT NOT NULL,
            cwd TEXT NOT NULL,
            sandbox TEXT NOT NULL,
            context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','fork','fresh')),
            is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
            linked_at INTEGER NOT NULL,
            replaced_at INTEGER,
            forked_from_thread_id TEXT
          ) STRICT;
          CREATE INDEX agent_threads_agent_history
            ON agent_threads(agent_id, linked_at ASC);
          CREATE UNIQUE INDEX agent_threads_one_current
            ON agent_threads(agent_id) WHERE is_current = 1;

          CREATE TABLE activity_agents (
            assignment_id TEXT PRIMARY KEY,
            activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
            agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
            role TEXT NOT NULL,
            context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','fork','fresh')),
            assigned_at INTEGER NOT NULL,
            released_at INTEGER
          ) STRICT;
          CREATE INDEX activity_agents_activity_history
            ON activity_agents(activity_id, assigned_at ASC);
          CREATE INDEX activity_agents_agent_history
            ON activity_agents(agent_id, assigned_at ASC);
          CREATE UNIQUE INDEX activity_agents_active_pair
            ON activity_agents(activity_id, agent_id) WHERE released_at IS NULL;

          CREATE TABLE agent_mutations (
            scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
            request_id TEXT NOT NULL,
            action_hash TEXT NOT NULL,
            result TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY(scope_id, request_id)
          ) STRICT;

          ALTER TABLE activities ADD COLUMN continuation_of_activity_id TEXT REFERENCES activities(activity_id);
          ALTER TABLE activities ADD COLUMN card_generation INTEGER NOT NULL DEFAULT 1 CHECK(card_generation >= 1);
          CREATE INDEX activities_continuation
            ON activities(continuation_of_activity_id, created_at ASC);

          ALTER TABLE jobs ADD COLUMN agent_id TEXT REFERENCES agents(agent_id);
          ALTER TABLE jobs ADD COLUMN context_mode TEXT CHECK(context_mode IN ('continue','fork','fresh'));
          CREATE INDEX jobs_agent_recent ON jobs(agent_id, updated_at DESC);
        `);

        const jobRows = this.database
          .prepare(`
            SELECT job_id, scope_id, activity_id, thread_id, backend_kind, status,
                   updated_at, payload
              FROM jobs ORDER BY updated_at ASC, job_id ASC
          `)
          .all() as Array<{
            job_id: string;
            scope_id: string;
            activity_id: string;
            thread_id: string | null;
            backend_kind: string;
            status: string;
            updated_at: number;
            payload: string;
          }>;
        const sessionRows = this.database
          .prepare("SELECT thread_id, scope_id, cwd, last_used_at, payload FROM sessions ORDER BY last_used_at ASC")
          .all() as Array<{
            thread_id: string;
            scope_id: string;
            cwd: string;
            last_used_at: number;
            payload: string;
          }>;
        const sessionsByThread = new Map(sessionRows.map((row) => [row.thread_id, row]));
        const agentByLegacyKey = new Map<string, string>();
        const nameCounters = new Map<string, number>();
        const ensureLegacyAgent = (
          scopeId: string,
          legacyKey: string,
          threadId: string | undefined,
          job: (typeof jobRows)[number] | undefined,
          session: (typeof sessionRows)[number] | undefined
        ): string => {
          const mapKey = `${scopeId}\0${legacyKey}`;
          const existing = agentByLegacyKey.get(mapKey);
          if (existing) return existing;
          const agentId = stableUuid("bridge-agent-v4", scopeId, legacyKey);
          const index = (nameCounters.get(scopeId) || 0) + 1;
          nameCounters.set(scopeId, index);
          const agentName = `Legacy Codex Agent ${index}`;
          const normalizedName = normalizeAgentName(agentName).normalizedName;
          const activeJob = threadId
            ? [...jobRows].reverse().find(
                (candidate) =>
                  candidate.scope_id === scopeId &&
                  candidate.thread_id === threadId &&
                  isActiveActivityJobStatus(candidate.status)
              )
            : job && isActiveActivityJobStatus(job.status)
              ? job
              : undefined;
          const createdAt = Math.min(
            job?.updated_at ?? Number.MAX_SAFE_INTEGER,
            session?.last_used_at ?? Number.MAX_SAFE_INTEGER
          );
          const updatedAt = Math.max(job?.updated_at || 0, session?.last_used_at || 0, Date.now());
          this.database
            .prepare(`
              INSERT INTO agents(
                agent_id, scope_id, agent_name, normalized_name, lifecycle,
                current_thread_id, current_job_id, version, created_at, updated_at,
                archived_at, orphaned_reason
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL)
            `)
            .run(
              agentId,
              scopeId,
              agentName,
              normalizedName,
              activeJob ? "active" : "idle",
              threadId || null,
              activeJob?.job_id || null,
              Number.isFinite(createdAt) ? createdAt : updatedAt,
              updatedAt
            );
          if (threadId) {
            const jobPayload = job
              ? parsePayload({ payload: job.payload }, "legacy job") as Record<string, unknown>
              : undefined;
            const sessionPayload = session
              ? parsePayload({ payload: session.payload }, "legacy session") as Record<string, unknown>
              : undefined;
            const cwd = normalizeOptionalString(session?.cwd) ||
              normalizeOptionalString(jobPayload?.cwd) ||
              normalizeOptionalString(sessionPayload?.cwd) ||
              ".";
            const sandbox = normalizeOptionalString(jobPayload?.sandbox) ||
              normalizeOptionalString(sessionPayload?.sandbox) ||
              "read-only";
            const backendKind = job?.backend_kind ||
              normalizeOptionalString(sessionPayload?.backendKind) ||
              "mcp-server";
            this.database
              .prepare(`
                INSERT INTO agent_threads(
                  thread_id, agent_id, scope_id, backend_kind, cwd, sandbox, context_mode,
                  is_current, linked_at, replaced_at, forked_from_thread_id
                ) VALUES (?, ?, ?, ?, ?, ?, 'continue', 1, ?, NULL, NULL)
              `)
              .run(
                threadId,
                agentId,
                scopeId,
                backendKind,
                cwd,
                sandbox,
                session?.last_used_at || job?.updated_at || updatedAt
              );
          }
          agentByLegacyKey.set(mapKey, agentId);
          return agentId;
        };

        for (const job of jobRows) {
          const session = job.thread_id ? sessionsByThread.get(job.thread_id) : undefined;
          const agentId = ensureLegacyAgent(
            job.scope_id,
            job.thread_id ? `thread:${job.thread_id}` : `job:${job.job_id}`,
            job.thread_id || undefined,
            job,
            session
          );
          this.database
            .prepare("UPDATE jobs SET agent_id = ?, context_mode = 'continue' WHERE job_id = ?")
            .run(agentId, job.job_id);
          const activity = this.database
            .prepare("SELECT lifecycle, created_at, updated_at FROM activities WHERE activity_id = ?")
            .get(job.activity_id) as { lifecycle: string; created_at: number; updated_at: number };
          const assignmentId = stableUuid("activity-agent-v4", job.activity_id, agentId);
          this.database
            .prepare(`
              INSERT OR IGNORE INTO activity_agents(
                assignment_id, activity_id, agent_id, role, context_mode, assigned_at, released_at
              ) VALUES (?, ?, ?, 'legacy', 'continue', ?, ?)
            `)
            .run(
              assignmentId,
              job.activity_id,
              agentId,
              activity.created_at,
              isTerminalActivityJobStatus(job.status) ||
                activity.lifecycle === "completed" ||
                activity.lifecycle === "cancelled" ||
                activity.lifecycle === "abandoned"
                ? Math.max(job.updated_at, activity.updated_at)
                : null
            );
        }
        for (const session of sessionRows) {
          if (agentByLegacyKey.has(`${session.scope_id}\0thread:${session.thread_id}`)) continue;
          ensureLegacyAgent(
            session.scope_id,
            `thread:${session.thread_id}`,
            session.thread_id,
            undefined,
            session
          );
        }

        const now = Date.now();
        this.setMeta("schema_version", "4");
        this.setMeta("schema_v4_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    const violations = this.database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Bridge state schema v4 migration produced foreign-key violations.");
    }
  }

  private migrateV4ToV5(): void {
    this.transaction(() => {
      this.database.exec(`
        ALTER TABLE sessions ADD COLUMN project_id TEXT;
        ALTER TABLE sessions ADD COLUMN project_label TEXT;

        ALTER TABLE activities ADD COLUMN project_id TEXT;
        ALTER TABLE activities ADD COLUMN project_label TEXT;
        ALTER TABLE activities ADD COLUMN project_cwd TEXT;
        CREATE INDEX activities_scope_project_recent
          ON activities(scope_id, project_id, updated_at DESC);

        ALTER TABLE jobs ADD COLUMN project_id TEXT;
        ALTER TABLE jobs ADD COLUMN project_label TEXT;
        CREATE INDEX jobs_project_recent ON jobs(project_id, updated_at DESC);

        ALTER TABLE agent_threads ADD COLUMN project_id TEXT;
        ALTER TABLE agent_threads ADD COLUMN project_label TEXT;
      `);
      const now = Date.now();
      this.setMeta("schema_version", "5");
      this.setMeta("schema_v5_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV5ToV6(): void {
    this.transaction(() => {
      this.database.exec(`
        ALTER TABLE agent_threads ADD COLUMN session_id TEXT;
      `);
      const now = Date.now();
      this.setMeta("schema_version", "6");
      this.setMeta("schema_v6_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV6ToV7(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE cancellation_operations (
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          request_id TEXT NOT NULL,
          root_intent_id TEXT NOT NULL UNIQUE,
          action_hash TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN (
            'model-tool','widget-control','activity-cascade','operator',
            'assignment-containment'
          )),
          tool_name TEXT NOT NULL,
          action_name TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK(target_kind IN ('job','activity')),
          target_job_id TEXT,
          target_activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
          target_agent_id TEXT,
          target_thread_id TEXT,
          target_turn_id TEXT,
          target_presentation_id TEXT,
          expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
          caller_presentation_kind TEXT CHECK(caller_presentation_kind IN ('automatic','explicit')),
          caller_presentation_id TEXT,
          widget_instance_present INTEGER NOT NULL CHECK(widget_instance_present IN (0,1)),
          widget_instance_digest TEXT,
          card_generation INTEGER CHECK(card_generation >= 1),
          caller_request_digest TEXT,
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          reason_code TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('recorded','completed','failed')),
          result TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          PRIMARY KEY(scope_id, request_id),
          CHECK((target_kind = 'job') = (target_job_id IS NOT NULL)),
          CHECK((widget_instance_present = 1) = (widget_instance_digest IS NOT NULL)),
          CHECK((caller_presentation_kind = 'automatic') = (caller_presentation_id IS NOT NULL))
        ) STRICT;
        CREATE INDEX cancellation_operations_target_job
          ON cancellation_operations(target_job_id, created_at ASC);
        CREATE INDEX cancellation_operations_target_activity
          ON cancellation_operations(target_activity_id, created_at ASC);

        CREATE TABLE cancellation_intents (
          intent_id TEXT PRIMARY KEY,
          scope_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          parent_intent_id TEXT REFERENCES cancellation_intents(intent_id) ON DELETE RESTRICT,
          cascade_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN (
            'model-tool','widget-control','activity-cascade','operator',
            'assignment-containment'
          )),
          tool_name TEXT NOT NULL,
          action_name TEXT NOT NULL,
          target_kind TEXT NOT NULL CHECK(target_kind IN ('job','activity')),
          target_job_id TEXT,
          target_activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
          target_agent_id TEXT,
          target_thread_id TEXT,
          target_turn_id TEXT,
          target_presentation_id TEXT,
          expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
          caller_presentation_kind TEXT CHECK(caller_presentation_kind IN ('automatic','explicit')),
          caller_presentation_id TEXT,
          widget_instance_present INTEGER NOT NULL CHECK(widget_instance_present IN (0,1)),
          widget_instance_digest TEXT,
          card_generation INTEGER CHECK(card_generation >= 1),
          caller_request_digest TEXT,
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          reason_code TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('recorded','dispatched','succeeded','failed','no-op')),
          created_at INTEGER NOT NULL,
          dispatched_at INTEGER,
          completed_at INTEGER,
          FOREIGN KEY(scope_id, request_id)
            REFERENCES cancellation_operations(scope_id, request_id) ON DELETE RESTRICT,
          CHECK((target_kind = 'job') = (target_job_id IS NOT NULL)),
          CHECK((widget_instance_present = 1) = (widget_instance_digest IS NOT NULL)),
          CHECK((caller_presentation_kind = 'automatic') = (caller_presentation_id IS NOT NULL))
        ) STRICT;
        CREATE INDEX cancellation_intents_operation
          ON cancellation_intents(scope_id, request_id, created_at ASC);
        CREATE INDEX cancellation_intents_target_job
          ON cancellation_intents(target_job_id, created_at ASC);
        CREATE INDEX cancellation_intents_target_activity
          ON cancellation_intents(target_activity_id, created_at ASC);
        CREATE INDEX cancellation_intents_cascade
          ON cancellation_intents(cascade_id, created_at ASC);

        CREATE TABLE transport_observations (
          observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK(kind IN (
            'http-request-aborted','http-response-detached','mcp-handler-aborted',
            'status-wait-aborted','activity-watch-aborted','presentation-superseded'
          )),
          scope_id TEXT,
          job_id TEXT,
          activity_id TEXT,
          tool_name TEXT,
          caller_request_digest TEXT,
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          reason_code TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX transport_observations_recent
          ON transport_observations(created_at DESC, observation_id DESC);
      `);
      const now = Date.now();
      this.setMeta("schema_version", "7");
      this.setMeta("schema_v7_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV7ToV8(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE project_registry (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          registry_revision INTEGER NOT NULL CHECK(registry_revision >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO project_registry(singleton, registry_revision, updated_at)
          VALUES (1, 0, 0);

        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          cwd TEXT NOT NULL,
          sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        ) STRICT;
        CREATE UNIQUE INDEX projects_active_name
          ON projects(name_key) WHERE archived_at IS NULL;
        CREATE UNIQUE INDEX projects_active_cwd
          ON projects(cwd) WHERE archived_at IS NULL;
        CREATE INDEX projects_ordered
          ON projects(archived_at, sort_order, created_at);

        ALTER TABLE user_settings ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0
          CHECK(settings_revision >= 0);
        ALTER TABLE user_settings ADD COLUMN updated_at INTEGER;

        ALTER TABLE sessions ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE sessions ADD COLUMN project_name_snapshot TEXT;

        ALTER TABLE activities ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE activities ADD COLUMN project_name_snapshot TEXT;
        ALTER TABLE activities ADD COLUMN project_cwd_snapshot TEXT;
        CREATE INDEX activities_project_pin
          ON activities(project_uuid, project_cwd_snapshot, lifecycle);

        ALTER TABLE jobs ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE jobs ADD COLUMN project_name_snapshot TEXT;
        ALTER TABLE jobs ADD COLUMN project_cwd_snapshot TEXT;
        CREATE INDEX jobs_project_pin
          ON jobs(project_uuid, project_cwd_snapshot, status);

        ALTER TABLE agent_threads ADD COLUMN project_uuid TEXT REFERENCES projects(project_id);
        ALTER TABLE agent_threads ADD COLUMN project_name_snapshot TEXT;
        ALTER TABLE agent_threads ADD COLUMN project_cwd_snapshot TEXT;
        CREATE INDEX agent_threads_project_pin
          ON agent_threads(project_uuid, project_cwd_snapshot, is_current);
      `);

      const settingsRow = this.database
        .prepare("SELECT payload FROM user_settings WHERE singleton = 1")
        .get() as JsonRow | undefined;
      if (settingsRow) {
        const payload = parsePayload(settingsRow, "settings") as Record<string, unknown>;
        const legacyRevision = Number.isInteger(payload.revision) && Number(payload.revision) >= 0
          ? Number(payload.revision)
          : 0;
        // Project rows in the pre-v8 JSON shape are intentionally not
        // identities in the UUID registry. Remove them (and the retired
        // default selectors) so user_settings remains ordinary-settings-only.
        const ordinarySettings = { ...payload };
        delete ordinarySettings.projects;
        delete ordinarySettings.defaultProjectId;
        delete ordinarySettings.defaultCwd;
        this.database
          .prepare(`
            UPDATE user_settings
               SET payload = ?, settings_revision = ?
             WHERE singleton = 1
          `)
          .run(JSON.stringify(ordinarySettings), legacyRevision);
      }

      const now = Date.now();
      this.setMeta("schema_version", "8");
      this.setMeta("schema_v8_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV8ToV9(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE steering_deliveries (
          scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
          request_id TEXT NOT NULL,
          action_hash TEXT NOT NULL,
          job_id TEXT NOT NULL,
          expected_job_version INTEGER NOT NULL CHECK(expected_job_version >= 1),
          prompt_sha256 TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'prepared','dispatching','delivered','not-delivered','uncertain'
          )),
          bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
          result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          dispatched_at INTEGER,
          completed_at INTEGER,
          PRIMARY KEY(scope_id, request_id),
          CHECK(length(action_hash) = 64),
          CHECK(length(prompt_sha256) = 64),
          CHECK((status IN ('prepared','dispatching')) = (completed_at IS NULL))
        ) STRICT;
        CREATE INDEX steering_deliveries_job_recent
          ON steering_deliveries(job_id, created_at DESC);
        CREATE INDEX steering_deliveries_status_recent
          ON steering_deliveries(status, updated_at DESC);
      `);
      const now = Date.now();
      this.setMeta("schema_version", "9");
      this.setMeta("schema_v9_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV9ToV10(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        const rows = this.database
          .prepare(`
            SELECT project_id, name, name_key, cwd, sort_order,
                   created_at, updated_at, archived_at
              FROM projects
             ORDER BY sort_order ASC, created_at ASC, project_id ASC
          `)
          .all() as LegacyProjectStorageRow[];
        this.database.exec(`
          CREATE TABLE projects_v10 (
            project_id TEXT PRIMARY KEY,
            project_ref TEXT NOT NULL UNIQUE,
            project_revision INTEGER NOT NULL CHECK(project_revision >= 1),
            name TEXT NOT NULL,
            name_key TEXT NOT NULL,
            cwd TEXT NOT NULL,
            sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER
          ) STRICT;
        `);
        const insert = this.database.prepare(`
          INSERT INTO projects_v10(
            project_id, project_ref, project_revision, name, name_key, cwd,
            sort_order, created_at, updated_at, archived_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insert.run(
            row.project_id,
            createProjectRef(),
            row.name,
            row.name_key,
            row.cwd,
            row.sort_order,
            row.created_at,
            row.updated_at,
            row.archived_at
          );
        }
        this.database.exec(`
          DROP TABLE projects;
          ALTER TABLE projects_v10 RENAME TO projects;
          CREATE UNIQUE INDEX projects_active_name
            ON projects(name_key) WHERE archived_at IS NULL;
          CREATE UNIQUE INDEX projects_active_cwd
            ON projects(cwd) WHERE archived_at IS NULL;
          CREATE INDEX projects_ordered
            ON projects(archived_at, sort_order, created_at);
        `);
        const now = Date.now();
        this.setMeta("schema_version", "10");
        this.setMeta("schema_v10_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
    const violations = this.database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error("Bridge state schema v10 migration produced foreign-key violations.");
    }
  }

  private migrateV10ToV11(): void {
    this.transaction(() => {
      if (!this.tableHasColumn("cancellation_operations", "reason_text")) {
        this.database.exec(`
          ALTER TABLE cancellation_operations
            ADD COLUMN reason_text TEXT
            CHECK(
              reason_text IS NULL OR
              (length(reason_text) BETWEEN 1 AND ${CANCELLATION_REASON_MAX_LENGTH})
            );
        `);
      }
      const now = Date.now();
      this.setMeta("schema_version", "11");
      this.setMeta("schema_v11_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV11ToV12(): void {
    this.transaction(() => {
      if (!this.tableHasColumn("projects", "deleted_at")) {
        this.database.exec(`
          ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
          DROP INDEX projects_active_name;
          DROP INDEX projects_active_cwd;
          DROP INDEX projects_ordered;
          CREATE UNIQUE INDEX projects_active_name
            ON projects(name_key)
            WHERE archived_at IS NULL AND deleted_at IS NULL;
          CREATE UNIQUE INDEX projects_active_cwd
            ON projects(cwd)
            WHERE archived_at IS NULL AND deleted_at IS NULL;
          CREATE INDEX projects_ordered
            ON projects(deleted_at, archived_at, sort_order, created_at);
        `);
      }
      const now = Date.now();
      this.setMeta("schema_version", "12");
      this.setMeta("schema_v12_migrated_at", new Date(now).toISOString());
    });
  }

  private migrateV12ToV13(): void {
    this.transaction(() => {
      this.database.exec(V13_QUESTION_STORE_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "13");
    });
  }

  private migrateV13ToV14(): void {
    this.transaction(() => {
      this.database.exec(V14_THREAD_CONNECTION_MIGRATION_SCHEMA);
      this.database.exec(V14_EVENT_RETENTION_MIGRATION_SCHEMA);
      // Visibility was historically coupled to ephemeral at creation. Missing evidence stays unknown.
      this.database.exec(`INSERT OR IGNORE INTO thread_connections(thread_id,scope_id,persistence,phase,updated_at)
        SELECT thread_id,scope_id,CASE json_extract(payload,'$.visibleInCodexApp')
          WHEN 1 THEN 'persistent' WHEN 0 THEN 'ephemeral' ELSE 'unknown' END,'blocked',last_used_at FROM sessions;
        UPDATE thread_connections SET reason='runtime-unverified';`);
      this.database.exec(`UPDATE thread_connections SET
        agent_id=(SELECT agent_id FROM agent_threads WHERE thread_id=thread_connections.thread_id),
        last_finished_at=(SELECT MAX(e.created_at) FROM job_events e JOIN jobs j ON j.job_id=e.job_id
          WHERE j.thread_id=thread_connections.thread_id AND j.upstream_request_id IS NOT NULL
          AND e.event_type IN ('job-completed','job-failed','job-interrupted','job-cancelled')),
        worker_pid=(SELECT json_extract(payload,'$.workerPid') FROM jobs WHERE thread_id=thread_connections.thread_id
          ORDER BY updated_at DESC LIMIT 1);`);
      this.setMeta("schema_version", "14");
    });
  }

  private migrateV14ToV15(): void {
    this.transaction(() => {
      this.database.exec(V15_WORK_HISTORY_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "15");
    });
  }

  private migrateV15OrV16ToV17(): void {
    this.transaction(() => {
      this.database.exec(V17_AUTOMATIC_RECOVERY_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "17");
    });
  }

  /** Restore every bridge-local archived Agent before archive/restore support is removed. */
  private migrateV17ToV18(): void {
    this.transaction(() => {
      const archived = this.database
        .prepare(`
          SELECT a.agent_id, a.scope_id, a.current_job_id, a.orphaned_reason,
                 j.status AS job_status, j.payload AS job_payload
            FROM agents a
            LEFT JOIN jobs j ON j.job_id = a.current_job_id AND j.archived_at IS NULL
           WHERE a.lifecycle = 'archived' OR a.archived_at IS NOT NULL
        `)
        .all() as Array<{
          agent_id: string;
          scope_id: string;
          current_job_id: string | null;
          orphaned_reason: string | null;
          job_status: string | null;
          job_payload: string | null;
        }>;
      let restoredCount = 0;
      for (const row of archived) {
        let lifecycle: BridgeAgentLifecycle = row.orphaned_reason ? "orphaned" : "idle";
        if (row.current_job_id && row.job_status && isActiveActivityJobStatus(row.job_status)) {
          const payload = row.job_payload
            ? parsePayload({ payload: row.job_payload }, "archived Agent current job") as Record<string, unknown>
            : undefined;
          lifecycle = hasBlockingInteraction(payload?.pendingInteractions) ? "waiting-input" : "active";
        }
        const currentJobId = lifecycle === "active" || lifecycle === "waiting-input"
          ? row.current_job_id
          : null;
        const update = this.database
          .prepare(`
            UPDATE agents
               SET lifecycle = ?, current_job_id = ?, archived_at = NULL, version = version + 1
             WHERE agent_id = ? AND (lifecycle = 'archived' OR archived_at IS NOT NULL)
          `)
          .run(lifecycle, currentJobId, row.agent_id);
        if (update.changes !== 1) {
          throw new Error("Schema v18 migration could not restore every archived Agent atomically.");
        }
        restoredCount += update.changes;
      }
      const remaining = Number((this.database
        .prepare("SELECT COUNT(*) AS count FROM agents WHERE lifecycle='archived' OR archived_at IS NOT NULL")
        .get() as CountRow).count);
      if (restoredCount !== archived.length || remaining !== 0) {
        throw new Error("Schema v18 migration left archived Agent state behind.");
      }
      const now = Date.now();
      for (const scopeId of new Set(archived.map((row) => row.scope_id))) {
        this.nextScopeVersion(scopeId, now);
      }
      this.setMeta("schema_version", "18");
      this.setMeta("schema_v18_restored_agent_count", String(restoredCount));
      this.setMeta("schema_v18_migrated_at", new Date(now).toISOString());
    });
  }

  /**
   * Rebuild schema 18 into the current ownership model. Every legacy table is
   * renamed first and the same complete DDL used by fresh installations is
   * then populated, so upgraded and new databases cannot drift structurally.
   */
  private migrateV18ToV19(): void {
    const upgradeSource = this.getMeta("schema_v19_upgrade_source") || "18";
    this.database.pragma("foreign_keys = OFF");
    this.database.pragma("legacy_alter_table = ON");
    try {
      this.transaction(() => {
        const disposable = this.database
          .prepare(`SELECT type,name FROM sqlite_master
            WHERE type IN ('index','trigger') AND name NOT LIKE 'sqlite_%'`)
          .all() as Array<{ type: "index" | "trigger"; name: string }>;
        for (const object of disposable) {
          this.database.exec(`DROP ${object.type.toUpperCase()} ${sqlIdentifier(object.name)}`);
        }

        const legacyTables = (this.database
          .prepare(`SELECT name FROM sqlite_master
            WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'bridge_meta'
            ORDER BY name`)
          .all() as Array<{ name: string }>).map((row) => row.name);
        for (const table of legacyTables) {
          this.database.exec(
            `ALTER TABLE ${sqlIdentifier(table)} RENAME TO ${sqlIdentifier(`legacy_v18_${table}`)}`
          );
        }

        this.database.exec(CURRENT_STATE_SCHEMA);

        this.database.exec(`
          INSERT INTO scopes(scope_id,version,created_at,updated_at)
          SELECT s.scope_id,COALESCE(v.version,0),s.created_at,
                 MAX(s.updated_at,COALESCE(v.updated_at,s.updated_at))
            FROM legacy_v18_scopes s
            LEFT JOIN legacy_v18_scope_versions v ON v.scope_id=s.scope_id;

          INSERT OR REPLACE INTO project_registry SELECT * FROM legacy_v18_project_registry;
          INSERT INTO projects SELECT * FROM legacy_v18_projects;
          INSERT INTO user_settings SELECT * FROM legacy_v18_user_settings;
          INSERT INTO bridge_instances SELECT * FROM legacy_v18_bridge_instances;

          INSERT INTO sessions(
            thread_id,scope_id,project_id,backend_kind,cwd,sandbox,session_id,
            forked_from_thread_id,persistence,visible_in_codex_app,selection,
            policy_revision,created_at,updated_at,last_used_at
          )
          SELECT s.thread_id,s.scope_id,p.project_id,
                 CASE json_extract(s.payload,'$.backendKind')
                   WHEN 'app-server' THEN 'app-server' WHEN 'codex-sdk' THEN 'codex-sdk'
                   ELSE 'mcp-server' END,
                 s.cwd,
                 CASE json_extract(s.payload,'$.sandbox')
                   WHEN 'read-only' THEN 'read-only'
                   WHEN 'danger-full-access' THEN 'danger-full-access'
                   ELSE 'workspace-write' END,
                 NULLIF(json_extract(s.payload,'$.sessionId'),''),
                 NULLIF(json_extract(s.payload,'$.forkedFromThreadId'),''),
                 CASE
                   WHEN json_extract(s.payload,'$.persistence') IN ('persistent','ephemeral','unknown')
                     THEN json_extract(s.payload,'$.persistence')
                   WHEN c.persistence IN ('persistent','ephemeral','unknown') THEN c.persistence
                   WHEN json_extract(s.payload,'$.visibleInCodexApp')=1 THEN 'persistent'
                   WHEN json_extract(s.payload,'$.visibleInCodexApp')=0 THEN 'ephemeral'
                   ELSE 'unknown' END,
                 CASE json_extract(s.payload,'$.visibleInCodexApp') WHEN 1 THEN 1 WHEN 0 THEN 0 END,
                 CASE WHEN json_type(s.payload,'$.selection')='object'
                   THEN json_extract(s.payload,'$.selection') END,
                 CASE WHEN typeof(json_extract(s.payload,'$.policyRevision'))='integer'
                   AND json_extract(s.payload,'$.policyRevision')>=0
                   THEN json_extract(s.payload,'$.policyRevision') END,
                 CASE WHEN typeof(json_extract(s.payload,'$.createdAt')) IN ('integer','real')
                   THEN json_extract(s.payload,'$.createdAt') ELSE s.last_used_at END,
                 CASE WHEN typeof(json_extract(s.payload,'$.updatedAt')) IN ('integer','real')
                   THEN json_extract(s.payload,'$.updatedAt') ELSE s.last_used_at END,
                 s.last_used_at
            FROM legacy_v18_sessions s
            LEFT JOIN legacy_v18_projects p
              ON p.project_id=COALESCE(s.project_uuid,s.project_id)
            LEFT JOIN legacy_v18_thread_connections c ON c.thread_id=s.thread_id
           WHERE p.project_id IS NOT NULL OR COALESCE(
             s.project_id,s.project_label,s.project_uuid,s.project_name_snapshot,
             json_extract(s.payload,'$.projectId'),json_extract(s.payload,'$.projectLabel')
           ) IS NULL;

          /* Some historical Agent threads predate the session mirror. Preserve
             only contexts with no project or an actual registered project. */
          INSERT OR IGNORE INTO sessions(
            thread_id,scope_id,project_id,backend_kind,cwd,sandbox,session_id,
            forked_from_thread_id,persistence,visible_in_codex_app,selection,
            policy_revision,created_at,updated_at,last_used_at
          )
          SELECT t.thread_id,t.scope_id,p.project_id,t.backend_kind,t.cwd,t.sandbox,
                 t.session_id,t.forked_from_thread_id,
                 COALESCE(c.persistence,'unknown'),NULL,NULL,NULL,t.linked_at,
                 COALESCE(t.replaced_at,t.linked_at),COALESCE(t.replaced_at,t.linked_at)
            FROM legacy_v18_agent_threads t
            LEFT JOIN legacy_v18_projects p
              ON p.project_id=COALESCE(t.project_uuid,t.project_id)
            LEFT JOIN legacy_v18_thread_connections c ON c.thread_id=t.thread_id
           WHERE (p.project_id IS NOT NULL OR COALESCE(
             t.project_id,t.project_label,t.project_uuid,t.project_name_snapshot
           ) IS NULL)
             AND NOT EXISTS (
               SELECT 1 FROM legacy_v18_sessions original
                WHERE original.thread_id=t.thread_id
             );

          INSERT INTO activities(
            activity_id,scope_id,project_id,pinned_cwd,continuation_of_activity_id,
            card_generation,title,kind,execution_mode,handoff_policy,
            completion_trigger,lifecycle,waiting_on,verification,version,
            completion_version,legacy,created_at,updated_at,sealed_at,completed_at,
            total_jobs,running_jobs,completed_jobs,failed_jobs,interrupted_jobs,
            cancelled_jobs,terminal_jobs
          )
          SELECT a.activity_id,a.scope_id,p.project_id,
                 CASE WHEN p.project_id IS NOT NULL THEN
                   COALESCE(a.project_cwd_snapshot,a.project_cwd,p.cwd) END,
                 a.continuation_of_activity_id,a.card_generation,a.title,a.kind,
                 CASE a.execution_mode WHEN 'foreground' THEN 'foreground' ELSE 'background' END,
                 a.handoff_policy,a.completion_trigger,a.lifecycle,a.waiting_on,
                 a.verification,a.version,a.completion_version,a.legacy,a.created_at,
                 a.updated_at,a.sealed_at,a.completed_at,a.total_jobs,a.running_jobs,
                 a.completed_jobs,a.failed_jobs,a.interrupted_jobs,a.cancelled_jobs,a.terminal_jobs
            FROM legacy_v18_activities a
            LEFT JOIN legacy_v18_projects p
              ON p.project_id=COALESCE(a.project_uuid,a.project_id);

          INSERT INTO agents(
            agent_id,scope_id,agent_name,normalized_name,lifecycle,current_thread_id,
            current_job_id,version,created_at,updated_at,orphaned_reason
          )
          SELECT agent_id,scope_id,agent_name,normalized_name,
                 CASE lifecycle WHEN 'archived' THEN 'idle' ELSE lifecycle END,
                 NULL,current_job_id,version,created_at,updated_at,orphaned_reason
            FROM legacy_v18_agents;

          INSERT INTO agent_threads(thread_id,agent_id,context_mode,is_current,linked_at,replaced_at)
          SELECT t.thread_id,t.agent_id,t.context_mode,t.is_current,t.linked_at,t.replaced_at
            FROM legacy_v18_agent_threads t
            JOIN sessions s ON s.thread_id=t.thread_id
            LEFT JOIN legacy_v18_projects p
              ON p.project_id=COALESCE(t.project_uuid,t.project_id)
           WHERE p.project_id IS NOT NULL OR COALESCE(
             t.project_id,t.project_label,t.project_uuid,t.project_name_snapshot
           ) IS NULL;

          UPDATE agents
             SET current_thread_id=(
               SELECT old.current_thread_id FROM legacy_v18_agents old
                WHERE old.agent_id=agents.agent_id
                  AND EXISTS (SELECT 1 FROM agent_threads t
                    WHERE t.thread_id=old.current_thread_id AND t.agent_id=old.agent_id)
             );
          UPDATE agents
             SET lifecycle='orphaned',current_job_id=NULL,
                 orphaned_reason=COALESCE(orphaned_reason,'legacy-project-context-removed'),
                 version=version+1
           WHERE lifecycle IN ('active','waiting-input') AND current_thread_id IS NULL;

          INSERT INTO activity_agents SELECT * FROM legacy_v18_activity_agents;
        `);

        const terminalOrigin = `CASE json_extract(j.payload,'$.terminalOrigin')
          WHEN 'normal-completion' THEN 'normal-completion'
          WHEN 'upstream-failure' THEN 'upstream-failure'
          WHEN 'app-server-interrupted' THEN 'app-server-interrupted'
          WHEN 'explicit-cancellation' THEN 'explicit-cancellation'
          WHEN 'assignment-containment' THEN 'assignment-containment'
          WHEN 'bridge-restart' THEN 'bridge-restart'
          WHEN 'worker-loss' THEN 'worker-loss'
          WHEN 'sdk-abort' THEN 'sdk-abort'
          WHEN 'sdk-timeout' THEN 'sdk-timeout'
          WHEN 'authentication-failure' THEN 'authentication-failure'
          WHEN 'usage-limit' THEN 'usage-limit'
          WHEN 'legacy-unattributed-cancellation' THEN 'legacy-unattributed-cancellation' END`;
        const payload = `json_remove(j.payload,
          '$.jobId','$.scopeId','$.requestId','$.activityId','$.threadId',
          '$.sourceThreadId','$.status','$.executionMode','$.backendKind',
          '$.bridgeInstanceId','$.workerId','$.workerGeneration','$.upstreamRequestId',
          '$.terminalVersion','$.agentId','$.contextMode','$.projectId','$.projectLabel',
          '$.projectName','$.projectUuid','$.projectNameSnapshot','$.projectCwdSnapshot',
          '$.cwd','$.sandbox','$.createdAt','$.updatedAt','$.version','$.lastProgressAt',
          '$.lastProgress','$.publicEvents','$.inputEvents','$.pendingInteractions',
          '$.terminalOrigin','$.cancellationIntentId')`;
        this.database.exec(`
          INSERT INTO jobs(
            job_id,scope_id,request_id,activity_id,thread_id,source_thread_id,status,
            execution_mode,backend_kind,bridge_instance_id,worker_id,worker_generation,
            upstream_request_id,terminal_version,agent_id,context_mode,cwd,sandbox,
            created_at,updated_at,archived_at,job_version,last_progress_at,last_progress,
            terminal_origin,cancellation_intent_id,summary,payload
          )
          SELECT j.job_id,j.scope_id,j.request_id,j.activity_id,j.thread_id,
                 NULLIF(json_extract(j.payload,'$.sourceThreadId'),''),j.status,
                 CASE j.execution_mode WHEN 'foreground' THEN 'foreground' ELSE 'background' END,
                 j.backend_kind,j.bridge_instance_id,j.worker_id,j.worker_generation,
                 j.upstream_request_id,j.terminal_version,j.agent_id,j.context_mode,
                 COALESCE(NULLIF(json_extract(j.payload,'$.cwd'),''),s.cwd,a.pinned_cwd,'/'),
                 CASE COALESCE(json_extract(j.payload,'$.sandbox'),
                               json_extract(s.payload,'$.sandbox'))
                   WHEN 'read-only' THEN 'read-only'
                   WHEN 'danger-full-access' THEN 'danger-full-access'
                   ELSE 'workspace-write' END,
                 CASE WHEN typeof(json_extract(j.payload,'$.createdAt')) IN ('integer','real')
                   THEN json_extract(j.payload,'$.createdAt') ELSE j.updated_at END,
                 j.updated_at,j.archived_at,
                 CASE WHEN typeof(json_extract(j.payload,'$.version'))='integer'
                   AND json_extract(j.payload,'$.version')>=1
                   THEN json_extract(j.payload,'$.version') ELSE 1 END,
                 CASE WHEN typeof(json_extract(j.payload,'$.lastProgressAt')) IN ('integer','real')
                   THEN json_extract(j.payload,'$.lastProgressAt') ELSE j.updated_at END,
                 CASE WHEN json_type(j.payload,'$.lastProgress')='object'
                   THEN json_extract(j.payload,'$.lastProgress') END,
                 ${terminalOrigin},
                 CASE WHEN typeof(json_extract(j.payload,'$.cancellationIntentId'))='text'
                   THEN json_extract(j.payload,'$.cancellationIntentId') END,
                 COALESCE(NULLIF(summary.payload,''),'{}'),${payload}
            FROM legacy_v18_jobs j
            JOIN activities a ON a.activity_id=j.activity_id
            LEFT JOIN legacy_v18_sessions s ON s.thread_id=j.thread_id
            LEFT JOIN legacy_v18_job_summaries summary ON summary.job_id=j.job_id;

          INSERT INTO job_interactions(job_id,position,interaction_id,is_blocking,payload)
          SELECT j.job_id,CAST(interaction.key AS INTEGER),
                 COALESCE(NULLIF(json_extract(interaction.value,'$.interactionId'),''),
                          printf('legacy-%d',interaction.key)),
                 CASE WHEN json_type(interaction.value)='object'
                   THEN CASE COALESCE(json_extract(interaction.value,'$.isBlocking'),1)
                     WHEN 0 THEN 0 ELSE 1 END ELSE 1 END,
                 CASE WHEN json_type(interaction.value)='object'
                   THEN json_remove(interaction.value,'$.interactionId','$.isBlocking')
                   ELSE '{}' END
            FROM legacy_v18_jobs j,json_each(j.payload,'$.pendingInteractions') interaction
            JOIN jobs current_job ON current_job.job_id=j.job_id;

          INSERT INTO activity_events SELECT * FROM legacy_v18_activity_events;
          INSERT INTO job_events
          SELECT e.* FROM legacy_v18_job_events e JOIN jobs j ON j.job_id=e.job_id;
          INSERT INTO completion_outbox SELECT * FROM legacy_v18_completion_outbox;
          INSERT INTO agent_mutations SELECT * FROM legacy_v18_agent_mutations;
          INSERT INTO cancellation_operations SELECT * FROM legacy_v18_cancellation_operations;
          INSERT INTO cancellation_intents SELECT * FROM legacy_v18_cancellation_intents;
          INSERT INTO steering_deliveries SELECT * FROM legacy_v18_steering_deliveries;
          INSERT INTO transport_observations SELECT * FROM legacy_v18_transport_observations;
          INSERT INTO user_questions SELECT * FROM legacy_v18_user_questions;
          INSERT INTO codex_question_deliveries SELECT * FROM legacy_v18_codex_question_deliveries;
          INSERT INTO thread_connections SELECT * FROM legacy_v18_thread_connections;
          INSERT INTO result_holds
          SELECT h.* FROM legacy_v18_result_holds h JOIN jobs j ON j.job_id=h.job_id;
          INSERT INTO work_history_state(job_id,acknowledged_at,expired_at,review_sequence)
          SELECT h.job_id,h.acknowledged_at,h.expired_at,
                 CAST((SELECT value FROM bridge_meta
                   WHERE key='work_history_review_seq:' || h.job_id) AS INTEGER)
            FROM legacy_v18_work_history_state h JOIN jobs j ON j.job_id=h.job_id;
          INSERT INTO automatic_recovery SELECT * FROM legacy_v18_automatic_recovery;
          INSERT INTO automatic_recovery_incidents SELECT * FROM legacy_v18_automatic_recovery_incidents;
        `);

        const migratedSummaries = this.database.prepare(`SELECT job_id,summary FROM jobs
          WHERE summary!='{}'`).all() as Array<{job_id:string;summary:string}>;
        const updateSummary = this.database.prepare("UPDATE jobs SET summary=? WHERE job_id=?");
        for (const row of migratedSummaries) {
          updateSummary.run(
            JSON.stringify(sanitizeRetainedJobSummary(JSON.parse(row.summary))),
            row.job_id
          );
        }

        const reviewRevision = nonNegativeInteger(this.getMeta("work_history_review_revision"));
        const historyCursor = legacyJsonRecord(this.getMeta("work_history_cursor"));
        const historyCleanup = legacyJsonRecord(this.getMeta("work_history_cleanup"));
        const retentionPolicy = nonNegativeInteger(this.getMeta("event_retention_policy"));
        const retentionCursor = nonNegativeInteger(this.getMeta("event_retention_cursor"));
        this.database.prepare(`UPDATE work_history_control SET
          review_revision=?,cursor_updated_at=?,cursor_job_id=?,last_cleanup_at=?,
          last_cleanup_count=?,total_removed=? WHERE singleton=1`).run(
          reviewRevision,
          nonNegativeInteger(historyCursor?.at),
          typeof historyCursor?.id === "string" ? historyCursor.id : "",
          optionalNonNegativeInteger(historyCleanup?.at),
          nonNegativeInteger(historyCleanup?.count),
          nonNegativeInteger(historyCleanup?.total)
        );
        this.database.prepare(`UPDATE event_retention_state SET policy_version=2,cursor_event_id=?
          WHERE singleton=1`).run(retentionPolicy === 2 ? retentionCursor : 0);
        const runtimeResolutions = this.database.prepare(`SELECT key,value FROM bridge_meta
          WHERE key LIKE 'runtime_problem_resolved:%'`).all() as Array<{key:string;value:string}>;
        for (const row of runtimeResolutions) {
          const agentId = row.key.slice("runtime_problem_resolved:".length);
          const resolution = legacyJsonRecord(row.value);
          if (
            !agentId ||
            typeof resolution?.revision !== "string" ||
            resolution.revision.length > 512 ||
            optionalNonNegativeInteger(resolution.at) === null ||
            !this.database.prepare("SELECT 1 FROM agents WHERE agent_id=?").get(agentId)
          ) continue;
          this.database.prepare(`INSERT INTO runtime_problem_resolutions(agent_id,revision,resolved_at)
            VALUES (?,?,?)`).run(agentId,resolution.revision,resolution.at);
        }

        const removedSessions = Number((this.database.prepare(`SELECT COUNT(*) AS count
          FROM legacy_v18_sessions old WHERE NOT EXISTS
            (SELECT 1 FROM sessions current WHERE current.thread_id=old.thread_id)`).get() as CountRow).count);
        const removedAgentThreads = Number((this.database.prepare(`SELECT COUNT(*) AS count
          FROM legacy_v18_agent_threads old WHERE NOT EXISTS
            (SELECT 1 FROM agent_threads current WHERE current.thread_id=old.thread_id)`).get() as CountRow).count);

        this.database.prepare(`DELETE FROM bridge_meta
          WHERE key LIKE 'legacy_sessions_imported:%'
             OR key LIKE 'legacy_jobs_imported:%'
             OR key LIKE 'legacy_settings_imported:%'
             OR key LIKE 'work_history_review_seq:%'
             OR key LIKE 'runtime_problem_resolved:%'
             OR key IN ('work_history_review_revision','work_history_cursor','work_history_cleanup',
                        'event_retention_policy','event_retention_cursor')
             OR key='legacy_auto_execution_mode_migrated_at'`).run();

        for (const table of [...legacyTables].reverse()) {
          this.database.exec(`DROP TABLE ${sqlIdentifier(`legacy_v18_${table}`)}`);
        }
        const violations = this.database.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error("Bridge state schema v19 migration produced foreign-key violations.");
        }
        const now = Date.now();
        this.setMeta("schema_version", "19");
        this.setMeta("schema_v19_source_version", upgradeSource);
        this.setMeta("schema_v19_removed_legacy_session_count", String(removedSessions));
        this.setMeta("schema_v19_removed_legacy_agent_thread_count", String(removedAgentThreads));
        this.setMeta("schema_v19_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("legacy_alter_table = OFF");
      this.database.pragma("foreign_keys = ON");
    }
  }

  private migrateV19ToV20(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(V20_ASYNC_EXECUTION_MIGRATION_SCHEMA);
        const violations = this.database.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error("Bridge state schema v20 migration produced foreign-key violations.");
        }
        const now = Date.now();
        this.setMeta("schema_version", "20");
        this.setMeta("schema_v20_execution_contract", "durable-async-v1");
        this.setMeta("schema_v20_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
  }

  private migrateV20ToV21(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA);
        const violations = this.database.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error("Bridge state schema v21 migration produced foreign-key violations.");
        }
        const now = Date.now();
        this.setMeta("schema_version", "21");
        this.setMeta("schema_v21_completion_delivery_contract", "exact-job-live-card-v1");
        this.setMeta("schema_v21_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
  }

  private migrateV21ToV22(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA);
        const violations = this.database.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error("Bridge state schema v22 migration produced foreign-key violations.");
        }
        const now = Date.now();
        this.setMeta("schema_version", "22");
        this.setMeta("schema_v22_completion_result_source", "direct-result-consumption-v1");
        this.setMeta("schema_v22_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
  }

  private migrateV22ToV23(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA);
        const violations = this.database.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error("Bridge state schema v23 migration produced foreign-key violations.");
        }
        const now = Date.now();
        this.setMeta("schema_version", "23");
        this.setMeta("schema_v23_completion_result_offer", "server-offer-not-receipt-v1");
        this.setMeta("schema_v23_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
  }

  private migrateV23ToV24(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(V24_DECISION_CARD_MIGRATION_SCHEMA);
        const violations = this.database.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error("Bridge state schema v24 migration produced foreign-key violations.");
        }
        const now = Date.now();
        this.setMeta("schema_version", "24");
        this.setMeta("schema_v24_decision_card_contract", "freeform-decision-card-v1");
        this.setMeta("schema_v24_migrated_at", new Date(now).toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
  }

  private migrateV24ToV25(): void {
    this.transaction(() => {
      this.database.exec(V25_OPERATIONAL_COMMAND_RECEIPT_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "25");
      this.setMeta("schema_v25_operational_command_receipts", "durable-command-receipts-v1");
      this.setMeta("schema_v25_migrated_at", new Date().toISOString());
    });
  }

  private migrateV25ToV26(): void {
    this.transaction(() => {
      this.database.exec(V26_MODEL_DESCRIPTION_VERSIONS_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "26");
      this.setMeta("schema_v26_model_description_versions", "per-model-history-v1");
      this.setMeta("schema_v26_migrated_at", new Date().toISOString());
    });
  }

  private migrateV26ToV27(): void {
    this.database.pragma("foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.database.exec(V27_DECISION_CARD_RETIREMENT_MIGRATION_SCHEMA);
        const violations = this.database.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error("Bridge state schema v27 migration produced foreign-key violations.");
        }
        this.setMeta("schema_version", "27");
        this.setMeta("schema_v27_decision_card_retirement", "legacy-tables-dropped-v1");
        this.setMeta("schema_v27_migrated_at", new Date().toISOString());
      });
    } finally {
      this.database.pragma("foreign_keys = ON");
    }
  }

  private migrateV27ToV28(): void {
    this.transaction(() => {
      this.database.exec(V28_JOB_HISTORY_INDEX_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "28");
      this.setMeta("schema_v28_job_history_index", "agent-recent-v1");
      this.setMeta("schema_v28_migrated_at", new Date().toISOString());
    });
  }

  private migrateV28ToV29(): void {
    this.transaction(() => {
      this.database.exec(V29_BACKGROUND_WORK_INDEX_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "29");
      this.setMeta("schema_v29_background_work_indexes", "recovery-agent-and-worker-v1");
      this.setMeta("schema_v29_migrated_at", new Date().toISOString());
    });
  }

  private migrateV29ToV30(): void {
    this.transaction(() => {
      this.database.exec(V30_SESSION_AUTH_BOUNDARY_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "30");
      this.setMeta("schema_v30_session_auth_boundary", "nullable-owner-v1");
      this.setMeta("schema_v30_migrated_at", new Date().toISOString());
    });
  }

  private migrateV30ToV31(): void {
    this.transaction(() => {
      this.database.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA);
      this.setMeta("schema_version", "31");
      this.setMeta("schema_v31_cogate_storage", "workspace-hmac-and-lineage-evidence-v1");
      this.setMeta("schema_v31_migrated_at", new Date().toISOString());
    });
  }

  private readOperationalCommandReceipt<T>(
    commandId: string
  ): OperationalCommandReceipt<T> | undefined {
    const row = this.database.prepare(`
      SELECT command_id, operation, payload_sha256, aggregate_key, resulting_version,
             result, worker_generation, committed_at
        FROM operational_command_receipts
       WHERE command_id = ?
    `).get(commandId) as {
      command_id: string;
      operation: string;
      payload_sha256: string;
      aggregate_key: string | null;
      resulting_version: number | null;
      result: string;
      worker_generation: string;
      committed_at: number;
    } | undefined;
    if (!row) return undefined;
    return {
      commandId: row.command_id,
      operation: row.operation,
      payloadSha256: row.payload_sha256,
      ...(row.aggregate_key !== null ? { aggregateKey: row.aggregate_key } : {}),
      ...(row.resulting_version !== null ? { resultingVersion: row.resulting_version } : {}),
      result: parseStoredJson(row.result, "operational command receipt result") as T,
      workerGeneration: row.worker_generation,
      committedAt: row.committed_at
    };
  }

  private registerBridgeInstance(): void {
    this.transaction(() => {
      const now = Date.now();
      const liveOwners = (this.database.prepare(`
        SELECT DISTINCT process_id
          FROM bridge_instances
         WHERE stopped_at IS NULL AND instance_id <> ?
      `).all(this.currentInstanceId) as Array<{ process_id: number }>)
        .map((row) => Number(row.process_id))
        .filter((processId) => Number.isSafeInteger(processId) && processIsAlive(processId));
      if (liveOwners.length > 0) {
        throw new Error(
          `Bridge state startup lost exclusive ownership to live process(es): ${liveOwners.join(", ")}.`
        );
      }
      this.database
        .prepare(`
          UPDATE bridge_instances
             SET stopped_at = ?, termination_reason = 'superseded-by-restart'
           WHERE stopped_at IS NULL AND instance_id <> ?
        `)
        .run(now, this.currentInstanceId);
      this.database
        .prepare(`
          INSERT INTO bridge_instances(
            instance_id, started_at, stopped_at, termination_reason, process_id, payload
          ) VALUES (?, ?, NULL, NULL, ?, ?)
        `)
        .run(
          this.currentInstanceId,
          now,
          process.pid,
          JSON.stringify({
            schemaVersion: Number(CURRENT_SCHEMA_VERSION),
            productVersion: PRODUCT_INFO.version,
            buildId: BRIDGE_BUILD_INFO.id
          })
        );
      this.setMeta("state_runtime_product_version", PRODUCT_INFO.version);
      this.setMeta("state_runtime_build_id", BRIDGE_BUILD_INFO.id);
    });
  }

  private upsertJobInternal(job: JobRowInput): void {
    // Late snapshots cannot resurrect expired display data or release the
    // original request reservation.
    if (this.workHistory?.expired(job.jobId)) return;
    if (job.approvedFollowups || job.followup) job = { ...job,
      approvedFollowups: issueApprovedFollowups(job.jobId, job.approvedFollowups),
      followup: job.followup ? readFollowupReference(job.followup) : undefined };
    if (!valueIsOneOf(ACTIVITY_JOB_STATUSES, job.status)) {
      throw new Error(`Invalid Codex job status for Activity storage: ${job.status}.`);
    }
    const activityId = normalizeUuid(
      job.activityId || legacyActivityIdForJob(job.jobId),
      "job activityId"
    );
    const scopeId = normalizeUuid(job.scopeId, "job scopeId");
    const previous = this.database
      .prepare(`
        SELECT j.scope_id,j.activity_id,j.thread_id,j.source_thread_id,j.status,j.backend_kind,j.bridge_instance_id,
               j.terminal_version,j.agent_id,j.context_mode,j.cwd,j.sandbox,j.created_at,j.job_version,
               j.last_progress_at,j.last_progress,j.terminal_origin,j.cancellation_intent_id,
               a.project_id,p.name AS project_name,
               a.pinned_cwd,j.archived_at,
               COALESCE(json_extract(j.payload,'$.completionDeliveryPolicy'),'live-card') AS completion_delivery_policy
          FROM jobs j JOIN activities a ON a.activity_id=j.activity_id
          LEFT JOIN projects p ON p.project_id=a.project_id
         WHERE j.job_id = ?
      `)
      .get(job.jobId) as PreviousJobRow | undefined;
    if (!previous && job.status === "running") this.threadConnections.assertAdmission(job.agentId, job.threadId || job.sessionDecision?.threadId || job.sourceThreadId);
    const terminalOrigin = job.terminalOrigin ||
      (previous?.terminal_origin && JOB_TERMINAL_ORIGINS.includes(previous.terminal_origin as JobTerminalOrigin)
        ? previous.terminal_origin as JobTerminalOrigin
        : undefined);
    if (terminalOrigin && !JOB_TERMINAL_ORIGINS.includes(terminalOrigin)) {
      throw new Error("Invalid Codex job terminal origin.");
    }
    const cancellationIntentId = job.cancellationIntentId
      ? normalizeUuid(job.cancellationIntentId, "job cancellationIntentId")
      : previous?.cancellation_intent_id || undefined;
    if (cancellationIntentId) {
      const intent = this.getCancellationIntent(cancellationIntentId);
      if (
        !intent ||
        intent.targetKind !== "job" ||
        intent.targetJobId !== job.jobId ||
        intent.scopeId !== job.scopeId
      ) {
        throw new Error(
          "CANCELLATION_PROVENANCE_REQUIRED: Job cancellation correlation does not match a durable target intent."
        );
      }
    }
    if (
      job.status === "cancelled" &&
      previous?.status !== "cancelled" &&
      !cancellationIntentId
    ) {
      throw new Error(
        "CANCELLATION_PROVENANCE_REQUIRED: A job cannot transition to cancelled without a durable cancellation intent."
      );
    }
    if (terminalOrigin === "explicit-cancellation" && !cancellationIntentId) {
      throw new Error(
        "CANCELLATION_PROVENANCE_REQUIRED: Explicit cancellation terminal origin requires a durable intent."
      );
    }
    const expectedStatusByOrigin: Partial<Record<JobTerminalOrigin, string>> = {
      "normal-completion": "completed",
      "upstream-failure": "failed",
      "app-server-interrupted": "interrupted",
      "explicit-cancellation": "cancelled",
      "assignment-containment": "interrupted",
      "bridge-restart": "interrupted",
      "worker-loss": "interrupted"
    };
    if (
      terminalOrigin &&
      expectedStatusByOrigin[terminalOrigin] &&
      job.status !== expectedStatusByOrigin[terminalOrigin]
    ) {
      throw new Error(
        `Invalid job terminal-origin matrix: ${terminalOrigin} cannot produce ${job.status}.`
      );
    }
    if (
      terminalOrigin === "app-server-interrupted" &&
      cancellationIntentId
    ) {
      throw new Error(
        "A spontaneous App Server interruption cannot claim a cancellation intent."
      );
    }
    if (
      job.status === "cancelled" &&
      previous?.status !== "cancelled" &&
      terminalOrigin !== "explicit-cancellation"
    ) {
      throw new Error(
        "A new cancelled terminal state requires explicit-cancellation origin."
      );
    }
    job.terminalOrigin = terminalOrigin;
    job.cancellationIntentId = cancellationIntentId;
    if (
      job.completionDeliveryPolicy !== undefined &&
      job.completionDeliveryPolicy !== "live-card" &&
      job.completionDeliveryPolicy !== "direct-wait"
    ) {
      throw new Error("Invalid Codex job completion delivery policy.");
    }
    const completionDeliveryPolicy = job.completionDeliveryPolicy ||
      (previous?.completion_delivery_policy === "direct-wait" ? "direct-wait" : "live-card");
    if (previous && previous.completion_delivery_policy !== completionDeliveryPolicy) {
      throw new Error("A persisted Codex job completion delivery policy cannot change.");
    }
    job.completionDeliveryPolicy = completionDeliveryPolicy;
    if (previous && previous.scope_id !== scopeId) {
      throw new Error("A persisted Codex job cannot move to another conversation scope.");
    }
    if (previous && previous.activity_id !== activityId) {
      throw new Error("A persisted Codex job cannot move to another Activity.");
    }
    const agentId = job.agentId
      ? normalizeUuid(job.agentId, "job agentId")
      : previous?.agent_id || undefined;
    if (previous?.agent_id && agentId !== previous.agent_id) {
      throw new Error("A persisted Codex job cannot move to another Agent.");
    }
    if (agentId) {
      const agent = this.getAgent(agentId);
      if (!agent || agent.scopeId !== scopeId) {
        throw new Error("The persisted Codex job Agent belongs to another scope or does not exist.");
      }
    }
    const contextMode = job.contextMode ||
      (previous?.context_mode && isAgentContextMode(previous.context_mode)
        ? previous.context_mode
        : undefined);
    if (contextMode && !isAgentContextMode(contextMode)) throw new Error("Invalid job context mode.");
    let project = normalizeProjectIdentity(job.projectId, job.projectName);
    const previousProject = normalizeProjectIdentity(
      previous?.project_id || undefined,
      previous?.project_name || undefined
    );
    if (previousProject && project && previousProject.projectId !== project.projectId) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: A persisted Codex job cannot move to another project.`
      );
    }
    project = previousProject || project;
    const requestCollision = this.database
      .prepare(`
        SELECT job_id, archived_at FROM jobs
         WHERE scope_id = ? AND request_id = ? AND job_id <> ?
      `)
      .get(scopeId, job.requestId, job.jobId) as
      | { job_id: string; archived_at: number | null }
      | undefined;
    if (requestCollision) {
      throw new Error(
        requestCollision.archived_at
          ? "requestId belongs to an archived Codex job in this scope; its result body is no longer retained. Read codex_status query kind='request' for the terminal admission fact. A new logical turn requires a new requestId."
          : "requestId was already used by another Codex job in this scope."
      );
    }

    this.ensureScope(scopeId, job.updatedAt);
    let activity = this.getActivity(activityId);
    let activityCreated = false;
    if (!activity) {
      const projectCwd = project
        ? normalizeRequiredString(job.cwd, "project working directory", 4_000)
        : undefined;
      this.insertActivity({
        activityId,
        scopeId,
        ...project,
        ...(projectCwd ? { projectCwd } : {}),
        title: `Codex job ${job.jobId.slice(0, 8)}`,
        kind: "other",
        handoffPolicy: "none",
        completionTrigger: "manual",
        legacy: true,
        now: job.updatedAt
      });
      activity = this.requireActivity(activityId);
      activityCreated = true;
    } else if (activity.scopeId !== scopeId) {
      throw new Error("The requested Activity belongs to another conversation scope.");
    } else if (!previous && activity.lifecycle !== "open") {
      throw new Error("A new Codex job cannot be attached to a non-open Activity.");
    }

    let activityProject = this.getActivityProjectAdmission(activityId);
    if (activityProject && project && activityProject.projectId !== project.projectId) {
      throw new Error(
        `${PROJECT_CONTEXT_CONFLICT}: A Codex job must retain its Activity project.`
      );
    }
    if (!activityProject && project) {
      const projectCwd = normalizeRequiredString(job.cwd, "project working directory", 4_000);
      if (
        activity.counts.total > 0 &&
        !previous &&
        !this.activityJobsUseCwd(activityId, projectCwd)
      ) {
        throw new Error(
          `${PROJECT_CONTEXT_CONFLICT}: An Activity with admitted work cannot change projects.`
        );
      }
      this.database
        .prepare(`
          UPDATE activities
             SET project_id = ?, pinned_cwd = ?
           WHERE activity_id = ? AND project_id IS NULL
        `)
        .run(
          project.projectId,
          projectCwd,
          activityId
        );
      activityProject = this.getActivityProjectAdmission(activityId);
    }
    if (activityProject) {
      if (job.cwd !== undefined && job.cwd !== activityProject.projectCwd) {
        throw new Error(
          `${PROJECT_CONTEXT_CONFLICT}: A Codex job working folder must match its Activity project.`
        );
      }
      job.cwd = activityProject.projectCwd;
      project = {
        projectId: activityProject.projectId,
        projectName: activityProject.projectName
      };
    }

    const threadId = normalizeOptionalString(job.threadId || job.sessionDecision?.threadId);
    const wasTerminal = previous ? isTerminalActivityJobStatus(previous.status) : false;
    const nowTerminal = isTerminalActivityJobStatus(job.status);
    const terminalVersion = nowTerminal
      ? wasTerminal
        ? previous?.terminal_version || job.terminalVersion || 1
        : Math.max(previous?.terminal_version || 0, job.terminalVersion || 0) + 1
      : undefined;
    const backendKind = normalizeOptionalString(job.backendKind) || previous?.backend_kind || "mcp-server";
    const bridgeInstanceId = previous
      ? normalizeOptionalString(job.bridgeInstanceId) || previous.bridge_instance_id || undefined
      : normalizeOptionalString(job.bridgeInstanceId) || this.currentInstanceId;
    const cwd = normalizeOptionalString(job.cwd) || previous?.cwd || "/";
    const sandbox = job.sandbox === "read-only" || job.sandbox === "danger-full-access" || job.sandbox === "workspace-write"
      ? job.sandbox
      : previous?.sandbox || "workspace-write";
    const createdAt = finiteNumber(job.createdAt) ?? previous?.created_at ?? job.updatedAt;
    const jobVersion = Number.isInteger(job.version) && Number(job.version) >= 1
      ? Number(job.version)
      : previous?.job_version || 1;
    const lastProgressAt = finiteNumber(job.lastProgressAt) ?? previous?.last_progress_at ?? job.updatedAt;
    const lastProgress = job.lastProgress === undefined
      ? previous?.last_progress
        ? parseCurrentPayload({ payload: previous.last_progress }, "job progress")
        : undefined
      : job.lastProgress;
    job.activityId = activityId;
    job.scopeId = scopeId;
    job.threadId = threadId;
    job.backendKind = backendKind;
    job.agentId = agentId;
    job.contextMode = contextMode;
    job.projectId = project?.projectId;
    job.projectName = project?.projectName;
    job.cwd = cwd;
    job.sandbox = sandbox;
    job.createdAt = createdAt;
    job.version = jobVersion;
    job.lastProgressAt = lastProgressAt;
    job.lastProgress = lastProgress;
    job.bridgeInstanceId = bridgeInstanceId;
    job.terminalVersion = terminalVersion;

    this.database
      .prepare(`
        INSERT INTO jobs(
          job_id,scope_id,request_id,activity_id,thread_id,source_thread_id,status,
          backend_kind,bridge_instance_id,worker_id,worker_generation,upstream_request_id,
          terminal_version,agent_id,context_mode,cwd,sandbox,created_at,updated_at,archived_at,
          job_version,last_progress_at,last_progress,terminal_origin,cancellation_intent_id,payload
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)
        ON CONFLICT(job_id) DO UPDATE SET
          scope_id = excluded.scope_id,
          request_id = excluded.request_id,
          activity_id = excluded.activity_id,
          thread_id = excluded.thread_id,
          source_thread_id = excluded.source_thread_id,
          status = excluded.status,
          backend_kind = excluded.backend_kind,
          bridge_instance_id = excluded.bridge_instance_id,
          worker_id = excluded.worker_id,
          worker_generation = excluded.worker_generation,
          upstream_request_id = excluded.upstream_request_id,
          terminal_version = excluded.terminal_version,
          agent_id = excluded.agent_id,
          context_mode = excluded.context_mode,
          cwd = excluded.cwd,
          sandbox = excluded.sandbox,
          updated_at = excluded.updated_at,
          archived_at = NULL,
          job_version = excluded.job_version,
          last_progress_at = excluded.last_progress_at,
          last_progress = excluded.last_progress,
          terminal_origin = excluded.terminal_origin,
          cancellation_intent_id = excluded.cancellation_intent_id,
          payload = excluded.payload
      `)
      .run(
        job.jobId,
        scopeId,
        job.requestId,
        activityId,
        threadId || null,
        normalizeOptionalString(job.sourceThreadId) || previous?.source_thread_id || null,
        job.status,
        backendKind,
        bridgeInstanceId || null,
        normalizeOptionalString(job.workerId) || null,
        Number.isInteger(job.workerGeneration) ? job.workerGeneration : null,
        normalizeOptionalString(job.upstreamRequestId) || null,
        terminalVersion || null,
        agentId || null,
        contextMode || null,
        cwd,
        sandbox,
        createdAt,
        job.updatedAt,
        jobVersion,
        lastProgressAt,
        lastProgress === undefined ? null : JSON.stringify(lastProgress),
        terminalOrigin || null,
        cancellationIntentId || null,
        JSON.stringify(jobPayloadForStorage(job as Record<string, unknown>))
      );
    if (nowTerminal && !wasTerminal && terminalVersion) {
      this.insertJobCompletionDelivery({
        jobId: job.jobId,
        scopeId,
        terminalVersion,
        createdAt: job.updatedAt
      });
    }
    this.taskFollowups.admit({ ...job, activityId, agentId, scopeId });
    if (nowTerminal) this.mcpEvents.enqueue(job);
    this.replaceJobInteractions(job.jobId, job.pendingInteractions || []);

    const agentStateChanged = agentId
      ? this.syncAgentForJob(job, agentId, activityId, job.updatedAt)
      : false;
    this.threadConnections.recordJob(job, previous?.status);
    this.eventRetention.summarizeJob(job as unknown as Record<string, unknown>);
    const statusChanged = !previous || previous.status !== job.status;
    const threadChanged = (previous?.thread_id || undefined) !== threadId;
    const restoredFromArchive = Boolean(previous?.archived_at);
    if (!activityCreated && !statusChanged && !threadChanged && !restoredFromArchive && !agentStateChanged) return;

    const scopeVersion = this.nextScopeVersion(scopeId, job.updatedAt);
    if (activityCreated) {
      this.insertActivityEvent({
        activityId,
        scopeId,
        scopeVersion,
        eventType: "compatibility-activity-created",
        createdAt: job.updatedAt,
        payload: { jobId: job.jobId }
      });
    }
    const eventType = !previous
      ? "job-started"
      : statusChanged
        ? `job-${job.status}`
        : restoredFromArchive
          ? "job-retained-again"
          : "thread-linked";
    this.insertJobEvent({
      jobId: job.jobId,
      activityId,
      scopeId,
      scopeVersion,
      eventType,
      status: job.status,
      createdAt: job.updatedAt,
      payload: {
        threadLinked: Boolean(threadId),
        terminalVersion: terminalVersion || null,
        backendKind,
        agentId: agentId || null,
        contextMode: contextMode || null,
        terminalOrigin: terminalOrigin || null,
        cancellationIntentId: cancellationIntentId || null
      }
    });
    this.reconcileActivity(activityId, scopeVersion, job.updatedAt);
  }

  private syncAgentForJob(
    job: JobRowInput,
    agentId: string,
    activityId: string,
    now: number
  ): boolean {
    const agent = this.requireAgent(agentId);
    let lifecycle: BridgeAgentLifecycle;
    let currentJobId: string | undefined;
    let assignmentReleased = false;
    if (isActiveActivityJobStatus(job.status)) {
      const pending = (job as JobRowInput & { pendingInteractions?: unknown }).pendingInteractions;
      lifecycle = hasBlockingInteraction(pending) ? "waiting-input" : "active";
      currentJobId = job.jobId;
    } else {
      const active = this.database
        .prepare(`
          SELECT job_id,EXISTS(SELECT 1 FROM job_interactions interaction
            WHERE interaction.job_id=jobs.job_id AND interaction.is_blocking=1) AS has_blocking
            FROM jobs
           WHERE agent_id = ? AND archived_at IS NULL
             AND status IN ('running','terminating','termination-failed')
           ORDER BY updated_at DESC LIMIT 1
        `)
        .get(agentId) as { job_id: string; has_blocking: number } | undefined;
      if (active) {
        lifecycle = active.has_blocking
          ? "waiting-input"
          : "active";
        currentJobId = active.job_id;
      } else {
        lifecycle = agent.lifecycle === "orphaned" ? "orphaned" : "idle";
      }
      assignmentReleased = this.database
        .prepare(`
          UPDATE activity_agents SET released_at = COALESCE(released_at, ?)
           WHERE activity_id = ? AND agent_id = ? AND released_at IS NULL
        `)
        .run(now, activityId, agentId).changes > 0;
    }
    if (agent.lifecycle === lifecycle && agent.currentJobId === currentJobId) return assignmentReleased;
    this.database
      .prepare(`
        UPDATE agents SET lifecycle = ?, current_job_id = ?, version = version + 1, updated_at = ?
         WHERE agent_id = ?
      `)
      .run(lifecycle, currentJobId || null, now, agentId);
    return true;
  }

  private replaceJobInteractions(jobId: string, interactions: unknown[]): void {
    this.database.prepare("DELETE FROM job_interactions WHERE job_id=?").run(jobId);
    const insert = this.database.prepare(`INSERT INTO job_interactions(
      job_id,position,interaction_id,is_blocking,payload
    ) VALUES (?,?,?,?,?)`);
    for (const [position, interaction] of interactions.entries()) {
      if (!isRecord(interaction) || typeof interaction.interactionId !== "string" || !interaction.interactionId) {
        throw new Error("Invalid pending Codex interaction in durable job state.");
      }
      insert.run(
        jobId,
        position,
        interaction.interactionId,
        interaction.isBlocking === false ? 0 : 1,
        JSON.stringify(interactionPayloadForStorage(interaction))
      );
    }
  }

  private getJobProgressStorageRow(jobId: string): JobProgressStorageRow | undefined {
    return this.database.prepare(`SELECT job_id,request_id,activity_id,scope_id,status,agent_id
      FROM jobs WHERE job_id=? AND archived_at IS NULL`).get(jobId) as
      | JobProgressStorageRow
      | undefined;
  }

  private updateJobProgressStateInternal(
    jobId: string,
    state: JobProgressStateInput
  ): JobProgressUpdateResult {
    if (!Number.isFinite(state.updatedAt) || !Number.isFinite(state.lastProgressAt)) {
      throw new Error("Invalid Codex job progress timestamps.");
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new Error("Invalid Codex job progress version.");
    }
    if (!Array.isArray(state.pendingInteractions)) {
      throw new Error("Invalid Codex job pending interactions.");
    }
    const row = this.getJobProgressStorageRow(jobId);
    if (!row || !isActiveActivityJobStatus(row.status)) {
      throw new Error("Cannot update progress for an unknown or terminal Codex job.");
    }
    // Receiving fresh progress proves that a worker which previously failed to
    // terminate is running again. Infer this from durable state so a transient
    // write failure can be repaired by the next progress write.
    const resumedFromTerminationFailure = row.status === "termination-failed";
    const resumed = resumedFromTerminationFailure ? 1 : 0;
    const result = this.database.prepare(`
      UPDATE jobs
         SET updated_at=?,job_version=?,last_progress_at=?,last_progress=?,
             payload=CASE WHEN ?=1 AND status='termination-failed'
               THEN json_remove(payload,'$.error') ELSE payload END,
             status=CASE WHEN ?=1 AND status='termination-failed'
               THEN 'running' ELSE status END
       WHERE job_id=? AND archived_at IS NULL
         AND status IN ('running','terminating','termination-failed')
    `).run(
      state.updatedAt,
      state.version,
      state.lastProgressAt,
      state.lastProgress === undefined ? null : JSON.stringify(state.lastProgress),
      resumed,
      resumed,
      jobId
    );
    if (result.changes !== 1) {
      throw new Error("Cannot update progress for an unknown or terminal Codex job.");
    }
    this.replaceJobInteractions(jobId, state.pendingInteractions);
    const status = resumedFromTerminationFailure ? "running" : row.status;
    const agentStateChanged = row.agent_id
      ? this.syncAgentForJob({
          jobId,
          scopeId: row.scope_id,
          requestId: row.request_id,
          status,
          updatedAt: state.updatedAt,
          pendingInteractions: state.pendingInteractions
        }, row.agent_id, row.activity_id, state.updatedAt)
      : false;
    return { row, status, resumedFromTerminationFailure, agentStateChanged };
  }

  private reconcileActivity(activityId: string, scopeVersion: number, now: number): void {
    const before = this.requireActivity(activityId);
    const counts = this.countActivityJobs(activityId);
    const decision = deriveActivityBarrier(before, counts);
    const completionTransition =
      decision.completionChannel &&
      (before.lifecycle !== decision.lifecycle ||
        before.waitingOn !== decision.waitingOn ||
        before.verification !== decision.verification);
    const completionVersion = completionTransition
      ? before.completionVersion + 1
      : before.completionVersion;
    const completedAt = decision.lifecycle === "completed" ? before.completedAt || now : before.completedAt;
    this.database
      .prepare(`
        UPDATE activities
           SET lifecycle = ?, waiting_on = ?, verification = ?, version = version + 1,
               completion_version = ?, updated_at = ?, completed_at = ?,
               total_jobs = ?, running_jobs = ?, completed_jobs = ?, failed_jobs = ?,
               interrupted_jobs = ?, cancelled_jobs = ?, terminal_jobs = ?
         WHERE activity_id = ?
      `)
      .run(
        decision.lifecycle,
        decision.waitingOn,
        decision.verification,
        completionVersion,
        now,
        completedAt || null,
        counts.total,
        counts.running,
        counts.completed,
        counts.failed,
        counts.interrupted,
        counts.cancelled,
        counts.terminal,
        activityId
      );
    this.insertActivityEvent({
      activityId,
      scopeId: before.scopeId,
      scopeVersion,
      eventType: completionTransition
        ? decision.completionChannel === "verify"
          ? "verification-pending"
          : "activity-completed"
        : decision.attentionRequired
          ? "attention-required"
          : "child-jobs-changed",
      createdAt: now,
      payload: { counts, waitingOn: decision.waitingOn }
    });
    if (completionTransition && decision.completionChannel) {
      this.insertCompletionOutbox({
        activityId,
        scopeId: before.scopeId,
        completionVersion,
        channel: decision.completionChannel,
        createdAt: now,
        payload: {
          activityId,
          completionVersion,
          channel: decision.completionChannel,
          counts,
          requiresResultVerification: decision.completionChannel === "verify"
        }
      });
    }
  }

  private countActivityJobs(activityId: string): ActivityJobCounts {
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status IN ('running','terminating','termination-failed') THEN 1 ELSE 0 END) AS running,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
               SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
               SUM(CASE WHEN status IN ('completed','failed','interrupted','cancelled') THEN 1 ELSE 0 END) AS terminal
          FROM jobs WHERE activity_id = ?
      `)
      .get(activityId) as Record<string, number | null>;
    return {
      total: Number(row.total || 0),
      running: Number(row.running || 0),
      completed: Number(row.completed || 0),
      failed: Number(row.failed || 0),
      interrupted: Number(row.interrupted || 0),
      cancelled: Number(row.cancelled || 0),
      terminal: Number(row.terminal || 0)
    };
  }

  private activityJobsUseCwd(activityId: string, cwd: string): boolean {
    const rows = this.database
      .prepare("SELECT cwd FROM jobs WHERE activity_id = ? ORDER BY updated_at ASC")
      .all(activityId) as Array<{ cwd: string }>;
    return rows.length > 0 && rows.every((row) => row.cwd === cwd);
  }

  private insertActivity(input: {
    activityId: string;
    scopeId: string;
    continuationOfActivityId?: string;
    title: string;
    kind: ActivityKind;
    handoffPolicy: ActivityHandoffPolicy;
    completionTrigger: ActivityCompletionTrigger;
    legacy: boolean;
    now: number;
    updatedAt?: number;
    waitingOn?: BridgeActivity["waitingOn"];
    counts?: ActivityJobCounts;
  } & Partial<ActivityProjectAdmission>): void {
    const counts = input.counts || countsForSingleStatus(undefined);
    const project = normalizeActivityProjectAdmission(
      input.projectId,
      input.projectName,
      input.projectCwd
    );
    this.database.prepare(`
      INSERT INTO activities(
        activity_id,scope_id,project_id,pinned_cwd,continuation_of_activity_id,
        card_generation,title,kind,handoff_policy,completion_trigger,
        lifecycle,waiting_on,verification,version,completion_version,legacy,
        created_at,updated_at,sealed_at,completed_at,total_jobs,running_jobs,
        completed_jobs,failed_jobs,interrupted_jobs,cancelled_jobs,terminal_jobs
      ) VALUES (?,?,?,?,?,1,?,?,?,?,'open',?,'not-required',1,0,?,?,?,NULL,NULL,?,?,?,?,?,?,?)
    `).run(
      input.activityId,
      input.scopeId,
      project?.projectId || null,
      project?.projectCwd || null,
      input.continuationOfActivityId || null,
      canonicalActivityTitle(input.title),
      input.kind,
      input.handoffPolicy,
      input.completionTrigger,
      input.waitingOn || "none",
      input.legacy ? 1 : 0,
      input.now,
      input.updatedAt ?? input.now,
      counts.total,
      counts.running,
      counts.completed,
      counts.failed,
      counts.interrupted,
      counts.cancelled,
      counts.terminal
    );
  }

  private tableHasColumn(table: string, column: string): boolean {
    return (this.database.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .some((entry) => entry.name === column);
  }

  private touchActivity(
    activityId: string,
    scopeVersion: number,
    now: number,
    eventType: string,
    payload: unknown
  ): void {
    const activity = this.requireActivity(activityId);
    this.database
      .prepare("UPDATE activities SET version = version + 1, updated_at = ? WHERE activity_id = ?")
      .run(now, activityId);
    this.insertActivityEvent({
      activityId,
      scopeId: activity.scopeId,
      scopeVersion,
      eventType,
      createdAt: now,
      payload
    });
  }

  private ensureScope(scopeId: string, now: number): void {
    this.database
      .prepare(`
        INSERT INTO scopes(scope_id, version, created_at, updated_at) VALUES (?, 0, ?, ?)
        ON CONFLICT(scope_id) DO UPDATE SET updated_at = MAX(updated_at, excluded.updated_at)
      `)
      .run(scopeId, now, now);
  }

  private nextScopeVersion(scopeId: string, now: number): number {
    this.ensureScope(scopeId, now);
    this.database
      .prepare("UPDATE scopes SET version = version + 1, updated_at = ? WHERE scope_id = ?")
      .run(now, scopeId);
    return this.getScopeVersion(scopeId);
  }

  /** Runtime-only one-statement scope bump. Frozen migrations retain the
   * original nextScopeVersion implementation and checksum above. */
  private nextRuntimeScopeVersion(scopeId: string, now: number): number {
    const row = this.database.prepare(`
      INSERT INTO scopes(scope_id,version,created_at,updated_at)
      VALUES (?,1,?,?)
      ON CONFLICT(scope_id) DO UPDATE SET
        version=scopes.version+1,
        updated_at=MAX(scopes.updated_at,excluded.updated_at)
      RETURNING version
    `).get(scopeId, now, now) as {version:number} | undefined;
    if (!row) throw new Error("Could not advance the conversation scope version.");
    return Number(row.version);
  }

  private insertActivityEvent(input: Omit<ActivityEventRecord, "eventId">): void {
    this.database
      .prepare(`
        INSERT INTO activity_events(
          activity_id, scope_id, scope_version, event_type, created_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        input.scopeVersion,
        input.eventType,
        input.createdAt,
        JSON.stringify(input.payload)
      );
  }

  private insertJobEvent(input: Omit<JobEventRecord, "eventId">): void {
    const archived = Boolean((this.database.prepare("SELECT archived_at FROM jobs WHERE job_id=?").get(input.jobId) as {archived_at: number | null} | undefined)?.archived_at);
    // Earlier schema migrations create their initial events before v14's retention tables exist.
    const payload = this.eventRetention?.prepare(input, archived) ?? JSON.stringify(input.payload);
    this.database
      .prepare(`
        INSERT INTO job_events(
          job_id, activity_id, scope_id, scope_version, event_type, status, created_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.jobId,
        input.activityId,
        input.scopeId,
        input.scopeVersion,
        input.eventType,
        input.status,
        input.createdAt,
        payload
      );
    this.eventRetention?.enforce(input.jobId);
  }

  private assertCancellationTarget(scopeId: string, target: CancellationTarget): void {
    const activity = this.getActivity(target.activityId);
    if (!activity || activity.scopeId !== scopeId) {
      throw new Error("Cancellation target Activity is missing or belongs to another scope.");
    }
    if (target.kind === "activity") {
      if (target.jobId) throw new Error("An Activity cancellation target cannot include a job id.");
      return;
    }
    if (!target.jobId) throw new Error("A job cancellation target requires a job id.");
    const row = this.database
      .prepare(`
        SELECT scope_id, activity_id, agent_id, thread_id, upstream_request_id
          FROM jobs WHERE job_id = ? AND archived_at IS NULL
      `)
      .get(target.jobId) as
      | {
          scope_id: string;
          activity_id: string;
          agent_id: string | null;
          thread_id: string | null;
          upstream_request_id: string | null;
        }
      | undefined;
    if (!row || row.scope_id !== scopeId || row.activity_id !== target.activityId) {
      throw new Error("Cancellation target job is missing or does not match its Activity scope.");
    }
    if (target.agentId && row.agent_id !== target.agentId) {
      throw new Error("Cancellation target Agent no longer matches the job.");
    }
    if (target.threadId && row.thread_id !== target.threadId) {
      throw new Error("Cancellation target thread no longer matches the job.");
    }
    if (target.turnId && row.upstream_request_id !== target.turnId) {
      throw new Error("Cancellation target turn no longer matches the job.");
    }
  }

  private insertCancellationIntent(input: {
    intentId: string;
    scopeId: string;
    requestId: string;
    parentIntentId?: string;
    cascadeId: string;
    source: CancellationSource;
    toolName: string;
    actionName: string;
    target: CancellationTarget;
    expectedVersion: number;
    callerPresentation?: CancellationPresentation;
    widgetProof?: { instanceDigest: string; cardGeneration: number };
    callerRequestDigest?: string;
    reasonCode: string;
    now: number;
  }): void {
    this.database
      .prepare(`
        INSERT INTO cancellation_intents(
          intent_id, scope_id, request_id, parent_intent_id, cascade_id, source,
          tool_name, action_name, target_kind, target_job_id, target_activity_id,
          target_agent_id, target_thread_id, target_turn_id, target_presentation_id,
          expected_version, caller_presentation_kind, caller_presentation_id,
          widget_instance_present, widget_instance_digest, card_generation,
          caller_request_digest, bridge_instance_id, reason_code, status,
          created_at, dispatched_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, NULL, NULL)
      `)
      .run(
        input.intentId,
        input.scopeId,
        input.requestId,
        input.parentIntentId || null,
        input.cascadeId,
        input.source,
        input.toolName,
        input.actionName,
        input.target.kind,
        input.target.jobId || null,
        input.target.activityId,
        input.target.agentId || null,
        input.target.threadId || null,
        input.target.turnId || null,
        input.target.presentationId || null,
        input.expectedVersion,
        input.callerPresentation?.kind || null,
        input.callerPresentation?.activityPresentationId || null,
        input.widgetProof ? 1 : 0,
        input.widgetProof?.instanceDigest || null,
        input.widgetProof?.cardGeneration || null,
        input.callerRequestDigest || null,
        this.currentInstanceId,
        input.reasonCode,
        input.now
      );
  }

  private requireCancellationIntent(intentId: string): CancellationIntentRecord {
    const intent = this.getCancellationIntent(intentId);
    if (!intent) throw new Error("Unknown durable cancellation intent.");
    return intent;
  }

  private recordCancellationIntentEvent(
    intent: CancellationIntentRecord,
    eventType: string,
    now: number
  ): void {
    const scopeVersion = this.nextScopeVersion(intent.scopeId, now);
    const operation = this.getCancellationOperation(intent.scopeId, intent.requestId);
    const payload = {
      cancellationIntentId: intent.intentId,
      cancellationRequestId: intent.requestId,
      source: intent.source,
      tool: intent.toolName,
      action: intent.actionName,
      reasonCode: intent.reasonCode,
      reason: operation?.reason || null,
      expectedVersion: intent.expectedVersion,
      parentIntentId: intent.parentIntentId || null,
      cascadeId: intent.cascadeId,
      callerPresentation: intent.callerPresentation || null,
      targetPresentationId: intent.targetPresentationId || null,
      widgetInstancePresent: intent.widgetInstancePresent,
      cardGeneration: intent.cardGeneration || null,
      bridgeInstanceId: intent.bridgeInstanceId
    };
    if (intent.targetKind === "job" && intent.targetJobId) {
      const row = this.database
        .prepare("SELECT status FROM jobs WHERE job_id = ?")
        .get(intent.targetJobId) as { status: string } | undefined;
      if (!row) throw new Error("Cancellation intent job disappeared before audit recording.");
      this.insertJobEvent({
        jobId: intent.targetJobId,
        activityId: intent.targetActivityId,
        scopeId: intent.scopeId,
        scopeVersion,
        eventType,
        status: row.status,
        createdAt: now,
        payload
      });
      return;
    }
    this.insertActivityEvent({
      activityId: intent.targetActivityId,
      scopeId: intent.scopeId,
      scopeVersion,
      eventType,
      createdAt: now,
      payload
    });
  }

  private insertCompletionOutbox(input: {
    activityId: string;
    scopeId: string;
    completionVersion: number;
    channel: "notify" | "verify";
    createdAt: number;
    payload: unknown;
  }): void {
    this.database
      .prepare(`
        INSERT OR IGNORE INTO completion_outbox(
          activity_id, scope_id, completion_version, channel, payload, attempt_count,
          next_attempt_at, lease_owner, lease_expires_at, delivered_at, acknowledged_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?)
      `)
      .run(
        input.activityId,
        input.scopeId,
        input.completionVersion,
        input.channel,
        JSON.stringify(input.payload),
        input.createdAt
      );
  }

  private insertJobCompletionDelivery(input: {
    jobId: string;
    scopeId: string;
    terminalVersion: number;
    createdAt: number;
  }): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO job_completion_deliveries(
        job_id,scope_id,terminal_version,receipt,state,attempt_count,next_attempt_at,
        lease_owner,lease_expires_at,last_host_rejected_at,last_host_error,
        host_accepted_at,acceptance_unknown_at,result_read_at,created_at,updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      input.jobId,
      input.scopeId,
      input.terminalVersion,
      jobCompletionReceipt(input.scopeId, input.jobId, input.terminalVersion),
      input.createdAt,
      input.createdAt
    );
  }

  private finishJobCompletionLease(
    input: {
      jobId: string;
      scopeId: string;
      receipt: string;
      leaseOwner: string;
      now?: number;
    },
    state: "host-accepted" | "acceptance-unknown"
  ): JobCompletionDeliveryRecord {
    const now = normalizeEventTimestamp(input.now ?? Date.now());
    const jobId = normalizeUuid(input.jobId, "completion delivery jobId");
    const scopeId = normalizeUuid(input.scopeId, "completion delivery scopeId");
    const receipt = normalizeJobCompletionReceipt(input.receipt);
    const owner = normalizeUuid(input.leaseOwner, "completion delivery leaseOwner");
    return this.transaction(() => {
      const current = this.getJobCompletionDelivery(jobId, scopeId);
      if (!current || current.receipt !== receipt) {
        throw new Error("COMPLETION_DELIVERY_UNAVAILABLE: Exact completion delivery is unavailable.");
      }
      if (current.state === "result-read" || current.state === state) return current;
      if (current.state !== "leased" || current.leaseOwner !== owner) {
        throw new Error("COMPLETION_LEASE_MISMATCH: Completion delivery lease is missing or owned by another card.");
      }
      if (state === "host-accepted") {
        this.database.prepare(`
          UPDATE job_completion_deliveries
             SET state='host-accepted', next_attempt_at=NULL, lease_owner=NULL,
                 lease_expires_at=NULL, host_accepted_at=COALESCE(host_accepted_at,?), updated_at=?
           WHERE job_id=? AND scope_id=? AND receipt=? AND state='leased' AND lease_owner=?
        `).run(now, now, jobId, scopeId, receipt, owner);
      } else {
        this.database.prepare(`
          UPDATE job_completion_deliveries
             SET state='acceptance-unknown', next_attempt_at=NULL, lease_owner=NULL,
                 lease_expires_at=NULL,
                 acceptance_unknown_at=COALESCE(acceptance_unknown_at,?), updated_at=?
           WHERE job_id=? AND scope_id=? AND receipt=? AND state='leased' AND lease_owner=?
        `).run(now, now, jobId, scopeId, receipt, owner);
      }
      return this.requireJobCompletionDelivery(jobId, scopeId);
    });
  }

  private requireJobCompletionDelivery(
    jobId: string,
    scopeId: string
  ): JobCompletionDeliveryRecord {
    const record = this.getJobCompletionDelivery(jobId, scopeId);
    if (!record) {
      throw new Error("COMPLETION_DELIVERY_UNAVAILABLE: Exact completion delivery is unavailable.");
    }
    return record;
  }

  private getActivityRow(activityId: string): ActivityStorageRow | undefined {
    return this.database
      .prepare(`SELECT a.*,p.name AS project_name FROM activities a
        LEFT JOIN projects p ON p.project_id=a.project_id WHERE a.activity_id = ?`)
      .get(activityId) as ActivityStorageRow | undefined;
  }

  private requireAgent(agentId: string): BridgeAgent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("Unknown Agent id in this conversation scope.");
    return agent;
  }

  private requireActivity(activityId: string): BridgeActivity {
    const activity = this.getActivity(activityId);
    if (!activity) throw new Error("Unknown Activity id.");
    return activity;
  }

  private requireMutableActivity(activityId: string, target: string): BridgeActivity {
    const activity = this.requireActivity(activityId);
    if (
      activity.lifecycle === "completed" ||
      activity.lifecycle === "cancelled" ||
      activity.lifecycle === "abandoned"
    ) {
      throw new Error(
        `A ${activity.lifecycle} Activity cannot transition to ${target}. Create a new Activity instead.`
      );
    }
    return activity;
  }

  private assertNoRunningJobs(activity: BridgeActivity, action: string): void {
    if (activity.counts.running > 0) {
      throw new Error(`Cannot ${action} an Activity while ${activity.counts.running} child job(s) are running.`);
    }
  }

  private assertEvidenceJobsBelongToActivity(activityId: string, jobIds: string[]): void {
    const lookup = this.database.prepare("SELECT activity_id FROM jobs WHERE job_id = ?");
    for (const jobId of jobIds) {
      const row = lookup.get(jobId) as { activity_id: string } | undefined;
      if (!row || row.activity_id !== activityId) {
        throw new Error(`Verification evidence job '${jobId}' is not a child of this Activity.`);
      }
    }
  }

  private transitionActivityTerminal(
    activity: BridgeActivity,
    lifecycle: "cancelled" | "abandoned",
    eventType: string,
    payload: unknown,
    now: number
  ): BridgeActivity {
    const scopeVersion = this.nextScopeVersion(activity.scopeId, now);
    this.database
      .prepare(`
        UPDATE activities
           SET lifecycle = ?, waiting_on = 'none', verification = 'not-required',
               version = version + 1, updated_at = ?
         WHERE activity_id = ?
      `)
      .run(lifecycle, now, activity.activityId);
    this.insertActivityEvent({
      activityId: activity.activityId,
      scopeId: activity.scopeId,
      scopeVersion,
      eventType,
      createdAt: now,
      payload
    });
    this.acknowledgeCompletionOutbox(activity.activityId, undefined, now);
    return this.requireActivity(activity.activityId);
  }

  private acknowledgeCompletionOutbox(
    activityId: string,
    channel: "notify" | "verify" | undefined,
    now: number
  ): void {
    if (channel) {
      this.database
        .prepare(`
          UPDATE completion_outbox
             SET acknowledged_at = COALESCE(acknowledged_at, ?)
           WHERE activity_id = ? AND channel = ? AND acknowledged_at IS NULL
        `)
        .run(now, activityId, channel);
      return;
    }
    this.database
      .prepare(`
        UPDATE completion_outbox
           SET acknowledged_at = COALESCE(acknowledged_at, ?)
         WHERE activity_id = ? AND acknowledged_at IS NULL
      `)
      .run(now, activityId);
  }

  private enforcePrivateFileModes(): void {
    if (this.options.file === ":memory:") return;
    const databaseFile = this.databaseLease?.databaseFile ?? this.options.file;
    for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }
}

type NormalizedCancellationOperationInput = Omit<BeginCancellationOperationInput, "now"> & {
  now: number;
};

type NormalizedCancellationIntentInput = Omit<CreateCancellationIntentInput, "now"> & {
  now: number;
};

function normalizeCancellationOperationInput(
  input: BeginCancellationOperationInput
): NormalizedCancellationOperationInput {
  return {
    scopeId: normalizeUuid(input.scopeId, "cancellation scopeId"),
    requestId: normalizeUuid(input.requestId, "cancellation requestId"),
    actionHash: normalizeDigest(input.actionHash, "cancellation actionHash"),
    source: normalizeCancellationSource(input.source),
    toolName: normalizeRequiredString(input.toolName, "cancellation tool name", 100),
    actionName: normalizeRequiredString(input.actionName, "cancellation action name", 100),
    target: normalizeCancellationTarget(input.target),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion),
    callerPresentation: normalizeCancellationPresentation(input.callerPresentation),
    widgetProof: normalizeCancellationWidgetProof(input.widgetProof),
    callerRequestDigest: normalizeOptionalDigest(input.callerRequestDigest),
    reasonCode: normalizeReasonCode(input.reasonCode),
    reason: normalizeOptionalBoundedText(input.reason, CANCELLATION_REASON_MAX_LENGTH),
    now: normalizeEventTimestamp(input.now ?? Date.now())
  };
}

function normalizeCancellationIntentInput(
  input: CreateCancellationIntentInput
): NormalizedCancellationIntentInput {
  return {
    scopeId: normalizeUuid(input.scopeId, "cancellation scopeId"),
    requestId: normalizeUuid(input.requestId, "cancellation requestId"),
    parentIntentId: normalizeUuid(input.parentIntentId, "parent cancellation intentId"),
    cascadeId: normalizeUuid(input.cascadeId, "cancellation cascadeId"),
    source: normalizeCancellationSource(input.source),
    toolName: normalizeRequiredString(input.toolName, "cancellation tool name", 100),
    actionName: normalizeRequiredString(input.actionName, "cancellation action name", 100),
    target: normalizeCancellationTarget(input.target),
    expectedVersion: normalizeExpectedVersion(input.expectedVersion),
    callerPresentation: normalizeCancellationPresentation(input.callerPresentation),
    widgetProof: normalizeCancellationWidgetProof(input.widgetProof),
    callerRequestDigest: normalizeOptionalDigest(input.callerRequestDigest),
    reasonCode: normalizeReasonCode(input.reasonCode),
    now: normalizeEventTimestamp(input.now ?? Date.now())
  };
}

function normalizeCancellationSource(source: CancellationSource): CancellationSource {
  if (!CANCELLATION_SOURCES.includes(source)) throw new Error("Unsupported cancellation source.");
  return source;
}

function normalizeCancellationTarget(target: CancellationTarget): CancellationTarget {
  if (target.kind !== "job" && target.kind !== "activity") {
    throw new Error("Unsupported cancellation target kind.");
  }
  const jobId = target.jobId
    ? normalizeRequiredString(target.jobId, "cancellation target jobId", 200)
    : undefined;
  if ((target.kind === "job") !== Boolean(jobId)) {
    throw new Error("Cancellation target kind and job id do not match.");
  }
  return {
    kind: target.kind,
    ...(jobId ? { jobId } : {}),
    activityId: normalizeUuid(target.activityId, "cancellation target activityId"),
    ...(target.agentId
      ? { agentId: normalizeUuid(target.agentId, "cancellation target agentId") }
      : {}),
    ...(target.threadId
      ? { threadId: normalizeRequiredString(target.threadId, "cancellation target threadId", 200) }
      : {}),
    ...(target.turnId
      ? { turnId: normalizeRequiredString(target.turnId, "cancellation target turnId", 200) }
      : {}),
    ...(target.presentationId
      ? {
          presentationId: normalizeUuid(
            target.presentationId,
            "cancellation target presentationId"
          )
        }
      : {})
  };
}

function normalizeCancellationPresentation(
  presentation: CancellationPresentation | undefined
): CancellationPresentation | undefined {
  if (!presentation) return undefined;
  if (presentation.kind === "explicit") {
    if (presentation.activityPresentationId) {
      throw new Error("An explicit caller presentation cannot include an automatic presentation id.");
    }
    return { kind: "explicit" };
  }
  if (presentation.kind !== "automatic" || !presentation.activityPresentationId) {
    throw new Error("An automatic caller presentation requires an exact presentation id.");
  }
  return {
    kind: "automatic",
    activityPresentationId: normalizeUuid(
      presentation.activityPresentationId,
      "caller activityPresentationId"
    )
  };
}

function normalizeCancellationWidgetProof(
  proof: { instanceDigest: string; cardGeneration: number } | undefined
): { instanceDigest: string; cardGeneration: number } | undefined {
  if (!proof) return undefined;
  if (!Number.isInteger(proof.cardGeneration) || proof.cardGeneration < 1) {
    throw new Error("Cancellation card generation must be a positive integer.");
  }
  return {
    instanceDigest: normalizeDigest(proof.instanceDigest, "widget instance digest"),
    cardGeneration: proof.cardGeneration
  };
}

function normalizeExpectedVersion(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("expectedVersion must be a positive integer.");
  }
  return value;
}

function normalizeReasonCode(value: string): string {
  if (!CANCELLATION_REASON_CODE_PATTERN.test(value)) {
    throw new Error("Cancellation/observation reasonCode must be a bounded stable code.");
  }
  return value;
}

function normalizeDigest(value: string, label: string): string {
  const normalized = normalizeRequiredString(value, label, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a SHA-256 digest.`);
  return normalized;
}

function normalizeOptionalDigest(value: string | undefined): string | undefined {
  return value ? normalizeDigest(value, "caller request digest") : undefined;
}

function normalizeEventTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid state-event timestamp.");
  return value;
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function readSteeringDeliveryRow(row: Record<string, unknown>): SteeringDeliveryRecord {
  const status = row.status as SteeringDeliveryStatus;
  if (!STEERING_DELIVERY_STATUSES.includes(status)) {
    throw new Error(`Invalid persisted steering delivery status: ${String(row.status)}.`);
  }
  return {
    scopeId: String(row.scope_id),
    requestId: String(row.request_id),
    actionHash: String(row.action_hash),
    jobId: String(row.job_id),
    expectedJobVersion: Number(row.expected_job_version),
    promptSha256: String(row.prompt_sha256),
    status,
    bridgeInstanceId: String(row.bridge_instance_id),
    result: row.result
      ? parseCurrentPayload({ payload: String(row.result) }, "steering delivery result")
      : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined
      ? undefined
      : Number(row.dispatched_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? undefined
      : Number(row.completed_at)
  };
}

function readCancellationOperationRow(row: Record<string, unknown>): CancellationOperationRecord {
  return {
    scopeId: String(row.scope_id),
    requestId: String(row.request_id),
    rootIntentId: String(row.root_intent_id),
    actionHash: String(row.action_hash),
    source: row.source as CancellationSource,
    toolName: String(row.tool_name),
    actionName: String(row.action_name),
    targetKind: row.target_kind as CancellationOperationRecord["targetKind"],
    targetJobId: row.target_job_id ? String(row.target_job_id) : undefined,
    targetActivityId: String(row.target_activity_id),
    targetAgentId: row.target_agent_id ? String(row.target_agent_id) : undefined,
    targetThreadId: row.target_thread_id ? String(row.target_thread_id) : undefined,
    targetTurnId: row.target_turn_id ? String(row.target_turn_id) : undefined,
    targetPresentationId: row.target_presentation_id
      ? String(row.target_presentation_id)
      : undefined,
    expectedVersion: Number(row.expected_version),
    callerPresentation: readCancellationPresentationRow(row),
    widgetInstancePresent: Number(row.widget_instance_present) === 1,
    widgetInstanceDigest: row.widget_instance_digest
      ? String(row.widget_instance_digest)
      : undefined,
    cardGeneration: row.card_generation === null || row.card_generation === undefined
      ? undefined
      : Number(row.card_generation),
    callerRequestDigest: row.caller_request_digest
      ? String(row.caller_request_digest)
      : undefined,
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    reason: row.reason_text ? String(row.reason_text) : undefined,
    status: row.status as CancellationOperationStatus,
    result: row.result
      ? parseCurrentPayload({ payload: String(row.result) }, "cancellation operation result")
      : undefined,
    createdAt: Number(row.created_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? undefined
      : Number(row.completed_at)
  };
}

function readCancellationIntentRow(row: Record<string, unknown>): CancellationIntentRecord {
  return {
    intentId: String(row.intent_id),
    scopeId: String(row.scope_id),
    requestId: String(row.request_id),
    parentIntentId: row.parent_intent_id ? String(row.parent_intent_id) : undefined,
    cascadeId: String(row.cascade_id),
    source: row.source as CancellationSource,
    toolName: String(row.tool_name),
    actionName: String(row.action_name),
    targetKind: row.target_kind as CancellationIntentRecord["targetKind"],
    targetJobId: row.target_job_id ? String(row.target_job_id) : undefined,
    targetActivityId: String(row.target_activity_id),
    targetAgentId: row.target_agent_id ? String(row.target_agent_id) : undefined,
    targetThreadId: row.target_thread_id ? String(row.target_thread_id) : undefined,
    targetTurnId: row.target_turn_id ? String(row.target_turn_id) : undefined,
    targetPresentationId: row.target_presentation_id
      ? String(row.target_presentation_id)
      : undefined,
    expectedVersion: Number(row.expected_version),
    callerPresentation: readCancellationPresentationRow(row),
    widgetInstancePresent: Number(row.widget_instance_present) === 1,
    widgetInstanceDigest: row.widget_instance_digest
      ? String(row.widget_instance_digest)
      : undefined,
    cardGeneration: row.card_generation === null || row.card_generation === undefined
      ? undefined
      : Number(row.card_generation),
    callerRequestDigest: row.caller_request_digest
      ? String(row.caller_request_digest)
      : undefined,
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    status: row.status as CancellationIntentStatus,
    createdAt: Number(row.created_at),
    dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined
      ? undefined
      : Number(row.dispatched_at),
    completedAt: row.completed_at === null || row.completed_at === undefined
      ? undefined
      : Number(row.completed_at)
  };
}

function readCancellationPresentationRow(
  row: Record<string, unknown>
): CancellationPresentation | undefined {
  if (row.caller_presentation_kind === "explicit") return { kind: "explicit" };
  if (row.caller_presentation_kind === "automatic" && row.caller_presentation_id) {
    return {
      kind: "automatic",
      activityPresentationId: String(row.caller_presentation_id)
    };
  }
  return undefined;
}

function readTransportObservationRow(row: Record<string, unknown>): TransportObservationRecord {
  return {
    observationId: Number(row.observation_id),
    kind: row.kind as TransportObservationKind,
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    jobId: row.job_id ? String(row.job_id) : undefined,
    activityId: row.activity_id ? String(row.activity_id) : undefined,
    toolName: row.tool_name ? String(row.tool_name) : undefined,
    callerRequestDigest: row.caller_request_digest
      ? String(row.caller_request_digest)
      : undefined,
    bridgeInstanceId: String(row.bridge_instance_id),
    reasonCode: String(row.reason_code),
    createdAt: Number(row.created_at)
  };
}

function readProjectStorageRow(row: ProjectStorageRow): ProjectTarget {
  const id = normalizeProjectId(row.project_id);
  const projectRef = normalizeProjectRef(row.project_ref);
  if (!Number.isInteger(row.project_revision) || row.project_revision < 1) {
    throw new Error(`${PROJECT_REGISTRY_CHANGED}: Stored project revision is invalid.`);
  }
  const name = normalizeProjectName(row.name);
  const nameKey = projectNameKey(name);
  if (row.name_key !== nameKey) {
    throw new Error(`${PROJECT_NAME_CONFLICT}: Stored project name key is not canonical.`);
  }
  return {
    id,
    projectRef,
    projectRevision: row.project_revision,
    name,
    nameKey,
    cwd: row.cwd,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at })
  };
}

function hydrateJobPayload(row: JobStorageRow): StoredJobRecord {
  const payload = parseCurrentPayload(row, "job");
  if (!isRecord(payload)) throw new Error("Invalid job payload in the bridge state database: expected an object.");
  return {
    ...payload,
    jobId: row.job_id,
    scopeId: row.scope_id,
    requestId: row.request_id,
    activityId: row.activity_id,
    threadId: row.thread_id || undefined,
    sourceThreadId: row.source_thread_id || undefined,
    status: row.status,
    backendKind: row.backend_kind,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.project_name ? { projectName: row.project_name } : {}),
    cwd: row.cwd,
    sandbox: row.sandbox,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.job_version,
    lastProgressAt: row.last_progress_at,
    ...(row.last_progress
      ? { lastProgress: parseCurrentPayload({ payload: row.last_progress }, "job progress") }
      : {}),
    publicEvents: parseStoredJson(row.public_events, "job public events"),
    pendingInteractions: parseStoredJson(row.pending_interactions, "job pending interactions"),
    ...(row.terminal_origin ? { terminalOrigin: row.terminal_origin } : {}),
    ...(row.cancellation_intent_id
      ? { cancellationIntentId: row.cancellation_intent_id }
      : {}),
    bridgeInstanceId: row.bridge_instance_id || undefined,
    workerId: row.worker_id || undefined,
    workerGeneration: row.worker_generation ?? undefined,
    upstreamRequestId: row.upstream_request_id || undefined,
    terminalVersion: row.terminal_version ?? undefined,
    agentId: row.agent_id || undefined,
    contextMode: isAgentContextMode(row.context_mode) ? row.context_mode : undefined
  };
}

function readActivityRow(row: ActivityStorageRow): BridgeActivity {
  if (
    !valueIsOneOf(ACTIVITY_KINDS, row.kind) ||
    !valueIsOneOf(ACTIVITY_HANDOFF_POLICIES, row.handoff_policy) ||
    !valueIsOneOf(ACTIVITY_COMPLETION_TRIGGERS, row.completion_trigger) ||
    !valueIsOneOf(ACTIVITY_LIFECYCLES, row.lifecycle) ||
    !valueIsOneOf(ACTIVITY_WAITING_ON, row.waiting_on) ||
    !valueIsOneOf(ACTIVITY_VERIFICATION_STATES, row.verification)
  ) {
    throw new Error(`Invalid Activity row in the bridge state database: ${row.activity_id}.`);
  }
  return {
    activityId: row.activity_id,
    scopeId: row.scope_id,
    projectId: row.project_id || undefined,
    projectName: row.project_name || undefined,
    continuationOfActivityId: row.continuation_of_activity_id || undefined,
    cardGeneration: row.card_generation,
    title: row.title,
    kind: row.kind,
    handoffPolicy: row.handoff_policy,
    completionTrigger: row.completion_trigger,
    lifecycle: row.lifecycle,
    waitingOn: row.waiting_on,
    verification: row.verification as ActivityVerificationState,
    version: row.version,
    completionVersion: row.completion_version,
    legacy: row.legacy === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sealedAt: row.sealed_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    counts: {
      total: row.total_jobs,
      running: row.running_jobs,
      completed: row.completed_jobs,
      failed: row.failed_jobs,
      interrupted: row.interrupted_jobs,
      cancelled: row.cancelled_jobs,
      terminal: row.terminal_jobs
    }
  };
}

function readAgentRow(row: AgentStorageRow): BridgeAgent {
  if (!isAgentLifecycle(row.lifecycle)) {
    throw new Error(`Invalid Agent lifecycle in bridge state: ${row.agent_id}.`);
  }
  return {
    agentId: row.agent_id,
    scopeId: row.scope_id,
    agentName: row.agent_name,
    normalizedName: row.normalized_name,
    lifecycle: row.lifecycle,
    currentThreadId: row.current_thread_id || undefined,
    currentJobId: row.current_job_id || undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orphanedReason: row.orphaned_reason || undefined
  };
}

function readAgentThreadRow(row: AgentThreadStorageRow): BridgeAgentThread {
  if (!isAgentContextMode(row.context_mode)) {
    throw new Error(`Invalid Agent thread context mode: ${row.thread_id}.`);
  }
  return {
    threadId: row.thread_id,
    sessionId: row.session_id || undefined,
    agentId: row.agent_id,
    scopeId: row.scope_id,
    projectId: row.project_id || undefined,
    projectName: row.project_name || undefined,
    backendKind: row.backend_kind,
    cwd: row.cwd,
    sandbox: row.sandbox,
    contextMode: row.context_mode,
    isCurrent: row.is_current === 1,
    linkedAt: row.linked_at,
    replacedAt: row.replaced_at ?? undefined,
    forkedFromThreadId: row.forked_from_thread_id || undefined
  };
}

function readActivityProjectAdmission(
  row: Pick<
    ActivityStorageRow,
    "activity_id" | "project_id" | "project_name" | "pinned_cwd"
  >
): ActivityProjectAdmission | undefined {
  const values = [row.project_id, row.project_name, row.pinned_cwd];
  if (values.every((value) => value === null)) return undefined;
  if (values.some((value) => value === null)) {
    throw new Error(`Incomplete Activity project admission metadata: ${row.activity_id}.`);
  }
  return normalizeActivityProjectAdmission(
    row.project_id as string,
    row.project_name as string,
    row.pinned_cwd as string
  );
}

function readThreadProjectIdentity(
  row: Pick<
    AgentThreadStorageRow,
    "thread_id" | "project_id" | "project_name"
  >
): { projectId: string; projectName: string } | undefined {
  try {
    return normalizeProjectIdentity(
      row.project_id || undefined,
      row.project_name || undefined
    );
  } catch (error) {
    throw new Error(
      `Invalid Agent thread project metadata: ${row.thread_id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function readActivityAgentRow(row: ActivityAgentStorageRow): ActivityAgentAssignment {
  if (!isAgentContextMode(row.context_mode)) {
    throw new Error(`Invalid Activity Agent context mode: ${row.assignment_id}.`);
  }
  return {
    assignmentId: row.assignment_id,
    activityId: row.activity_id,
    agentId: row.agent_id,
    role: row.role,
    contextMode: row.context_mode,
    assignedAt: row.assigned_at,
    releasedAt: row.released_at ?? undefined
  };
}

function assertActivityPolicy(
  kind: unknown,
  handoffPolicy: unknown,
  completionTrigger: unknown
): void {
  if (!valueIsOneOf(ACTIVITY_KINDS, kind)) throw new Error("Invalid Activity kind.");
  if (!valueIsOneOf(ACTIVITY_HANDOFF_POLICIES, handoffPolicy)) {
    throw new Error("Invalid Activity handoff policy.");
  }
  if (!valueIsOneOf(ACTIVITY_COMPLETION_TRIGGERS, completionTrigger)) {
    throw new Error("Invalid Activity completion trigger.");
  }
}

function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`${label} must be a UUID.`);
  return normalized;
}

export function normalizeActivityTitle(value: string): string {
  // Kept byte-for-byte compatible for callers that need historical activity
  // behavior. New writes use canonicalActivityTitle below.
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Activity title cannot be empty.");
  return normalized.slice(0, 120);
}

/** Current-write policy for a human-visible activity title. */
export function canonicalActivityTitle(value: string): string {
  try {
    return canonicalHumanText(value, {
      field: "Activity title",
      maxCharacters: 120,
      collapseWhitespace: true,
      trim: true
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds")) {
      throw new Error("Activity title cannot exceed 120 characters.");
    }
    throw new Error("Activity title cannot be empty.");
  }
}

function normalizeVerificationEvidence(
  evidence: ActivityVerificationEvidence
): ActivityVerificationEvidence {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("Verification evidence is required.");
  }
  const summary = normalizeRequiredBoundedText(evidence.summary, "Verification evidence summary", 1_000);
  return {
    summary,
    ...normalizeEvidenceList("jobIds", evidence.jobIds, 30, 200),
    ...normalizeEvidenceList("tests", evidence.tests, 20, 300),
    ...normalizeEvidenceList("artifacts", evidence.artifacts, 20, 500),
    ...normalizeEvidenceList("references", evidence.references, 20, 500)
  };
}

function normalizeEvidenceList<K extends keyof ActivityVerificationEvidence>(
  key: K,
  values: string[] | undefined,
  maxItems: number,
  maxLength: number
): Pick<ActivityVerificationEvidence, K> | Record<string, never> {
  if (values === undefined) return {};
  if (!Array.isArray(values) || values.length > maxItems) {
    throw new Error(`Verification evidence ${key} must contain at most ${maxItems} items.`);
  }
  const normalized = values.map((value) =>
    normalizeRequiredBoundedText(value, `Verification evidence ${key} item`, maxLength)
  );
  return { [key]: normalized } as Pick<ActivityVerificationEvidence, K>;
}

function normalizeRequiredBoundedText(value: string, label: string, maxLength: number): string {
  const normalized = normalizeOptionalBoundedText(value, maxLength);
  if (!normalized) throw new Error(`${label} cannot be empty.`);
  return normalized;
}

function normalizeOptionalBoundedText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = canonicalHumanText(value, {
    field: "Text",
    allowEmpty: true,
    maxCharacters: maxLength,
    collapseWhitespace: true,
    trim: true
  });
  if (!normalized) return undefined;
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeRequiredString(value: unknown, label: string, maximum: number): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.length > maximum || /[\r\n]/.test(normalized)) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function normalizeProjectIdentity(
  projectId: string | undefined,
  projectName: string | undefined
): { projectId: string; projectName: string } | undefined {
  if (projectId === undefined && projectName === undefined) return undefined;
  if (projectId === undefined || projectName === undefined) {
    throw new Error("Project admission metadata requires both projectId and projectName.");
  }
  return {
    projectId: normalizeProjectId(projectId),
    projectName: normalizeProjectName(projectName)
  };
}

function normalizeActivityProjectAdmission(
  projectId: string | undefined,
  projectName: string | undefined,
  projectCwd: string | undefined
): ActivityProjectAdmission | undefined {
  const identity = normalizeProjectIdentity(projectId, projectName);
  if (!identity && projectCwd === undefined) return undefined;
  if (!identity || projectCwd === undefined) {
    throw new Error(
      "Activity project admission metadata requires projectId, projectName, and projectCwd."
    );
  }
  if (
    !path.isAbsolute(projectCwd) ||
    projectCwd.length > 4_000 ||
    /[\r\n\0]/u.test(projectCwd)
  ) {
    throw new Error("Invalid Activity project working directory.");
  }
  return { ...identity, projectCwd: path.normalize(projectCwd) };
}

function stableUuid(namespace: string, ...parts: string[]): string {
  const hex = createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function normalizeEventType(value: string): string {
  const normalized = value.trim().slice(0, 120);
  if (!normalized || !/^[a-z0-9][a-z0-9._:-]*$/i.test(normalized)) {
    throw new Error("Invalid job telemetry event type.");
  }
  return normalized;
}

function readCompletionOutboxRow(row: Record<string, unknown>): CompletionOutboxRecord {
  return {
    outboxId: Number(row.outbox_id),
    activityId: String(row.activity_id),
    scopeId: String(row.scope_id),
    completionVersion: Number(row.completion_version),
    channel: row.channel as "notify" | "verify",
    payload: parseCurrentPayload({ payload: String(row.payload) }, "completion outbox"),
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: optionalNumber(row.next_attempt_at),
    leaseOwner: optionalString(row.lease_owner),
    leaseExpiresAt: optionalNumber(row.lease_expires_at),
    deliveredAt: optionalNumber(row.delivered_at),
    acknowledgedAt: optionalNumber(row.acknowledged_at),
    createdAt: Number(row.created_at)
  };
}

function readJobCompletionDeliveryRow(
  row: Record<string, unknown>
): JobCompletionDeliveryRecord {
  const state = String(row.state);
  if (!valueIsOneOf(JOB_COMPLETION_DELIVERY_STATES, state)) {
    throw new Error("Invalid stored Job completion delivery state.");
  }
  const resultReadSource = optionalString(row.result_read_source);
  if (
    resultReadSource !== undefined &&
    !valueIsOneOf(JOB_COMPLETION_RESULT_READ_SOURCES, resultReadSource)
  ) {
    throw new Error("Invalid stored Job completion result-read source.");
  }
  if (state === "result-read" && resultReadSource === undefined) {
    throw new Error("Stored Job completion result-read state has no source.");
  }
  return {
    jobId: String(row.job_id),
    scopeId: String(row.scope_id),
    terminalVersion: Number(row.terminal_version),
    receipt: normalizeJobCompletionReceipt(String(row.receipt)),
    state,
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: optionalNumber(row.next_attempt_at),
    leaseOwner: optionalString(row.lease_owner),
    leaseExpiresAt: optionalNumber(row.lease_expires_at),
    lastHostRejectedAt: optionalNumber(row.last_host_rejected_at),
    lastHostError: optionalString(row.last_host_error),
    hostAcceptedAt: optionalNumber(row.host_accepted_at),
    acceptanceUnknownAt: optionalNumber(row.acceptance_unknown_at),
    resultReadAt: optionalNumber(row.result_read_at),
    resultReadSource,
    completionResultOfferedAt: optionalNumber(row.completion_result_offered_at),
    directResultOfferedAt: optionalNumber(row.direct_result_offered_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export function jobCompletionReceipt(
  scopeId: string,
  jobId: string,
  terminalVersion: number
): string {
  if (!Number.isInteger(terminalVersion) || terminalVersion < 1) {
    throw new Error("Invalid Job completion terminal version.");
  }
  return `completion-${createHash("sha256")
    .update("codex-job-completion/v1", "utf8")
    .update("\0", "utf8")
    .update(normalizeCompletionIdentity(scopeId, "completion delivery scopeId"), "utf8")
    .update("\0", "utf8")
    .update(normalizeCompletionIdentity(jobId, "completion delivery jobId"), "utf8")
    .update("\0", "utf8")
    .update(String(terminalVersion), "utf8")
    .digest("hex")}`;
}

function normalizeCompletionIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${label} must be a non-empty identifier.`);
  }
  return normalized;
}

function normalizeJobCompletionReceipt(receipt: string): string {
  const value = receipt.trim();
  if (!/^completion-[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid Job completion receipt.");
  }
  return value;
}

export function legacyActivityIdForJob(jobId: string): string {
  const digest = createHash("sha256").update(`legacy-activity\0${jobId}`).digest("hex").split("");
  digest[12] = "8";
  digest[16] = "8";
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function countsForSingleStatus(status: string | undefined): ActivityJobCounts {
  return {
    total: status ? 1 : 0,
    running: status && isActiveActivityJobStatus(status) ? 1 : 0,
    completed: status === "completed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
    interrupted: status === "interrupted" ? 1 : 0,
    cancelled: status === "cancelled" ? 1 : 0,
    terminal: status && isTerminalActivityJobStatus(status) ? 1 : 0
  };
}

function readNestedThreadId(payload: Record<string, unknown>): string | undefined {
  const direct = normalizeOptionalString(payload.threadId);
  if (direct) return direct;
  const decision = payload.sessionDecision;
  return isRecord(decision) ? normalizeOptionalString(decision.threadId) : undefined;
}

function readDashboardRetainedExecution(
  payload: Record<string, unknown>
): DashboardRetainedJobSummary["execution"] | undefined {
  const retainedExecution = isRecord(payload.execution) ? payload.execution : undefined;
  const decision = isRecord(payload.executionDecision) ? payload.executionDecision : undefined;
  const selection = decision && isRecord(decision.effectiveSelection)
    ? decision.effectiveSelection
    : retainedExecution;
  const model = selection && normalizeOptionalString(selection.model);
  const reasoningEffort = selection && normalizeOptionalString(selection.reasoningEffort);
  if (!model || !reasoningEffort) return undefined;
  const serviceTier = selection && normalizeOptionalString(selection.serviceTier);

  let reroutedModel = retainedExecution && normalizeOptionalString(retainedExecution.reroutedModel);
  if (!reroutedModel && Array.isArray(payload.publicEvents)) {
    for (let index = payload.publicEvents.length - 1; index >= 0; index -= 1) {
      const event = payload.publicEvents[index];
      if (!isRecord(event) || event.type !== "model" || !isRecord(event.details)) continue;
      if (event.details.kind !== "rerouted") continue;
      reroutedModel = normalizeOptionalString(event.details.toModel);
      if (reroutedModel) break;
    }
  }
  if (reroutedModel === model) reroutedModel = undefined;
  return {
    model,
    reasoningEffort,
    ...(serviceTier ? { serviceTier } : {}),
    ...(reroutedModel ? { reroutedModel } : {})
  };
}

function decodeDashboardArchivedJob(row: DashboardArchivedJobRow): DashboardRetainedJobSummary {
  const parsed = parseCurrentPayload({ payload: row.summary }, "archived dashboard job summary");
  const summary = isRecord(parsed) ? parsed : {};
  const execution = readDashboardRetainedExecution(summary);
  return {
    jobId: row.job_id,
    scopeId: row.scope_id,
    activityId: row.activity_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.backend_kind ? { backendKind: row.backend_kind } : {}),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(execution ? { execution } : {})
  };
}

function retainedDashboardJobFields(
  payload: Record<string, unknown>
): Pick<DashboardRetainedJobSummary, "createdAt" | "execution"> | Record<string, never> {
  const createdAt = finiteNumber(payload.createdAt);
  const execution = readDashboardRetainedExecution(payload);
  return {
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(execution ? { execution } : {})
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function legacyJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function optionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function parsePayload(row: JsonRow, label: string): unknown {
  try {
    return JSON.parse(row.payload);
  } catch (error) {
    throw new Error(
      `Invalid ${label} payload in the bridge state database: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/** Strict parser for currently readable state rows; frozen migrations use parsePayload. */
function parseCurrentPayload(row: JsonRow, label: string): unknown {
  try {
    return parseJsonTextStrict(row.payload, `bridge state ${label} payload`);
  } catch (error) {
    throw new Error(
      `Invalid ${label} payload in the bridge state database: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function parseStoredJson(value: string, label: string): unknown {
  try {
    return parseJsonTextStrict(value, `bridge state ${label}`);
  } catch (error) {
    throw new Error(
      `Invalid ${label} in the bridge state database: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

const STRUCTURED_JOB_PAYLOAD_KEYS = [
  "jobId", "scopeId", "requestId", "activityId", "threadId", "sourceThreadId",
  "status", "backendKind", "bridgeInstanceId", "workerId",
  "workerGeneration", "upstreamRequestId", "terminalVersion", "agentId", "contextMode",
  "projectId", "projectLabel", "projectName", "projectUuid", "projectNameSnapshot",
  "projectCwdSnapshot", "cwd", "sandbox", "createdAt", "updatedAt",
  "version", "lastProgressAt", "lastProgress", "publicEvents", "inputEvents",
  "pendingInteractions", "terminalOrigin", "cancellationIntentId"
] as const;

function jobPayloadForStorage(job: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...job };
  for (const key of STRUCTURED_JOB_PAYLOAD_KEYS) delete payload[key];
  return payload;
}

function interactionPayloadForStorage(
  interaction: Record<string, unknown>
): Record<string, unknown> {
  const payload = { ...interaction };
  delete payload.interactionId;
  delete payload.isBlocking;
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasBlockingInteraction(value: unknown): boolean {
  return Array.isArray(value) && value.some(entry => !entry || typeof entry !== "object" || entry.isBlocking !== false);
}

function validateOperationalCommandReceiptInput(input: OperationalCommandReceiptInput): void {
  if (!UUID_PATTERN.test(input.commandId)) {
    throw new Error("STATE_COMMAND_RECEIPT_INVALID: commandId must be a UUID.");
  }
  if (!/^[a-z][a-z0-9.-]{0,79}$/u.test(input.operation)) {
    throw new Error("STATE_COMMAND_RECEIPT_INVALID: operation must be a bounded semantic identifier.");
  }
  if (!SHA256_PATTERN.test(input.payloadSha256)) {
    throw new Error("STATE_COMMAND_RECEIPT_INVALID: payloadSha256 must be a lowercase SHA-256 digest.");
  }
  if (
    input.aggregateKey !== undefined &&
    (!input.aggregateKey || Buffer.byteLength(input.aggregateKey, "utf8") > 512)
  ) {
    throw new Error("STATE_COMMAND_RECEIPT_INVALID: aggregateKey must contain at most 512 bytes.");
  }
  if (!UUID_PATTERN.test(input.workerGeneration)) {
    throw new Error("STATE_COMMAND_RECEIPT_INVALID: workerGeneration must be a UUID.");
  }
}

function processIsAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
