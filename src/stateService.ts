import {
  STATE_MAINTENANCE_SLICES,
  type StateMaintenanceSlice
} from "./maintenanceScheduler.js";
import type { BridgeStateStore } from "./stateStore.js";

export const OPERATIONAL_STATE_PROTOCOL = "bridge-state-service" as const;
export const OPERATIONAL_STATE_PROTOCOL_VERSION = 4 as const;
export const OPERATIONAL_STATE_REQUIRED_SLICES = STATE_MAINTENANCE_SLICES;
export const OPERATIONAL_STATE_CHILD_SUPPORTED_SLICES = Object.freeze([
  ...STATE_MAINTENANCE_SLICES
]);

export type OperationalJobRetentionCandidate = {
  jobId: string;
  version: number;
  updatedAt: number;
  knownProtected: boolean;
};

export type OperationalJobRetentionDisposition = OperationalJobRetentionCandidate & {
  disposition: "protected" | "retained" | "removed" | "skipped";
};

export type OperationalJobRetentionResult = {
  classifications: OperationalJobRetentionDisposition[];
  remainingAdmissionReservations: number;
};

export type OperationalStorageMaintenanceCommand = {
  operation: "maintain";
  slice: Exclude<StateMaintenanceSlice, "jobs">;
};

export type OperationalJobRetentionCommand = {
  operation: "maintain";
  slice: "jobs";
  now: number;
  cutoffAt: number;
  completionResultRecoveryMs: number;
  retentionTarget: number;
  admissionReservations: number;
  maxRemoved: number;
  maxDurationMs: number;
  candidates: OperationalJobRetentionCandidate[];
};

export type OperationalStateCommand =
  | OperationalStorageMaintenanceCommand
  | OperationalJobRetentionCommand;

export type OperationalStateResult = {
  operation: "maintain";
  slice: StateMaintenanceSlice;
  changed: number;
  jobRetention?: OperationalJobRetentionResult;
  certainty?: "committed";
  commandId?: string;
  committedAt?: number;
  replayed?: boolean;
};

export const OPERATIONAL_STATE_OPERATION_PHASES = [
  "queue-wait",
  "write-lock-wait",
  "read-snapshot",
  "executing",
  "committing",
  "serializing",
  "responding"
] as const;

export type OperationalStateOperationPhase =
  (typeof OPERATIONAL_STATE_OPERATION_PHASES)[number];

/**
 * Privacy-safe last-confirmed state-owner boundary. It intentionally excludes
 * request, scope, project and Job identifiers as well as command payloads.
 */
export type OperationalStateOperationObservation = {
  access: "read" | "write";
  /** Bounded semantic category; never a request, project, Job, or SQL value. */
  operation: string;
  slice?: StateMaintenanceSlice;
  phase: OperationalStateOperationPhase;
  startedAt: number;
  observedAt: number;
};

export type OperationalStateExecuteOptions = {
  deadlineMs?: number;
  /** Stable logical identity reused after an outcome-unknown response. */
  commandId?: string;
  /** Optional FIFO/versioning identity reserved for aggregate commands. */
  aggregateKey?: string;
};

export type OperationalStateRequestEnvelope = {
  protocol: typeof OPERATIONAL_STATE_PROTOCOL;
  version: typeof OPERATIONAL_STATE_PROTOCOL_VERSION;
  requestId: string;
  commandId: string;
  kind: "command";
  operation: OperationalStateCommand["operation"];
  aggregateKey?: string;
  workerGeneration: string;
  deadlineAt: number;
  payloadSha256: string;
  payload: OperationalStateCommand;
};

export type OperationalStateHealth = {
  ready: boolean;
  reason:
    | "ready"
    | "state-starting"
    | "state-stale"
    | "state-recovering"
    | "state-incompatible"
    | "state-capacity";
  protocolVersion: number;
  generation?: string;
  heartbeatAgeMs?: number;
  inFlight: number;
  queueDepth: number;
  capacity: number;
  supportedSlices: readonly StateMaintenanceSlice[];
  activeOperation?: OperationalStateOperationObservation;
  lastCommitAt?: number;
};

