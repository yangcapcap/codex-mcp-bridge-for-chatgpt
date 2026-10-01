import { DEFAULT_HISTORY_RETENTION_DAYS, HISTORY_RETENTION_DAYS, historyRetentionDays, type HistoryRetentionDays } from "./workHistory.js";
import { createHmac } from "node:crypto";
import type { AccessStrategy, BridgeConfig, SandboxMode } from "./config.js";
import { DEFAULT_USER_MAX_CONCURRENT_JOBS } from "./config.js";
import { EXECUTION_POLICY_VERSION, resolveTaskSandbox } from "./executionPolicy.js";
import { BridgeStateStore } from "./stateStore.js";
import {
  MODEL_POLICY_SCHEMA_VERSION,
  automaticModelPolicy,
  validateModelPolicy,
  type ModelPolicy
} from "./modelPolicy.js";
import { isUiLocalePreference, type UiLocalePreference } from "./uiI18n.js";
import {
  modelDescriptionId,
  normalizeModelDescriptionOverrides,
  type ModelDescriptionHistoryPage,
  type ModelDescriptionOverrides
} from "./modelDescriptions.js";
import {
  MAX_REGISTERED_PROJECTS,
  PROJECT_REQUIRED,
  ProjectRegistry,
  type ProjectRegistryOperation,
  type ProjectRegistrySnapshot,
  type RuntimeProjectSelection,
  type ProjectTarget
} from "./projectRegistry.js";

export type { ProjectRegistryOperation } from "./projectRegistry.js";

export const SETTINGS_REVISION_CONFLICT = "SETTINGS_REVISION_CONFLICT";
const EXECUTION_POLICY_REF_CONTRACT_VERSION = 5;
const TASK_EXECUTION_ENVELOPE_REF_CONTRACT_VERSION = 6;

export type BridgeUserSettings = {
  schemaVersion: typeof MODEL_POLICY_SCHEMA_VERSION;
  settingsRevision: number;
  registryRevision: number;
  /** Internal compatibility spelling used by model-policy code. */
  revision: number;
  updatedAt: string | null;
  accessStrategy: AccessStrategy;
  modelPolicy: ModelPolicy;
  modelDescriptionOverrides: ModelDescriptionOverrides;
  usePriorityServiceTier: boolean;
  /** App-private composed registry view. UUID/cwd are stripped from public results. */
  projects: ProjectTarget[];
  uiLocalePreference: UiLocalePreference;
  maxConcurrentJobs: number;
  showBridgeThreadsInCodexApp: boolean;
  /** Presentation-only experiment. Each admitted Job snapshots this value. */
  experimentalDirectResultDelivery: boolean;
  historyRetentionDays: HistoryRetentionDays;
};

export type BridgeUserSettingsPatch = Partial<
  Omit<
    BridgeUserSettings,
    | "schemaVersion"
    | "settingsRevision"
    | "registryRevision"
    | "revision"
    | "updatedAt"
    | "projects"
  >
>;

type GeneralSettings = Omit<
  BridgeUserSettings,
  "registryRevision" | "revision" | "projects"
>;

export type UserSettingsStoreOptions = {
  stateStore?: BridgeStateStore;
  now?: () => number;
  projectionOnly?: boolean;
};

export class UserSettingsStore {
  private readonly stateStore: BridgeStateStore;
  private readonly now: () => number;
  private readonly projectionOnly: boolean;
  private readonly initial: GeneralSettings;
  private settings: GeneralSettings;
  private readonly warnings: string[] = [];
  private readonly changeListeners = new Set<() => void>();

  subscribeChanges(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  constructor(
    private readonly config: BridgeConfig,
    options: UserSettingsStoreOptions = {}
  ) {
    this.stateStore = options.stateStore || new BridgeStateStore({ file: ":memory:" });
    this.projectionOnly = options.projectionOnly === true;
    this.stateStore.activeSecurityHmacKey("execution-policy", !this.projectionOnly);
    this.now = options.now || Date.now;
    this.initial = this.validateGeneral({
      schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
      settingsRevision: 0,
      updatedAt: null,
      accessStrategy: config.defaultAccessStrategy,
      modelPolicy: automaticModelPolicy(),
      modelDescriptionOverrides: {},
      usePriorityServiceTier: false,
      uiLocalePreference: "auto",
      maxConcurrentJobs: Math.min(DEFAULT_USER_MAX_CONCURRENT_JOBS, config.maxConcurrentJobs),
      // Durable context is the default for a new installation. Loaded legacy
      // settings retain their explicit (or historical missing-field) choice.
      showBridgeThreadsInCodexApp: true,
      experimentalDirectResultDelivery: false,
      historyRetentionDays: DEFAULT_HISTORY_RETENTION_DAYS
    });
    this.settings = cloneGeneralSettings(this.initial);
    this.load();
    this.noteUnavailableProjects();
  }

  get historyPolicy() { return this.stateStore.workHistory.policy(this.settings.historyRetentionDays); }

  get modelDescriptionHistoryIds(): string[] {
    return this.stateStore.modelDescriptionHistoryIds();
  }

  modelDescriptionHistory(modelId: string, beforeVersion?: number, limit = 20): ModelDescriptionHistoryPage {
    modelDescriptionId(modelId);
    if (beforeVersion !== undefined && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 1)) {
      throw new Error("MODEL_DESCRIPTION_HISTORY_CURSOR_INVALID: Invalid version cursor.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("MODEL_DESCRIPTION_HISTORY_LIMIT_INVALID: Request 1 to 20 versions.");
    }
    return this.stateStore.modelDescriptionHistory(modelId, beforeVersion, limit);
  }

  get executionPolicyKeyGeneration(): number {
    return this.stateStore.activeSecurityHmacKey("execution-policy").generation;
  }

  get persistent(): boolean {
    return this.stateStore.persistent;
  }

  get persistencePath(): string | null {
    return this.stateStore.persistencePath;
  }

  /** Internal composition hook: admission participants must share this DB. */
  get admissionStateStore(): BridgeStateStore {
    return this.stateStore;
  }

  get current(): BridgeUserSettings {
    const registry = this.stateStore.getProjectRegistrySnapshot();
    return composeSettings(this.settings, registry);
  }

  get defaults(): BridgeUserSettings {
    return composeSettings(this.initial, this.stateStore.getProjectRegistrySnapshot());
  }

  get loadWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * Opaque, installation-bound reference to execution-affecting policy.
   * Presentation-only settings intentionally do not invalidate admission.
   */
  executionPolicyRef(
    settings: BridgeUserSettings = this.current,
    admissionCatalogFingerprint: string | null = null
  ): string {
    const key = this.stateStore.activeSecurityHmacKey("execution-policy");
    return createHmac("sha256", key.secret)
      .update(
        `codex-mcp-bridge/execution-policy/v${EXECUTION_POLICY_REF_CONTRACT_VERSION}\0`
      )
      .update(canonicalJsonValue({
        contract: EXECUTION_POLICY_REF_CONTRACT_VERSION,
        ...(key.generation > 1 ? { keyGeneration: key.generation } : {}),
        accessStrategy: settings.accessStrategy,
        modelPolicy: canonicalExecutionModelPolicy(settings.modelPolicy),
        usePriorityServiceTier: settings.usePriorityServiceTier,
        // Bind only catalog fields that can alter admission or dispatch.
        // GPT-facing names and guidance may refresh Settings/UI catalog data,
        // but do not make an otherwise equivalent admission snapshot stale.
        admissionCatalogFingerprint,
        showBridgeThreadsInCodexApp: settings.showBridgeThreadsInCodexApp,
        maxConcurrentJobs: settings.maxConcurrentJobs,
        operator: canonicalExecutionOperatorEnvelope(this.config)
      }))
      .digest("hex");
  }

  /**
   * Stable installation-bound reference to the maximum authority and static
   * wire shape advertised by codex_task contract v6.
   *
   * User settings, projects, and the live model catalog are deliberately not
   * included: contract v6 declares their runtime-authoritative behavior in a
   * stable schema. A process/operator change can alter the maximum authority
   * or the schema itself and therefore still requires a connection Refresh.
   */
  taskExecutionEnvelopeRef(): string {
    const key = this.stateStore.activeSecurityHmacKey("execution-policy");
    return createHmac("sha256", key.secret)
      .update(
        `codex-mcp-bridge/task-execution-envelope/v${TASK_EXECUTION_ENVELOPE_REF_CONTRACT_VERSION}\0`
      )
      .update(canonicalJsonValue({
        contract: TASK_EXECUTION_ENVELOPE_REF_CONTRACT_VERSION,
        ...(key.generation > 1 ? { keyGeneration: key.generation } : {}),
        taskInputContract: 6,
        maxPromptChars: this.config.maxPromptChars,
        operator: canonicalExecutionOperatorEnvelope(this.config)
      }))
      .digest("hex");
  }

  get projectRegistry(): ProjectRegistry {
    const snapshot = this.stateStore.getProjectRegistrySnapshot();
    return new ProjectRegistry(
      snapshot.projects,
      this.config.allowedRoots,
      snapshot.registryRevision,
      { retainUnavailable: true }
    );
  }

  /** Runtime opaque-ref resolution, with global-generation compatibility for cached descriptors. */
  resolveProject(selection?: RuntimeProjectSelection): ProjectTarget {
    if (!selection) return this.projectRegistry.resolve();
    return this.stateStore.resolveProjectSelection(selection, this.config.allowedRoots);
  }

  update(patch: BridgeUserSettingsPatch, expectedRevision: number): BridgeUserSettings {
    assertSettingsPatchKeys(patch);
    return this.applyConfiguration(
      patch,
      [],
      Object.keys(patch).length > 0 ? expectedRevision : undefined,
      undefined
    );
  }

  assertExpectedRevision(expectedRevision: number): void {
    this.stateStore.assertSettingsRevision(expectedRevision);
  }

  assertExpectedRegistryRevision(expectedRevision: number): void {
    this.stateStore.assertProjectRegistryRevision(expectedRevision);
  }

  updateWithProjectOperations(
    patch: BridgeUserSettingsPatch,
    operations: readonly ProjectRegistryOperation[],
    expectedSettingsRevision: number | undefined,
    expectedRegistryRevision = this.current.registryRevision
  ): BridgeUserSettings {
    assertSettingsPatchKeys(patch);
    return this.applyConfiguration(
      patch,
      operations,
      Object.keys(patch).length > 0 ? expectedSettingsRevision : undefined,
      operations.length > 0 ? expectedRegistryRevision : undefined
    );
  }

  reset(
    expectedSettingsRevision: number,
    modelPolicy: ModelPolicy = this.initial.modelPolicy
  ): BridgeUserSettings {
    const patch: BridgeUserSettingsPatch = {
      accessStrategy: this.initial.accessStrategy,
      modelPolicy,
      modelDescriptionOverrides: {},
      usePriorityServiceTier: this.initial.usePriorityServiceTier,
      uiLocalePreference: this.initial.uiLocalePreference,
      maxConcurrentJobs: this.initial.maxConcurrentJobs,
      showBridgeThreadsInCodexApp: this.initial.showBridgeThreadsInCodexApp,
      experimentalDirectResultDelivery: this.initial.experimentalDirectResultDelivery,
      historyRetentionDays: this.initial.historyRetentionDays
    };
    return this.applyConfiguration(patch, [], expectedSettingsRevision, undefined);
  }

  resolveSandbox(): SandboxMode {
    return resolveTaskSandbox(this.config, this.settings);
  }

  /** Keep registry verification and Activity/Agent/Job admission in one sync boundary. */
  admissionTransaction<T>(operation: () => T): T {
    return this.stateStore.transaction(operation);
  }

  private applyConfiguration(
    patch: BridgeUserSettingsPatch,
    operations: readonly ProjectRegistryOperation[],
    expectedSettingsRevision: number | undefined,
    expectedRegistryRevision: number | undefined
  ): BridgeUserSettings {
    if (operations.length > MAX_REGISTERED_PROJECTS * 2) {
      throw new Error(
        `PROJECT_OPERATION_LIMIT: At most ${MAX_REGISTERED_PROJECTS * 2} project operations are allowed per save.`
      );
    }
    const hasGeneralPatch = Object.keys(patch).length > 0;
    if (hasGeneralPatch && expectedSettingsRevision === undefined) {
      throw new Error(`${SETTINGS_REVISION_CONFLICT}: expectedSettingsRevision is required.`);
    }
    if (operations.length > 0 && expectedRegistryRevision === undefined) {
      throw new Error("PROJECT_REGISTRY_REVISION_CONFLICT: expectedRegistryRevision is required.");
    }

    const merged = {
      ...this.settings,
      ...patch,
      settingsRevision: this.settings.settingsRevision,
      updatedAt: this.settings.updatedAt
    } as GeneralSettings;
    const candidate = this.validateGeneral(merged, {
      allowUnavailableFullAccess:
        this.settings.accessStrategy === "always-full" &&
        merged.accessStrategy === "always-full"
    });
    const generalChanged = hasGeneralPatch &&
      canonicalGeneralSettings(candidate) !== canonicalGeneralSettings(this.settings);
    const now = this.now();
    let committedSettings = this.settings;

    this.stateStore.transaction(() => {
      if (hasGeneralPatch) {
        this.stateStore.assertSettingsRevision(expectedSettingsRevision as number);
      }
      if (operations.length > 0) {
        this.stateStore.assertProjectRegistryRevision(expectedRegistryRevision as number);
      }
      if (generalChanged) {
        const persisted = {
          ...candidate,
          settingsRevision: (expectedSettingsRevision as number) + 1,
          updatedAt: new Date(now).toISOString()
        };
        this.stateStore.writeSettings(
          persisted,
          expectedSettingsRevision as number,
          now
        );
        this.stateStore.appendModelDescriptionVersionChanges(
          this.settings.modelDescriptionOverrides,
          candidate.modelDescriptionOverrides,
          now
        );
        committedSettings = this.validateGeneral(persisted);
      }
      if (operations.length > 0) {
        this.stateStore.applyProjectOperations(
          operations,
          expectedRegistryRevision as number,
          this.config.allowedRoots,
          now
        );
      }
    });

    this.settings = committedSettings;
    this.config.codexService?.setAppVisibility(this.settings.showBridgeThreadsInCodexApp);
    if (generalChanged || operations.length > 0) {
      for (const listener of this.changeListeners) listener();
    }
    return this.current;
  }

  private validateGeneral(
    candidate: GeneralSettings,
    options: { allowUnavailableFullAccess?: boolean } = {}
  ): GeneralSettings {
    if (
      candidate.accessStrategy !== "read-only" &&
      candidate.accessStrategy !== "adaptive" &&
      candidate.accessStrategy !== "always-full"
    ) {
      throw new Error(`Invalid access strategy: ${String(candidate.accessStrategy)}`);
    }
    if (
      candidate.accessStrategy === "always-full" &&
      !this.config.allowDangerFullAccess &&
      !options.allowUnavailableFullAccess
    ) {
      throw new Error(
        "always-full is unavailable because the bridge security policy disables danger-full-access."
      );
    }
    if (candidate.schemaVersion !== MODEL_POLICY_SCHEMA_VERSION) {
      throw new Error("Invalid settings schema version.");
    }
    if (!HISTORY_RETENTION_DAYS.includes(candidate.historyRetentionDays)) {
      throw new Error("Invalid execution history retention period.");
    }
    candidate.modelPolicy = validateModelPolicy(candidate.modelPolicy);
    candidate.modelDescriptionOverrides = normalizeModelDescriptionOverrides(candidate.modelDescriptionOverrides);
    if (typeof candidate.usePriorityServiceTier !== "boolean") {
      throw new Error("Invalid Priority service-tier preference.");
    }
    if (!isUiLocalePreference(candidate.uiLocalePreference)) {
      throw new Error(`Invalid interface language preference: ${String(candidate.uiLocalePreference)}`);
    }
    validateIntegerRange(
      candidate.maxConcurrentJobs,
      1,
      this.config.maxConcurrentJobs,
      "Concurrent job limit",
      "jobs"
    );
    if (typeof candidate.showBridgeThreadsInCodexApp !== "boolean") {
      throw new Error("Invalid Codex app thread-visibility preference.");
    }
    if (typeof candidate.experimentalDirectResultDelivery !== "boolean") {
      throw new Error("Invalid experimental direct-result delivery preference.");
    }
    if (!Number.isInteger(candidate.settingsRevision) || candidate.settingsRevision < 0) {
      throw new Error("Invalid settings revision.");
    }
    if (candidate.updatedAt !== null && !Number.isFinite(Date.parse(candidate.updatedAt))) {
      throw new Error("Invalid settings update timestamp.");
    }
    return cloneGeneralSettings(candidate);
  }

  private load(): void {
    const stored = this.stateStore.getSettingsRecord();
    if (stored) {
      const source = isRecord(stored.payload) ? stored.payload : undefined;
      if (!source) throw new Error("Invalid bridge settings in the state database.");
      if (isRecord(stored.payload) && "projects" in stored.payload) {
        this.warnings.push(
          "Legacy project IDs/default aliases were intentionally not migrated. Register projects by name in Settings."
        );
      }
      const loaded = this.reconcileLoadedGeneral(
        source,
        "state database",
        stored.settingsRevision
      );
      if (loaded.changed && !this.projectionOnly) {
        this.stateStore.writeSettings(
          loaded.settings,
          stored.settingsRevision,
          Date.parse(loaded.settings.updatedAt as string)
        );
      }
      this.settings = loaded.settings;
      return;
    }
    return;
  }

  private reconcileLoadedGeneral(
    source: Record<string, unknown>,
    sourceLabel: string,
    settingsRevision: number
  ): { settings: GeneralSettings; changed: boolean } {
    const candidate = readGeneralSettings(source, sourceLabel, settingsRevision);
    let changed = needsGeneralSettingsRewrite(source);
    const rawPolicy = isRecord(source.modelPolicy) ? source.modelPolicy : undefined;
    if (
      (
        rawPolicy?.mode === "automatic" &&
        (rawPolicy.fallbackSelection !== undefined || rawPolicy.preferredSelection !== undefined)
      ) ||
      typeof source.legacyPreferredModel === "string" ||
      typeof source.defaultModel === "string" ||
      typeof source.defaultReasoningEffort === "string"
    ) {
      this.warnings.push(
        "A retired automatic model default was removed. GPT must now choose an exact model and reasoning effort for new work."
      );
    }
    if (candidate.accessStrategy === "always-full" && !this.config.allowDangerFullAccess) {
      this.warnings.push(
        "Saved full-access mode is retained but inactive because the bridge security policy disables danger-full-access. Read-only is enforced until full access is enabled in runtime settings."
      );
    }
    if (candidate.maxConcurrentJobs > this.config.maxConcurrentJobs) {
      candidate.maxConcurrentJobs = this.config.maxConcurrentJobs;
      changed = true;
      this.warnings.push("Saved concurrent-job limit was reduced to the current bridge maximum.");
    }
    if (changed) {
      candidate.settingsRevision = settingsRevision + 1;
      candidate.updatedAt = new Date(this.now()).toISOString();
    }
    return {
      settings: this.validateGeneral(candidate, { allowUnavailableFullAccess: true }),
      changed
    };
  }

  private noteUnavailableProjects(): void {
    for (const entry of this.projectRegistry.availability) {
      if (entry.project.archivedAt !== undefined || entry.available) continue;
      this.warnings.push(
        `PROJECT_UNAVAILABLE: Saved project "${entry.project.name}" is unavailable and cannot admit new work.`
      );
    }
  }


}

function composeSettings(
  settings: GeneralSettings,
  registry: ProjectRegistrySnapshot
): BridgeUserSettings {
  return {
    ...cloneGeneralSettings(settings),
    registryRevision: registry.registryRevision,
    revision: settings.settingsRevision,
    projects: registry.projects.map((project) => ({ ...project }))
  };
}

function cloneGeneralSettings(settings: GeneralSettings): GeneralSettings {
  return {
    ...settings,
    modelPolicy: validateModelPolicy(settings.modelPolicy),
    modelDescriptionOverrides: { ...settings.modelDescriptionOverrides }
  };
}

function canonicalGeneralSettings(settings: GeneralSettings): string {
  const { settingsRevision: _revision, updatedAt: _updatedAt, ...semantic } = settings;
  return JSON.stringify(semantic);
}


function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot sign a non-finite policy number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonValue(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonValue(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`Cannot sign unsupported policy value of type ${typeof value}.`);
}

function canonicalExecutionModelPolicy(policy: ModelPolicy): ModelPolicy {
  if (
    policy.mode !== "automatic" ||
    policy.allowedSelections.kind !== "explicit"
  ) {
    return policy;
  }
  return {
    ...policy,
    allowedSelections: {
      kind: "explicit",
      selections: canonicalModelChoices(policy.allowedSelections.selections)
    }
  };
}

function canonicalExecutionOperatorEnvelope(config: BridgeConfig): Record<string, unknown> {
  return {
    executionPolicyVersion: EXECUTION_POLICY_VERSION,
    codexCommand: config.codexCommand,
    backend: config.defaultBackend,
    allowedRoots: [...config.allowedRoots].sort(),
    defaultSandbox: config.defaultSandbox,
    allowWorkspaceWrite: config.allowWorkspaceWrite,
    allowDangerFullAccess: config.allowDangerFullAccess,
    approvalPolicy: config.defaultApprovalPolicy,
    approvalsReviewer: config.defaultApprovalsReviewer,
    modelCeiling: config.operatorModelCeiling
      ? canonicalModelChoices(config.operatorModelCeiling)
      : null,
    secretScan: config.secretScan
  };
}

function canonicalModelChoices<T extends { model: string; reasoningEffort: string }>(
  selections: readonly T[]
): T[] {
  return [...selections].sort((left, right) =>
    left.model.localeCompare(right.model) ||
    left.reasoningEffort.localeCompare(right.reasoningEffort)
  );
}

function needsGeneralSettingsRewrite(value: Record<string, unknown>): boolean {
  const required = [
    "schemaVersion",
    "settingsRevision",
    "updatedAt",
    "accessStrategy",
    "modelPolicy",
    "usePriorityServiceTier",
    "uiLocalePreference",
    "maxConcurrentJobs",
    "showBridgeThreadsInCodexApp",
    "experimentalDirectResultDelivery",
    "historyRetentionDays"
  ];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return true;
  if (value.schemaVersion !== MODEL_POLICY_SCHEMA_VERSION) return true;
  if (
    [
      "revision",
      "projects",
      "defaultProjectId",
      "defaultCwd",
      "defaultModel",
      "defaultReasoningEffort",
      "legacyPreferredModel",
      "completionDeliveryMode",
      "dashboardAutoOpenBackground",
      "dashboardAutoOpen",
      "activityCardVisibility",
      "completionFollowUp",
      "completionHandoff",
      "activityCardView",
      "taskTimeoutMs",
      "defaultSessionMode",
      "autoResumeTtlMs"
    ].some((key) => Object.prototype.hasOwnProperty.call(value, key))
  ) {
    return true;
  }
  const migrated = migrateModelPolicyServiceTiers(value.modelPolicy);
  return JSON.stringify(migrated.value) !== JSON.stringify(value.modelPolicy);
}

function readGeneralSettings(
  value: unknown,
  source: string,
  settingsRevision: number
): GeneralSettings {
  if (!isRecord(value)) throw new Error(`Invalid bridge settings at ${source}.`);
  const accessStrategy = value.accessStrategy as AccessStrategy;
  const migratedPolicy = migrateModelPolicyServiceTiers(value.modelPolicy);
  const hasMigratablePolicy =
    (
      value.schemaVersion === MODEL_POLICY_SCHEMA_VERSION ||
      value.schemaVersion === 6 ||
      value.schemaVersion === 5 ||
      value.schemaVersion === 4 ||
      value.schemaVersion === 3 ||
      value.schemaVersion === 2
    ) &&
    value.modelPolicy;
  const modelPolicy = hasMigratablePolicy
    ? validateModelPolicy(migratedPolicy.value)
    : automaticModelPolicy();
  const updatedAt = value.updatedAt === null || typeof value.updatedAt === "string"
    ? value.updatedAt
    : null;
  const maxConcurrentJobs = typeof value.maxConcurrentJobs === "number"
    ? value.maxConcurrentJobs
    : 1;
  return {
    schemaVersion: MODEL_POLICY_SCHEMA_VERSION,
    settingsRevision,
    updatedAt,
    accessStrategy,
    modelPolicy,
    modelDescriptionOverrides: normalizeModelDescriptionOverrides(value.modelDescriptionOverrides ?? {}),
    usePriorityServiceTier: typeof value.usePriorityServiceTier === "boolean"
      ? value.usePriorityServiceTier
      : migratedPolicy.usedFastTier,
    uiLocalePreference: isUiLocalePreference(value.uiLocalePreference)
      ? value.uiLocalePreference
      : "auto",
    maxConcurrentJobs,
    showBridgeThreadsInCodexApp: typeof value.showBridgeThreadsInCodexApp === "boolean"
      ? value.showBridgeThreadsInCodexApp
      : false,
    experimentalDirectResultDelivery: typeof value.experimentalDirectResultDelivery === "boolean"
      ? value.experimentalDirectResultDelivery
      : false,
    historyRetentionDays: historyRetentionDays(value.historyRetentionDays),
  };
}

function migrateModelPolicyServiceTiers(value: unknown): {
  value: unknown;
  usedFastTier: boolean;
} {
  if (!isRecord(value)) return { value, usedFastTier: false };
  let usedFastTier = false;
  const withoutTier = (selection: unknown): unknown => {
    if (!isRecord(selection) || !("serviceTier" in selection)) return selection;
    const tier = selection.serviceTier;
    if (typeof tier === "string" && ["priority", "fast"].includes(tier.toLowerCase())) {
      usedFastTier = true;
    }
    const copy = { ...selection };
    delete copy.serviceTier;
    return copy;
  };
  const migrated: Record<string, unknown> = { ...value };
  if (value.mode === "fixed") {
    migrated.selection = withoutTier(value.selection);
  } else if (value.mode === "automatic") {
    const fallbackSelection = value.fallbackSelection ?? value.preferredSelection;
    if (fallbackSelection !== undefined) {
      // Preserve the legacy service-tier preference, but never retain the
      // retired omission fallback itself.
      withoutTier(fallbackSelection);
    }
    delete migrated.fallbackSelection;
    delete migrated.preferredSelection;
    if (isRecord(value.allowedSelections) && Array.isArray(value.allowedSelections.selections)) {
      const seen = new Set<string>();
      migrated.allowedSelections = {
        ...value.allowedSelections,
        selections: value.allowedSelections.selections.flatMap((selection) => {
          const normalized = withoutTier(selection);
          if (!isRecord(normalized)) return [normalized];
          const key = JSON.stringify([normalized.model, normalized.reasoningEffort]);
          if (seen.has(key)) return [];
          seen.add(key);
          return [normalized];
        })
      };
    }
  }
  return { value: migrated, usedFastTier };
}

function validateIntegerRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
  unit = "milliseconds"
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum} ${unit}.`);
  }
}

function assertSettingsPatchKeys(patch: BridgeUserSettingsPatch): void {
  const allowed = new Set([
    "accessStrategy",
    "modelPolicy",
    "modelDescriptionOverrides",
    "usePriorityServiceTier",
    "uiLocalePreference",
    "maxConcurrentJobs",
    "showBridgeThreadsInCodexApp",
    "experimentalDirectResultDelivery",
    "historyRetentionDays"
  ]);
  const unsupported = Object.keys(patch).find((key) => !allowed.has(key));
  if (!unsupported) return;
  if (
    unsupported === "projects" ||
    unsupported === "defaultProjectId" ||
    unsupported === "defaultCwd" ||
    unsupported === "projectId"
  ) {
    throw new Error(
      `SETTINGS_FIELD_RETIRED: ${unsupported} was removed; projects are selected only by current user-defined name.`
    );
  }
  throw new Error(`SETTINGS_FIELD_UNKNOWN: Unsupported setting: ${unsupported}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