/**
 * Semantic asynchronous boundary for authoritative operational state.
 * Callers depend on this contract rather than on a SQLite connection. The
 * initial adapter remains in-process; a child-process implementation can
 * replace it only after every state caller has crossed this boundary.
 */
export interface OperationalStateService {
  execute(
    command: OperationalStateCommand,
    options?: OperationalStateExecuteOptions
  ): Promise<OperationalStateResult>;
}

export class InProcessOperationalStateService implements OperationalStateService {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly store: BridgeStateStore) {}

  execute(
    command: OperationalStateCommand,
    _options: OperationalStateExecuteOptions = {}
  ): Promise<OperationalStateResult> {
    const execute = () => this.run(command);
    const result = this.tail.then(execute, execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private run(command: OperationalStateCommand): OperationalStateResult {
    return executeOperationalStateCommand(this.store, command);
  }
}

/** Synchronous command body used only inside the isolated state's transaction. */
export function executeOperationalStateCommand(
  store: BridgeStateStore,
  command: OperationalStateCommand
): OperationalStateResult {
  if (!isOperationalStateCommand(command)) {
    throw new Error("STATE_REQUEST_INVALID: Operational state command is invalid.");
  }
  if (command.slice === "jobs") {
    const jobRetention = store.maintainJobRetentionCandidates(command);
    const changed = jobRetention.classifications.filter(
      candidate => candidate.disposition === "removed"
    ).length;
    return { operation: "maintain", slice: "jobs", changed, jobRetention };
  }
  let changed: number;
  if (command.slice === "events") {
    const report = store.maintainEventRetention();
    changed = report.expiredJobEventsRemoved + report.expiredActivityEventsRemoved +
      report.expiredResultHoldsRemoved + report.perJobEventsRemoved + report.budgetEventsRemoved;
  } else if (command.slice === "history") {
    changed = store.maintainHistoryRetention().historyRemoved;
  } else if (command.slice === "questions") {
    const report = store.maintainQuestionRetention();
    changed = report.expiredQuestionsRemoved + report.deliveredJournalsRemoved +
      report.notificationsMarkedUncertain;
  } else if (command.slice === "recovery") {
    const report = store.maintainRecoveryRetention();
    changed = report.recordsRemoved + report.incidentsRemoved;
  } else if (command.slice === "receipts") {
    changed = store.maintainOperationalCommandReceiptRetention().receiptsRemoved + store.taskFollowups.maintain();
    store.mcpEvents.maintain();
  } else {
    throw new Error("STATE_REQUEST_INVALID: Operational state slice is invalid.");
  }
  return { operation: "maintain", slice: command.slice, changed };
}

export function isOperationalStateCommand(value: unknown): value is OperationalStateCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (command.operation !== "maintain" || typeof command.slice !== "string") return false;
  if (!STATE_MAINTENANCE_SLICES.includes(command.slice as StateMaintenanceSlice)) return false;
  if (command.slice !== "jobs") return true;
  if (
    !nonNegativeSafeInteger(command.now) ||
    !Number.isSafeInteger(command.cutoffAt) ||
    !nonNegativeSafeInteger(command.completionResultRecoveryMs) ||
    !nonNegativeSafeInteger(command.retentionTarget) ||
    !nonNegativeSafeInteger(command.admissionReservations) ||
    !Number.isSafeInteger(command.maxRemoved) ||
    Number(command.maxRemoved) < 1 ||
    Number(command.maxRemoved) > 64 ||
    !Number.isSafeInteger(command.maxDurationMs) ||
    Number(command.maxDurationMs) < 1 ||
    Number(command.maxDurationMs) > 1_000 ||
    !Array.isArray(command.candidates) ||
    command.candidates.length > 256
  ) return false;
  const seen = new Set<string>();
  return command.candidates.every(candidate => {
    if (!candidate || typeof candidate !== "object") return false;
    const item = candidate as Record<string, unknown>;
    if (
      typeof item.jobId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item.jobId) ||
      seen.has(item.jobId) ||
      !Number.isSafeInteger(item.version) ||
      Number(item.version) < 1 ||
      !nonNegativeSafeInteger(item.updatedAt) ||
      typeof item.knownProtected !== "boolean"
    ) return false;
    seen.add(item.jobId);
    return true;
  });
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
