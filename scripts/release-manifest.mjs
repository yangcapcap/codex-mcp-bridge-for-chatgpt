import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  UI_ACTIVE_RESOURCE_NAMES,
  UI_COMPATIBILITY_RESOURCE_NAMES,
  UI_RELEASE_CATALOG_FILENAME,
  UI_RESOURCE_NAMES,
  loadUiReleaseCatalog,
  uiReleaseCatalogSha256,
  validateUiReleaseCatalog
} from "./ui-release-catalog.mjs";
import { decodeUtf8Strict, parseJsonUtf8Strict } from "./text-integrity.mjs";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_FILENAME = "release-manifest.json";
const PLUGIN_MANIFEST_FILENAME = ".codex-plugin/plugin.json";
const APP_MANIFEST_FILENAME = ".app.json";
const UI_LOCK_FILENAME = "ui-manifest.lock.json";
const UI_GENERATED_SOURCE = "src/uiManifest.generated.ts";
const UI_RESOURCE_DIRECTORY = "ui-resources";
const LEGACY_UI_RESOURCE_DIRECTORIES = Object.freeze([
  "settings",
  "activity",
  "dashboard",
  "question"
]);
const LEGACY_UI_SNAPSHOT_PATTERN = /^[0-9a-f]{64}\.html(?:\.base64)?$/;
const APP_SERVER_SCHEMA_LOCK = "app-server-schema.lock.json";
const STATE_MIGRATION_CATALOG = "state-migrations.json";
const RELEASE_NOTES_DIRECTORY = "docs/releases";
const REQUIRED_PACKAGE_FILES = new Set([
  "dist",
  "README.md",
  "LICENSE",
  "scripts/text-integrity.mjs",
  "scripts/text-integrity.d.mts",
  ".codex-plugin",
  ".app.json",
  "release-manifest.json",
  "release-manifest.schema.json",
  UI_RELEASE_CATALOG_FILENAME,
  STATE_MIGRATION_CATALOG
]);
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLUGIN_APP_ID_PATTERN = /^plugin_asdk_app_[A-Za-z0-9]+$/;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const MACOS_ARCHITECTURES = ["arm64", "x64"];
const RELEASE_ASSET_NAMES = [
  "npm-tarball",
  "npm-sha256",
  "macos-arm64-app",
  "macos-x64-app",
  "release-checksums"
];
const STATE_SOURCE_SCHEMAS = Array.from({ length: 28 }, (_, index) => index + 3);
const STATE_MIGRATION_DEFINITIONS = [
  [3, 4, "migrateV3ToV4", "a49f5314925897e254c6f34dd9c956cbf31eb1d8", [
    ["src/stateStore.ts", "stableUuid"], ["src/stateStore.ts", "normalizeOptionalString"],
    ["src/stateStore.ts", "parsePayload"], ["src/agent.ts", "normalizeAgentName"],
    ["src/activity.ts", "ACTIVITY_JOB_STATUSES"], ["src/activity.ts", "isActiveActivityJobStatus"],
    ["src/activity.ts", "isTerminalActivityJobStatus"]
  ]],
  [4, 5, "migrateV4ToV5", "c9d89641409d841a0027b2c147ab7ef429e4d77a", []],
  [5, 6, "migrateV5ToV6", "3772b3efbbe016516cf09fd9b416e3c3761c11dd", []],
  [6, 7, "migrateV6ToV7", "8d01014653bc6d28d4b5e07df14206d648aa5360", []],
  [7, 8, "migrateV7ToV8", "c2c6eb18c10bd6aa853eabbe8b5f5bcb55a5baad", [
    ["src/stateStore.ts", "parsePayload"]
  ]],
  [8, 9, "migrateV8ToV9", "810e75677a087d89860664a243bdf600fa72f423", []],
  [9, 10, "migrateV9ToV10", "b9b040941685919fe2b70fbb6fec794309a622b1", [
    ["src/projectRegistry.ts", "createProjectRef"]
  ]],
  [10, 11, "migrateV10ToV11", "df77fc7f8944b759826dc75d73205b8bc0c3c672", [
    ["src/stateStore.ts", "tableHasColumn"],
    ["src/cancellation.ts", "CANCELLATION_REASON_MAX_LENGTH"]
  ]],
  [11, 12, "migrateV11ToV12", "df77fc7f8944b759826dc75d73205b8bc0c3c672", [
    ["src/stateStore.ts", "tableHasColumn"]
  ]],
  [12, 13, "migrateV12ToV13", "848d56510a7871b0d182955fba6838e8306a09d5", [
    ["src/questionStore.ts", "V13_QUESTION_STORE_MIGRATION_SCHEMA"]
  ]],
  [13, 14, "migrateV13ToV14", "848d56510a7871b0d182955fba6838e8306a09d5", [
    ["src/threadConnections.ts", "V14_THREAD_CONNECTION_MIGRATION_SCHEMA"],
    ["src/eventRetention.ts", "V14_EVENT_RETENTION_MIGRATION_SCHEMA"]
  ]],
  [14, 15, "migrateV14ToV15", "848d56510a7871b0d182955fba6838e8306a09d5", [
    ["src/workHistory.ts", "V15_WORK_HISTORY_MIGRATION_SCHEMA"]
  ]],
  [15, 17, "migrateV15OrV16ToV17", "848d56510a7871b0d182955fba6838e8306a09d5", [
    ["src/automaticRecovery.ts", "V17_AUTOMATIC_RECOVERY_MIGRATION_SCHEMA"]
  ]],
  [16, 17, "migrateV15OrV16ToV17", "848d56510a7871b0d182955fba6838e8306a09d5", [
    ["src/automaticRecovery.ts", "V17_AUTOMATIC_RECOVERY_MIGRATION_SCHEMA"]
  ]],
  [17, 18, "migrateV17ToV18", "25a7886c37f7b26ef36863627f1d56b01b2f2288", [
    ["src/stateStore.ts", "parsePayload"], ["src/stateStore.ts", "hasBlockingInteraction"],
    ["src/stateStore.ts", "nextScopeVersion"],
    ["src/activity.ts", "ACTIVITY_JOB_STATUSES"], ["src/activity.ts", "isActiveActivityJobStatus"]
  ]],
  [18, 19, "migrateV18ToV19", "848d56510a7871b0d182955fba6838e8306a09d5", [
    ["src/stateSchema.ts", "CURRENT_STATE_SCHEMA"],
    ["src/eventRetention.ts", "sanitizeRetainedJobSummary"],
    ["src/stateStore.ts", "legacyJsonRecord"],
    ["src/stateStore.ts", "nonNegativeInteger"],
    ["src/stateStore.ts", "optionalNonNegativeInteger"],
    ["src/stateStore.ts", "sqlIdentifier"]
  ]],
  [19, 20, "migrateV19ToV20", "7e7b0c53fc553afe2e3d3297b127a44e77246460", [
    ["src/stateSchema.ts", "V20_ASYNC_EXECUTION_MIGRATION_SCHEMA"]
  ]],
  [20, 21, "migrateV20ToV21", "129ac0a3e4e368bd00d71d92905b2507e5b36a04", [
    ["src/stateSchema.ts", "V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA"]
  ]],
  [21, 22, "migrateV21ToV22", "7d3d1dd2e9173e74636ceb9bf0582a4ed793ba6a", [
    ["src/stateSchema.ts", "V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA"]
  ]],
  [22, 23, "migrateV22ToV23", "100a85d569150138fed8c51f96d5d619f2d634c9", [
    ["src/stateSchema.ts", "V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA"]
  ]],
  [23, 24, "migrateV23ToV24", "b1e897a04e6d90128eb01ffc4071783f8d067731", [
    ["src/decisionCardStore.ts", "V24_DECISION_CARD_MIGRATION_SCHEMA"]
  ]],
  [24, 25, "migrateV24ToV25", "b763dba44d802483e4aad16fad9cc8df478b26a7", [
    ["src/operationalCommandReceipt.ts", "V25_OPERATIONAL_COMMAND_RECEIPT_MIGRATION_SCHEMA"]
  ]],
  [25, 26, "migrateV25ToV26", "f38129dcd64c4b90acc18e01416b7a2d210acf89", [
    ["src/stateSchema.ts", "V26_MODEL_DESCRIPTION_VERSIONS_MIGRATION_SCHEMA"]
  ]],
  [26, 27, "migrateV26ToV27", "9c97bde23da6533cf51c56e40a38b37650577a2f", [
    ["src/stateSchema.ts", "V27_DECISION_CARD_RETIREMENT_MIGRATION_SCHEMA"]
  ]],
  [27, 28, "migrateV27ToV28", "4c82f267886df895c06b425b7f349c6ff5534fd9", [
    ["src/stateSchema.ts", "V28_JOB_HISTORY_INDEX_MIGRATION_SCHEMA"]
  ]],
  [28, 29, "migrateV28ToV29", "830eec5cc696c607f550b8df189130ffb30655d2", [
    ["src/stateSchema.ts", "V29_BACKGROUND_WORK_INDEX_MIGRATION_SCHEMA"]
  ]],
  [29, 30, "migrateV29ToV30", "2a177a258ace53624a6c6b839f803bf24e028ad5", [
    ["src/stateSchema.ts", "V30_SESSION_AUTH_BOUNDARY_MIGRATION_SCHEMA"]
  ]],
  [30, 31, "migrateV30ToV31", "58d6d091b1d87002ac688e775d779caf3d2a3d1f", [
    ["src/cogateUnifiedSchema.ts", "V31_COGATE_UNIFIED_MIGRATION_SCHEMA"]
  ]]
];
const STATE_FIXTURE_DEFINITIONS = [
  [3, "published-release", "v0.3.0", "test/fixtures/state-v3-seeded.sql"],
  [16, "deployed-development", "17d7398c88fe83688165dcec2b27e85cdc9ce949", "test/fixtures/state-schema-v16.sql"],
  [18, "deployed-development", "b1104aa4b2f72b929f49f89b6c1734cf6cb9d61d", "test/fixtures/state-schema-v18.sql"]
];
const STATE_DERIVED_CHECKPOINTS = [
  ...Array.from({ length: 12 }, (_, index) => {
    const schema = index + 4;
    return [schema, 3, `bridge-state-${schema - 1}-to-${schema}`];
  }),
  [17, 16, "bridge-state-16-to-17"],
  [19, 18, "bridge-state-18-to-19"]
];

export function loadReleaseManifest(repoRoot = DEFAULT_REPO_ROOT) {
  const file = path.join(repoRoot, MANIFEST_FILENAME);
  let parsed;
  try {
    parsed = parseJsonUtf8Strict(readFileSync(file), MANIFEST_FILENAME);
  } catch (error) {
    throw new Error(`Could not read ${MANIFEST_FILENAME}: ${errorMessage(error)}`);
  }
  validateReleaseManifest(parsed);
  return parsed;
}

export function validateReleaseManifest(value) {
  const root = requiredRecord(value, "release manifest");
  assertKeys(
    root,
    ["$schema", "manifestVersion", "product", "package", "toolchain", "repository", "plugin", "uiResources", "stateCompatibility", "release"],
    "release manifest"
  );
  if (root.$schema !== "./release-manifest.schema.json") fail("$schema must reference ./release-manifest.schema.json");
  if (root.manifestVersion !== 6) fail("manifestVersion must be 6");

  const product = requiredRecord(root.product, "product");
  assertKeys(product, ["displayName", "description", "runtimeName"], "product");
  boundedString(product.displayName, "product.displayName", 100);
  boundedString(product.description, "product.description", 240);
  identifier(product.runtimeName, "product.runtimeName", PACKAGE_NAME_PATTERN, 100);

  const packageInfo = requiredRecord(root.package, "package");
  assertKeys(packageInfo, ["name", "binaryName", "license", "files", "keywords"], "package");
  identifier(packageInfo.name, "package.name", PACKAGE_NAME_PATTERN, 214);
  identifier(packageInfo.binaryName, "package.binaryName", PACKAGE_NAME_PATTERN, 100);
  boundedString(packageInfo.license, "package.license", 50);
  if (!Array.isArray(packageInfo.files) || packageInfo.files.length < 1 || packageInfo.files.length > 30) {
    fail("package.files must contain 1 to 30 entries");
  }
  const packageFiles = packageInfo.files.map((entry, index) => {
    const value = boundedString(entry, `package.files[${index}]`, 160);
    if (
      value.startsWith("/") ||
      value.includes("\\") ||
      value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
      !/^[A-Za-z0-9._/-]+$/.test(value)
    ) {
      fail(`package.files[${index}] must be a safe relative package path`);
    }
    return value;
  });
  if (new Set(packageFiles).size !== packageFiles.length) fail("package.files must be unique");
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!packageFiles.includes(required)) fail(`package.files must include ${required}`);
  }
  if (!Array.isArray(packageInfo.keywords) || packageInfo.keywords.length < 1 || packageInfo.keywords.length > 20) {
    fail("package.keywords must contain 1 to 20 entries");
  }
  const keywords = packageInfo.keywords.map((entry, index) =>
    identifier(entry, `package.keywords[${index}]`, PACKAGE_NAME_PATTERN, 50)
  );
  if (new Set(keywords).size !== keywords.length) fail("package.keywords must be unique");

  const toolchain = requiredRecord(root.toolchain, "toolchain");
  assertKeys(toolchain, ["node", "npm", "codexCli"], "toolchain");
  identifier(toolchain.node, "toolchain.node", /^(?:[2-9]\d*)$/, 3);
  identifier(toolchain.npm, "toolchain.npm", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 30);
  identifier(toolchain.codexCli, "toolchain.codexCli", SEMVER_PATTERN, 50);

  const repository = requiredRecord(root.repository, "repository");
  assertKeys(repository, ["provider", "owner", "name"], "repository");
  if (repository.provider !== "github") fail("repository.provider must be github");
  identifier(repository.owner, "repository.owner", GITHUB_OWNER_PATTERN, 39);
  identifier(repository.name, "repository.name", GITHUB_REPOSITORY_PATTERN, 100);

  const plugin = requiredRecord(root.plugin, "plugin");
  assertKeys(
    plugin,
    [
      "name",
      "displayName",
      "shortDescription",
      "longDescription",
      "developerName",
      "category",
      "capabilities",
      "defaultPrompt",
      "app"
    ],
    "plugin"
  );
  identifier(plugin.name, "plugin.name", PLUGIN_NAME_PATTERN, 64);
  boundedString(plugin.displayName, "plugin.displayName", 80);
  boundedString(plugin.shortDescription, "plugin.shortDescription", 80);
  boundedString(plugin.longDescription, "plugin.longDescription", 500);
  boundedString(plugin.developerName, "plugin.developerName", 80);
  boundedString(plugin.category, "plugin.category", 80);
  if (!Array.isArray(plugin.capabilities) || plugin.capabilities.length < 1 || plugin.capabilities.length > 12) {
    fail("plugin.capabilities must contain 1 to 12 entries");
  }
  const capabilities = plugin.capabilities.map((entry, index) =>
    boundedString(entry, `plugin.capabilities[${index}]`, 100)
  );
  if (new Set(capabilities).size !== capabilities.length) fail("plugin.capabilities must be unique");
  if (!Array.isArray(plugin.defaultPrompt) || plugin.defaultPrompt.length < 1 || plugin.defaultPrompt.length > 3) {
    fail("plugin.defaultPrompt must contain 1 to 3 entries");
  }
  const defaultPrompts = plugin.defaultPrompt.map((entry, index) =>
    boundedString(entry, `plugin.defaultPrompt[${index}]`, 128)
  );
  if (new Set(defaultPrompts).size !== defaultPrompts.length) fail("plugin.defaultPrompt must be unique");
  const app = requiredRecord(plugin.app, "plugin.app");
  assertKeys(app, ["name", "id"], "plugin.app");
  identifier(app.name, "plugin.app.name", PLUGIN_NAME_PATTERN, 64);
  identifier(app.id, "plugin.app.id", PLUGIN_APP_ID_PATTERN, 128);
  if (app.name !== plugin.name) fail("plugin.app.name must match plugin.name");

  const uiResources = requiredRecord(root.uiResources, "uiResources");
  assertKeys(
    uiResources,
    [
      "strategy",
      "hashAlgorithm",
      "minimumContractGeneration",
      "resources",
      "activeResources",
      "compatibilityResources",
      "releaseCatalog",
      "releaseCatalogSha256"
    ],
    "uiResources"
  );
  if (uiResources.strategy !== "versioned-uri") fail("uiResources.strategy must be versioned-uri");
  if (uiResources.hashAlgorithm !== "sha256") fail("uiResources.hashAlgorithm must be sha256");
  const minimumContractGeneration = requiredRecord(
    uiResources.minimumContractGeneration,
    "uiResources.minimumContractGeneration"
  );
  assertKeys(
    minimumContractGeneration,
    UI_RESOURCE_NAMES,
    "uiResources.minimumContractGeneration"
  );
  for (const name of UI_RESOURCE_NAMES) {
    const generation = minimumContractGeneration[name];
    if (!Number.isInteger(generation) || generation < 1) {
      fail(`uiResources.minimumContractGeneration.${name} must be a positive integer`);
    }
  }
  if (
    !Array.isArray(uiResources.resources) ||
    uiResources.resources.length !== UI_RESOURCE_NAMES.length ||
    UI_RESOURCE_NAMES.some((name) => !uiResources.resources.includes(name)) ||
    new Set(uiResources.resources).size !== uiResources.resources.length
  ) {
    fail(`uiResources.resources must contain ${UI_RESOURCE_NAMES.join(", ")} exactly once`);
  }
  if (!sameJson(uiResources.activeResources, UI_ACTIVE_RESOURCE_NAMES)) {
    fail(`uiResources.activeResources must be ${UI_ACTIVE_RESOURCE_NAMES.join(", ")} in that order`);
  }
  if (!sameJson(uiResources.compatibilityResources, UI_COMPATIBILITY_RESOURCE_NAMES)) {
    fail(
      `uiResources.compatibilityResources must be ${UI_COMPATIBILITY_RESOURCE_NAMES.join(", ")} in that order`
    );
  }
  if (uiResources.releaseCatalog !== UI_RELEASE_CATALOG_FILENAME) {
    fail(`uiResources.releaseCatalog must be ${UI_RELEASE_CATALOG_FILENAME}`);
  }
  if (!/^[0-9a-f]{64}$/.test(uiResources.releaseCatalogSha256)) {
    fail("uiResources.releaseCatalogSha256 must be a SHA-256 digest");
  }

  const stateCompatibility = requiredRecord(root.stateCompatibility, "stateCompatibility");
  assertKeys(
    stateCompatibility,
    [
      "currentSchema",
      "supportedSourceSchemas",
      "unsupportedSourceSchemas",
      "retiredLegacyImports",
      "migrationCatalog",
      "migrationCatalogSha256",
      "stateProfilePolicy",
      "rollbackPolicy",
      "persistentContracts",
      "contractSources",
      "recoveryContract"
    ],
    "stateCompatibility"
  );
  if (stateCompatibility.currentSchema !== 31) fail("stateCompatibility.currentSchema must be 31");
  if (
    !Array.isArray(stateCompatibility.supportedSourceSchemas) ||
    stateCompatibility.supportedSourceSchemas.length !== STATE_SOURCE_SCHEMAS.length ||
    stateCompatibility.supportedSourceSchemas.some(
      (schema, index) => schema !== STATE_SOURCE_SCHEMAS[index]
    )
  ) {
    fail(`stateCompatibility.supportedSourceSchemas must be ${STATE_SOURCE_SCHEMAS.join(", ")} in that order`);
  }
  if (JSON.stringify(stateCompatibility.unsupportedSourceSchemas) !== JSON.stringify([1, 2])) {
    fail("stateCompatibility.unsupportedSourceSchemas must be 1, 2 in that order");
  }
  if (
    JSON.stringify(stateCompatibility.retiredLegacyImports) !==
    JSON.stringify(["settings-state-json", "session-state-json", "job-state-json"])
  ) {
    fail("stateCompatibility.retiredLegacyImports must list the three retired JSON state stores");
  }
  if (stateCompatibility.migrationCatalog !== STATE_MIGRATION_CATALOG) {
    fail(`stateCompatibility.migrationCatalog must be ${STATE_MIGRATION_CATALOG}`);
  }
  if (!/^[0-9a-f]{64}$/.test(stateCompatibility.migrationCatalogSha256)) {
    fail("stateCompatibility.migrationCatalogSha256 must be a SHA-256 digest");
  }
  if (stateCompatibility.stateProfilePolicy !== "release-stage-isolated-v1") {
    fail("stateCompatibility.stateProfilePolicy must be release-stage-isolated-v1");
  }
  if (stateCompatibility.rollbackPolicy !== "verified-original-before-service-open-v1") {
    fail("stateCompatibility.rollbackPolicy must be verified-original-before-service-open-v1");
  }
  const persistentContracts = requiredRecord(
    stateCompatibility.persistentContracts,
    "stateCompatibility.persistentContracts"
  );
  assertKeys(
    persistentContracts,
    [
      "userSettingsSchema",
      "taskInputContract",
      "macosHelperProtocol",
      "localCompanionProtocol",
      "remoteCompanionProtocol"
    ],
    "stateCompatibility.persistentContracts"
  );
  const requiredContracts = {
    userSettingsSchema: 7,
    taskInputContract: 6,
    macosHelperProtocol: 2,
    localCompanionProtocol: 12,
    remoteCompanionProtocol: 10
  };
  for (const [name, expected] of Object.entries(requiredContracts)) {
    if (persistentContracts[name] !== expected) {
      fail(`stateCompatibility.persistentContracts.${name} must be ${expected}`);
    }
  }
  const requiredContractSources = {
    databaseSchema: "src/stateSchema.ts#CURRENT_STATE_SCHEMA_VERSION",
    userSettings: "src/modelPolicy.ts#MODEL_POLICY_SCHEMA_VERSION",
    taskInput: "src/tools.ts#CODEX_TASK_INPUT_CONTRACT_VERSION",
    macosHelper: "src/macosHelperServer.ts#MACOS_HELPER_PROTOCOL_VERSION",
    localCompanion: "src/companionServer.ts#COMPANION_PROTOCOL_VERSION",
    remoteCompanion: "src/remoteCompanionServer.ts#REMOTE_COMPANION_PROTOCOL_VERSION",
    uiResources: "uiResources.minimumContractGeneration",
    executionBackend: "toolchain.codexCli+app-server-schema.lock.json"
  };
  const contractSources = requiredRecord(stateCompatibility.contractSources, "stateCompatibility.contractSources");
  assertKeys(contractSources, Object.keys(requiredContractSources), "stateCompatibility.contractSources");
  if (!sameJson(contractSources, requiredContractSources)) {
    fail("stateCompatibility.contractSources must reference the canonical runtime contracts");
  }
  const recoveryContract = requiredRecord(
    stateCompatibility.recoveryContract,
    "stateCompatibility.recoveryContract"
  );
  const requiredRecoveryContract = {
    backupMetadataVersion: 1,
    restoreReceiptVersion: 1,
    sourceRuntimeMatch: "exact-product-version-and-build",
    settingsRestore: "database-snapshot-and-source-runtime-configuration",
    automaticSnapshotRestoreUntil: "service-open"
  };
  assertKeys(recoveryContract, Object.keys(requiredRecoveryContract), "stateCompatibility.recoveryContract");
  if (!sameJson(recoveryContract, requiredRecoveryContract)) {
    fail("stateCompatibility.recoveryContract does not match the supported recovery implementation");
  }

  const release = requiredRecord(root.release, "release");
  assertKeys(
    release,
    [
      "releaseUnitId",
      "version",
      "stage",
      "tagPrefix",
      "channel",
      "sourceVersion",
      "sourceCandidate",
      "generateNotes",
      "targets",
      "assets"
    ],
    "release"
  );
  if (release.releaseUnitId !== root.product.runtimeName) {
    fail("release.releaseUnitId must match product.runtimeName");
  }
  const semver = typeof release.version === "string" ? SEMVER_PATTERN.exec(release.version) : null;
  if (!semver) {
    fail("release.version must be a valid SemVer value");
  }
  if (semver[5]) fail("release.version cannot contain build metadata");
  if (!["development", "candidate", "stable", "deprecated"].includes(release.stage)) {
    fail("release.stage must be development, candidate, stable, or deprecated");
  }
  if (typeof release.tagPrefix !== "string" || !/^[A-Za-z0-9._-]{0,16}$/.test(release.tagPrefix)) {
    fail("release.tagPrefix contains unsupported characters");
  }
  const expectedChannel = releaseChannelForStage(release.stage);
  if (release.channel !== expectedChannel) {
    fail(`release.channel must be ${expectedChannel} for ${release.stage} stage`);
  }
  const candidate = candidateVersionParts(release.version);
  if (release.stage === "candidate" && !candidate) {
    fail("candidate stage requires an X.Y.Z-rc.N version");
  }
  if (release.stage !== "candidate" && semver[4]) {
    fail(`${release.stage} stage requires a suffix-free X.Y.Z version`);
  }
  if (release.stage === "stable") {
    const sourceCandidate = candidateVersionParts(release.sourceCandidate);
    if (!sourceCandidate) fail("stable stage requires release.sourceCandidate in X.Y.Z-rc.N form");
    if (sourceCandidate.base !== release.version) {
      fail("release.sourceCandidate must have the same numeric version as release.version");
    }
  } else if (release.sourceCandidate !== null) {
    fail(`release.sourceCandidate must be null for ${release.stage} stage`);
  }
  if (release.stage === "candidate" || release.stage === "stable") {
    const sourceVersion = baseVersionParts(release.sourceVersion);
    const targetVersion = baseVersionParts(candidate?.base ?? release.version);
    if (!sourceVersion) {
      fail(`${release.stage} stage requires release.sourceVersion in X.Y.Z form`);
    }
    if (!targetVersion || compareBaseVersions(sourceVersion, targetVersion) >= 0) {
      fail("release.sourceVersion must precede the target release version");
    }
  } else if (release.sourceVersion !== null) {
    fail(`release.sourceVersion must be null for ${release.stage} stage`);
  }
  if (typeof release.generateNotes !== "boolean") fail("release.generateNotes must be boolean");
  const targets = requiredRecord(release.targets, "release.targets");
  assertKeys(targets, ["macos"], "release.targets");
  const macosTarget = requiredRecord(targets.macos, "release.targets.macos");
  assertKeys(
    macosTarget,
    ["architectures", "format", "minimumVersion", "signing", "notarization"],
    "release.targets.macos"
  );
  if (
    !Array.isArray(macosTarget.architectures) ||
    macosTarget.architectures.length !== MACOS_ARCHITECTURES.length ||
    macosTarget.architectures.some(
      (architecture, index) => architecture !== MACOS_ARCHITECTURES[index]
    )
  ) {
    fail(`release.targets.macos.architectures must be ${MACOS_ARCHITECTURES.join(", ")} in that order`);
  }
  if (macosTarget.format !== "dmg") fail("release.targets.macos.format must be dmg");
  if (macosTarget.minimumVersion !== "13.0") fail("release.targets.macos.minimumVersion must be 13.0");
  if (macosTarget.signing !== "ad-hoc") fail("release.targets.macos.signing must be ad-hoc");
  if (macosTarget.notarization !== "none") fail("release.targets.macos.notarization must be none");

  if (
    !Array.isArray(release.assets) ||
    release.assets.length !== RELEASE_ASSET_NAMES.length ||
    RELEASE_ASSET_NAMES.some((name) => !release.assets.includes(name)) ||
    new Set(release.assets).size !== release.assets.length
  ) {
    fail(`release.assets must contain ${RELEASE_ASSET_NAMES.join(", ")} exactly once`);
  }
  return value;
}

export function deriveReleaseMetadata(manifest) {
  validateReleaseManifest(manifest);
  const repositorySlug = `${manifest.repository.owner}/${manifest.repository.name}`;
  const repositoryUrl = `https://github.com/${repositorySlug}`;
  const version = manifest.release.version;
  const semver = SEMVER_PATTERN.exec(version);
  const baseVersion = `${semver[1]}.${semver[2]}.${semver[3]}`;
  const tag = `${manifest.release.tagPrefix}${version}`;
  const packageFilename = `${manifest.package.name}-${version}.tgz`;
  const macosTarget = manifest.release.targets.macos;
  const sourceCandidate = manifest.release.sourceCandidate;
  const macosArchiveFilenames = Object.fromEntries(
    macosTarget.architectures.map((architecture) => [
      architecture,
      macosArchiveFilename(version, architecture, macosTarget.format)
    ])
  );
  const sourceCandidateMacosArchiveFilenames = Object.fromEntries(
    macosTarget.architectures.map((architecture) => [
      architecture,
      sourceCandidate
        ? macosArchiveFilename(sourceCandidate, architecture, macosTarget.format)
        : ""
    ])
  );
  return {
    manifestVersion: manifest.manifestVersion,
    releaseUnitId: manifest.release.releaseUnitId,
    displayName: manifest.product.displayName,
    runtimeName: manifest.product.runtimeName,
    packageName: manifest.package.name,
    binaryName: manifest.package.binaryName,
    nodeVersion: manifest.toolchain.node,
    nodeEngine: `>=${manifest.toolchain.node}`,
    npmVersion: manifest.toolchain.npm,
    codexCliVersion: manifest.toolchain.codexCli,
    version,
    stage: manifest.release.stage,
    sourceVersion: manifest.release.sourceVersion,
    sourceCandidate,
    sourceCandidateTag: sourceCandidate
      ? `${manifest.release.tagPrefix}${sourceCandidate}`
      : "",
    sourceCandidatePackageFilename: sourceCandidate
      ? `${manifest.package.name}-${sourceCandidate}.tgz`
      : "",
    sourceCandidateMacosArchiveFilenames,
    sourceCandidateMacosArm64ArchiveFilename: sourceCandidateMacosArchiveFilenames.arm64,
    sourceCandidateMacosX64ArchiveFilename: sourceCandidateMacosArchiveFilenames.x64,
    tag,
    releaseTitle: `${manifest.product.displayName} ${tag}`,
    releaseNotesFile: `${RELEASE_NOTES_DIRECTORY}/${baseVersion}.md`,
    channel: manifest.release.channel,
    prerelease: manifest.release.channel === "prerelease",
    generateNotes: manifest.release.generateNotes,
    packageFilename,
    checksumFilename: `${packageFilename}.sha256`,
    macosArchitectures: [...macosTarget.architectures],
    macosFormat: macosTarget.format,
    macosMinimumVersion: macosTarget.minimumVersion,
    macosArchiveFilenames,
    macosArm64ArchiveFilename: macosArchiveFilenames.arm64,
    macosX64ArchiveFilename: macosArchiveFilenames.x64,
    releaseChecksumsFilename: "SHA256SUMS.txt",
    repositorySlug,
    repositoryUrl,
    pluginName: manifest.plugin.name,
    pluginDisplayName: manifest.plugin.displayName,
    pluginDeveloperName: manifest.plugin.developerName,
    pluginCategory: manifest.plugin.category,
    pluginAppId: manifest.plugin.app.id
  };
}

function macosArchiveFilename(version, architecture, format) {
  return `Codex-MCP-Bridge-for-ChatGPT-${version}-macOS-${architecture}-unnotarized.${format}`;
}

export function derivePluginManifests(manifest) {
  validateReleaseManifest(manifest);
  const repositoryUrl = `https://github.com/${manifest.repository.owner}/${manifest.repository.name}`;
  const plugin = manifest.plugin;
  return {
    pluginManifest: {
      name: plugin.name,
      version: manifest.release.version,
      description: manifest.product.description,
      author: {
        name: plugin.developerName,
        url: `https://github.com/${manifest.repository.owner}`
      },
      homepage: `${repositoryUrl}#readme`,
      repository: repositoryUrl,
      license: manifest.package.license,
      keywords: [...manifest.package.keywords],
      apps: `./${APP_MANIFEST_FILENAME}`,
      interface: {
        displayName: plugin.displayName,
        shortDescription: plugin.shortDescription,
        longDescription: plugin.longDescription,
        developerName: plugin.developerName,
        category: plugin.category,
        capabilities: [...plugin.capabilities],
        websiteURL: repositoryUrl,
        defaultPrompt: [...plugin.defaultPrompt]
      }
    },
    appManifest: {
      apps: {
        [plugin.app.name]: {
          id: plugin.app.id,
          category: plugin.category
        }
      }
    }
  };
}

export function expectedStateMigrationCatalog(repoRoot = DEFAULT_REPO_ROOT) {
  const stateStoreSource = readTextFile(path.join(repoRoot, "src/stateStore.ts"), "src/stateStore.ts");
  const migrations = STATE_MIGRATION_DEFINITIONS.map(
    ([fromSchema, toSchema, implementation, introducedCommit, dependencies]) => {
      const method = extractPrivateMethod(stateStoreSource, implementation);
      const hash = createHash("sha256");
      hash.update(`src/stateStore.ts#${implementation}\0`);
      hash.update(method);
      for (const [relative, symbol] of dependencies) {
        hash.update(`\0${relative}#${symbol}\0`);
        hash.update(extractNamedDeclaration(
          readTextFile(path.join(repoRoot, relative), relative),
          symbol
        ));
      }
      return {
        id: `bridge-state-${fromSchema}-to-${toSchema}`,
        fromSchema,
        toSchema,
        implementation,
        introducedCommit,
        sha256: hash.digest("hex")
      };
    }
  );
  const fixtures = STATE_FIXTURE_DEFINITIONS.map(([schema, kind, source, relative]) => ({
    schema,
    kind,
    source,
    path: relative,
    sha256: sha256(readFileSync(path.join(repoRoot, relative)))
  }));
  return {
    catalogVersion: 1,
    immutabilityPolicy: "append-only-after-release-v1",
    currentSchema: 31,
    supportedSourceSchemas: [...STATE_SOURCE_SCHEMAS],
    unsupportedSourceSchemas: [1, 2],
    retiredLegacyImports: [
      "settings-state-json",
      "session-state-json",
      "job-state-json"
    ],
    migrations,
    fixtures,
    derivedCheckpoints: STATE_DERIVED_CHECKPOINTS.map(
      ([schema, sourceFixtureSchema, afterMigrationId]) => ({
        schema,
        kind: "derived-migration-checkpoint",
        sourceFixtureSchema,
        afterMigrationId
      })
    )
  };
}

export function checkStateCompatibility(repoRoot, manifest) {
  const catalogFile = path.join(repoRoot, STATE_MIGRATION_CATALOG);
  const expectedCatalog = expectedStateMigrationCatalog(repoRoot);
  if (!jsonFileMatches(catalogFile, expectedCatalog)) {
    throw new Error(
      `${STATE_MIGRATION_CATALOG} does not match the migration implementations or fixtures. ` +
      "Run npm run release:sync and review every checksum change."
    );
  }
  const catalogDigest = sha256(readFileSync(catalogFile));
  if (manifest.stateCompatibility.migrationCatalogSha256 !== catalogDigest) {
    throw new Error(
      `release-manifest.json state migration catalog digest is ${manifest.stateCompatibility.migrationCatalogSha256}, ` +
      `expected ${catalogDigest}. Run npm run release:sync.`
    );
  }
  const runtimeContracts = {
    currentSchema: sourceInteger(
      repoRoot,
      "src/stateSchema.ts",
      /CURRENT_STATE_SCHEMA_VERSION\s*=\s*["'](\d+)["']/,
      "CURRENT_STATE_SCHEMA_VERSION"
    ),
    userSettingsSchema: sourceInteger(
      repoRoot,
      "src/modelPolicy.ts",
      /MODEL_POLICY_SCHEMA_VERSION\s*=\s*(\d+)/,
      "MODEL_POLICY_SCHEMA_VERSION"
    ),
    taskInputContract: sourceInteger(
      repoRoot,
      "src/tools.ts",
      /CODEX_TASK_INPUT_CONTRACT_VERSION\s*=\s*["'](\d+)["']/,
      "CODEX_TASK_INPUT_CONTRACT_VERSION"
    ),
    taskExecutionEnvelopeInputContract: sourceInteger(
      repoRoot,
      "src/userSettings.ts",
      /taskInputContract:\s*(\d+)/,
      "task execution-envelope input contract"
    ),
    macosHelperProtocol: sourceInteger(
      repoRoot,
      "src/macosHelperServer.ts",
      /MACOS_HELPER_PROTOCOL_VERSION\s*=\s*(\d+)/,
      "MACOS_HELPER_PROTOCOL_VERSION"
    ),
    localCompanionProtocol: sourceInteger(
      repoRoot,
      "src/companionServer.ts",
      /COMPANION_PROTOCOL_VERSION\s*=\s*(\d+)/,
      "COMPANION_PROTOCOL_VERSION"
    ),
    remoteCompanionProtocol: sourceInteger(
      repoRoot,
      "src/remoteCompanionServer.ts",
      /REMOTE_COMPANION_PROTOCOL_VERSION\s*=\s*(\d+)/,
      "REMOTE_COMPANION_PROTOCOL_VERSION"
    )
  };
  if (runtimeContracts.currentSchema !== manifest.stateCompatibility.currentSchema) {
    throw new Error("State schema runtime constant drifted from release-manifest.json.");
  }
  for (const name of [
    "userSettingsSchema",
    "taskInputContract",
    "macosHelperProtocol",
    "localCompanionProtocol",
    "remoteCompanionProtocol"
  ]) {
    if (runtimeContracts[name] !== manifest.stateCompatibility.persistentContracts[name]) {
      throw new Error(`${name} runtime constant drifted from release-manifest.json.`);
    }
  }
  if (runtimeContracts.taskExecutionEnvelopeInputContract !== runtimeContracts.taskInputContract) {
    throw new Error(
      "Task execution-envelope input contract drifted from CODEX_TASK_INPUT_CONTRACT_VERSION."
    );
  }
  return expectedCatalog;
}

function extractPrivateMethod(source, name) {
  const marker = `\n  private ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Could not find state migration implementation ${name}.`);
  const next = source.indexOf("\n  private ", start + marker.length);
  if (next < 0) throw new Error(`Could not find the end of state migration implementation ${name}.`);
  return source.slice(start + 1, next).trimEnd();
}

function extractNamedDeclaration(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:export\\s+)?const\\s+${escaped}\\b`),
    new RegExp(`(?:export\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`private\\s+${escaped}\\s*\\(`)
  ];
  let match = null;
  for (const pattern of patterns) {
    match = pattern.exec(source);
    if (match) break;
  }
  if (!match) throw new Error(`Could not find migration dependency declaration ${name}.`);
  const start = match.index;
  const isConstant = /(?:export\s+)?const\s+/.test(match[0]);
  let quote = null;
  let escapedCharacter = false;
  let lineComment = false;
  let blockComment = false;
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  let sawBody = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escapedCharacter) escapedCharacter = false;
      else if (character === "\\") escapedCharacter = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") {
      braces += 1;
      sawBody = true;
    } else if (character === "}") {
      braces -= 1;
      if (!isConstant && sawBody && braces === 0) {
        const nextToken = source.slice(index + 1).match(/\S/)?.[0];
        if (nextToken !== "{") return source.slice(start, index + 1);
      }
    } else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (
      isConstant &&
      character === ";" &&
      braces === 0 &&
      parentheses === 0 &&
      brackets === 0
    ) return source.slice(start, index + 1);
  }
  throw new Error(`Could not find the end of migration dependency declaration ${name}.`);
}

function sourceInteger(repoRoot, relative, pattern, label) {
  const source = readTextFile(path.join(repoRoot, relative), relative);
  const match = pattern.exec(source);
  if (!match) throw new Error(`Could not read ${label} from ${relative}.`);
  return Number(match[1]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function checkReleaseMetadata(repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const packageVersion = packageVersionFromSource(repoRoot);
  if (manifest.release.version !== packageVersion) {
    throw new Error(
      `Release version ${manifest.release.version} does not match package.json version ${packageVersion}. ` +
      "package.json is the bridge/runtime version source of truth; run npm run release:sync."
    );
  }
  const prepared = preparePackageMetadata(repoRoot, manifest);
  const drift = [];
  if (!sameJson(prepared.packageJson, prepared.nextPackageJson)) drift.push("package.json");
  if (!sameJson(prepared.packageLock, prepared.nextPackageLock)) drift.push("package-lock.json");
  const pluginManifests = derivePluginManifests(manifest);
  if (!jsonFileMatches(path.join(repoRoot, PLUGIN_MANIFEST_FILENAME), pluginManifests.pluginManifest)) {
    drift.push(PLUGIN_MANIFEST_FILENAME);
  }
  if (!jsonFileMatches(path.join(repoRoot, APP_MANIFEST_FILENAME), pluginManifests.appManifest)) {
    drift.push(APP_MANIFEST_FILENAME);
  }
  if (drift.length > 0) {
    throw new Error(`Release metadata drift in ${drift.join(", ")}. Run npm run release:sync.`);
  }
  const appServerSchemaLock = readJson(path.join(repoRoot, APP_SERVER_SCHEMA_LOCK));
  validateAppServerSchemaLockMetadata(appServerSchemaLock, manifest.toolchain.codexCli);
  checkStateCompatibility(repoRoot, manifest);
  if (existsSync(path.join(repoRoot, "scripts/render-ui-resources.ts"))) {
    checkUiResources(repoRoot, manifest);
  }
  const metadata = deriveReleaseMetadata(manifest);
  checkReleaseNotesFile(repoRoot, metadata);
  return metadata;
}

function checkReleaseNotesFile(repoRoot, metadata) {
  if (metadata.stage !== "candidate" && metadata.stage !== "stable") return;
  const file = path.join(repoRoot, metadata.releaseNotesFile);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`Release notes ${metadata.releaseNotesFile} are required for ${metadata.stage} stage.`);
  }
  const notes = readTextFile(file, metadata.releaseNotesFile).trim();
  if (notes.length < 200) {
    throw new Error(`Release notes ${metadata.releaseNotesFile} are incomplete.`);
  }
}

export function validateAppServerSchemaLockMetadata(value, expectedCodexCliVersion) {
  const lock = requiredRecord(value, "App Server schema lock");
  assertKeys(
    lock,
    ["lockVersion", "supportedCodexCliVersion", "includeExperimental", "jsonSchema", "typescript"],
    "App Server schema lock"
  );
  if (lock.lockVersion !== 1) throw new Error("Invalid App Server schema lock: lockVersion must be 1.");
  if (lock.supportedCodexCliVersion !== expectedCodexCliVersion) {
    throw new Error(
      `App Server schema lock targets Codex CLI ${String(lock.supportedCodexCliVersion)} but ` +
      `release-manifest.json supports ${expectedCodexCliVersion}. Run npm run app-server:compat:update.`
    );
  }
  if (lock.includeExperimental !== true) {
    throw new Error("Invalid App Server schema lock: includeExperimental must be true.");
  }
  validateSchemaFingerprint(lock.jsonSchema, "jsonSchema");
  validateSchemaFingerprint(lock.typescript, "typescript");
  return value;
}

export function syncReleaseMetadata(repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const catalog = expectedStateMigrationCatalog(repoRoot);
  const uiReleaseCatalog = loadUiReleaseCatalog(repoRoot);
  if (existsSync(path.join(repoRoot, STATE_MIGRATION_CATALOG))) {
    assertImmutableStateMigrationHistory(
      readJson(path.join(repoRoot, STATE_MIGRATION_CATALOG)),
      catalog
    );
  }
  writeJsonArtifactIfChanged(path.join(repoRoot, STATE_MIGRATION_CATALOG), catalog);
  const withStateCatalog = structuredClone(manifest);
  withStateCatalog.stateCompatibility.migrationCatalogSha256 = sha256(
    `${JSON.stringify(catalog, null, 2)}\n`
  );
  withStateCatalog.uiResources.releaseCatalogSha256 = uiReleaseCatalogSha256(uiReleaseCatalog);
  const synchronizedManifest = manifestForPackageVersion(withStateCatalog, packageVersionFromSource(repoRoot));
  const prepared = preparePackageMetadata(repoRoot, synchronizedManifest);
  writeJsonIfChanged(path.join(repoRoot, MANIFEST_FILENAME), manifest, synchronizedManifest);
  writeJsonIfChanged(path.join(repoRoot, "package.json"), prepared.packageJson, prepared.nextPackageJson);
  writeJsonIfChanged(path.join(repoRoot, "package-lock.json"), prepared.packageLock, prepared.nextPackageLock);
  writePluginManifests(repoRoot, synchronizedManifest);
  if (existsSync(path.join(repoRoot, "scripts/render-ui-resources.ts"))) {
    syncUiResources(repoRoot, synchronizedManifest);
  }
  return deriveReleaseMetadata(synchronizedManifest);
}

function assertImmutableStateMigrationHistory(previous, next) {
  for (const collection of ["migrations", "fixtures", "derivedCheckpoints"]) {
    if (!Array.isArray(previous?.[collection]) || !Array.isArray(next?.[collection])) {
      throw new Error(`State migration catalog ${collection} must be an array.`);
    }
    for (const recorded of previous[collection]) {
      const identity = collection === "migrations"
        ? recorded?.id
        : collection === "fixtures"
          ? recorded?.schema
          : `${recorded?.schema}:${recorded?.sourceFixtureSchema}`;
      const candidate = next[collection].find((entry) => {
        const nextIdentity = collection === "migrations"
          ? entry?.id
          : collection === "fixtures"
            ? entry?.schema
            : `${entry?.schema}:${entry?.sourceFixtureSchema}`;
        return nextIdentity === identity;
      });
      if (!candidate || !sameJson(recorded, candidate)) {
        throw new Error(
          `Immutable state migration ${collection} entry ${String(identity)} changed or disappeared. ` +
          "Keep the deployed entry and add a new schema migration or provenance record."
        );
      }
    }
  }
}

export function deriveUiResourceManifest(
  manifest,
  rendered,
  catalog = loadUiReleaseCatalog(DEFAULT_REPO_ROOT)
) {
  validateReleaseManifest(manifest);
  validateUiReleaseCatalog(catalog);
  const config = manifest.uiResources;
  if (!sameJson(catalog.activeResources, config.activeResources) ||
      !sameJson(catalog.compatibilityResources, config.compatibilityResources)) {
    throw new Error("UI release catalog lifecycle does not match release-manifest.json.");
  }
  const resources = {};
  const seenUris = new Set();
  for (const name of config.resources) {
    const html = rendered?.resources?.[name]?.html;
    if (typeof html !== "string" || !html.trim()) {
      throw new Error(`Rendered UI resource ${name} is missing final HTML.`);
    }
    const metadata = rendered?.resources?.[name]?.metadata;
    if (!isRecord(metadata)) {
      throw new Error(`Rendered UI resource ${name} is missing canonical cache metadata.`);
    }
    const digest = uiResourceDigest(config.hashAlgorithm, html, metadata);
    const contract = catalog.currentContracts[name];
    const uriVersion = contract.uriVersion;
    const uri = `ui://${manifest.product.runtimeName}/${name}/v${uriVersion}.html`;
    const minimumContractGeneration = config.minimumContractGeneration[name];
    const currentContractGeneration = uiContractGeneration({ metadata });
    if (currentContractGeneration === undefined) {
      throw new Error(`Rendered UI resource ${name} is missing codex/uiContractGeneration metadata.`);
    }
    if (currentContractGeneration < minimumContractGeneration) {
      throw new Error(
        `Rendered UI resource ${name} contract generation ${currentContractGeneration} is older than ` +
        `the supported minimum ${minimumContractGeneration}.`
      );
    }
    if (!config.activeResources.includes(name)) {
      throw new Error(`UI resource ${name} is not active in release-manifest.json.`);
    }
    if (seenUris.has(uri)) throw new Error(`UI resource URI collision: ${uri}.`);
    seenUris.add(uri);
    resources[name] = {
      uriVersion,
      digest,
      uri,
      metadata: structuredClone(metadata),
      releaseProvenance: {
        inventories: ["development-current"],
        sourceIds: ["rendered-current"],
        presenterTool: contract.presenterTool,
        requiredTools: [...contract.requiredTools]
      }
    };
  }
  const selected = Object.entries(resources).map(([name, revision]) => ({
      name,
      uriVersion: revision.uriVersion,
      digest: revision.digest,
      uri: revision.uri,
      ...structuredClone(revision.releaseProvenance)
    }));
  return {
    manifestVersion: 3,
    strategy: config.strategy,
    hashAlgorithm: config.hashAlgorithm,
    minimumContractGeneration: structuredClone(config.minimumContractGeneration),
    releaseInventory: {
      catalog: UI_RELEASE_CATALOG_FILENAME,
      catalogSha256: uiReleaseCatalogSha256(catalog),
      activeResources: [...catalog.activeResources],
      compatibilityResources: [...catalog.compatibilityResources],
      retirement: structuredClone(catalog.retirement),
      selected
    },
    resources
  };
}

export function syncUiResources(repoRoot = DEFAULT_REPO_ROOT, manifest = loadReleaseManifest(repoRoot)) {
  const rendered = renderUiResources(repoRoot);
  const catalog = loadUiReleaseCatalog(repoRoot);
  const lockFile = path.join(repoRoot, UI_LOCK_FILENAME);
  const next = deriveUiResourceManifest(manifest, rendered, catalog);

  for (const name of manifest.uiResources.resources) {
    writeTextAtomically(uiResourceSourceFile(repoRoot, name), rendered.resources[name].html);
  }
  cleanupLegacyUiResourceSnapshots(repoRoot);
  writeJsonAtomically(lockFile, next);
  writeTextAtomically(path.join(repoRoot, UI_GENERATED_SOURCE), generatedUiManifestSource(next));
  copyUiResourcesToDist(repoRoot, next);
  return next;
}

export function copyUiResourcesToDist(
  repoRoot = DEFAULT_REPO_ROOT,
  resourceManifest = undefined
) {
  const selected = resourceManifest ?? readJson(path.join(repoRoot, UI_LOCK_FILENAME));
  if (selected?.manifestVersion !== 3 || selected?.strategy !== "versioned-uri") {
    throw new Error(`${UI_LOCK_FILENAME} does not use the current versioned-URI policy.`);
  }
  const resourceNames = Object.keys(selected.resources || {});
  if (!sameJson(resourceNames, UI_ACTIVE_RESOURCE_NAMES)) {
    throw new Error(`${UI_LOCK_FILENAME} must contain only ${UI_ACTIVE_RESOURCE_NAMES.join(", ")}.`);
  }
  const expectedFiles = expectedUiResourceFiles();
  const actualFiles = listUiResourceFiles(repoRoot);
  if (!sameJson(actualFiles, expectedFiles)) {
    throw new Error(
      `${UI_RESOURCE_DIRECTORY} must contain only ${expectedFiles.join(", ")}; found ${actualFiles.join(", ") || "nothing"}.`
    );
  }

  const targetRoot = path.join(repoRoot, "dist", "ui");
  rmSync(targetRoot, { recursive: true, force: true });
  mkdirSync(targetRoot, { recursive: true });
  for (const name of UI_ACTIVE_RESOURCE_NAMES) {
    const revision = selected.resources[name];
    const html = readTextFile(uiResourceSourceFile(repoRoot, name), `UI resource ${name}`);
    if (uiResourceDigest(selected.hashAlgorithm, html, revision.metadata) !== revision.digest) {
      throw new Error(`Current UI resource digest does not match: ${name}.`);
    }
    writeTextAtomically(path.join(targetRoot, `${name}.html`), html);
  }
  writeJsonAtomically(path.join(repoRoot, "dist", "ui-manifest.json"), selected);
  return selected;
}

export function checkUiResources(repoRoot = DEFAULT_REPO_ROOT, manifest = loadReleaseManifest(repoRoot)) {
  const lockFile = path.join(repoRoot, UI_LOCK_FILENAME);
  if (!existsSync(lockFile)) {
    throw new Error(`${UI_LOCK_FILENAME} is missing. Run npm run release:sync.`);
  }
  const lock = readJson(lockFile);
  const catalog = loadUiReleaseCatalog(repoRoot);
  const catalogDigest = uiReleaseCatalogSha256(catalog);
  if (manifest.uiResources.releaseCatalogSha256 !== catalogDigest) {
    throw new Error(
      `${UI_RELEASE_CATALOG_FILENAME} digest does not match release-manifest.json. Run npm run release:sync.`
    );
  }
  const rendered = renderUiResources(repoRoot);
  const expected = deriveUiResourceManifest(manifest, rendered, catalog);
  const drift = [];
  if (!sameJson(lock, expected)) drift.push(UI_LOCK_FILENAME);
  const generatedFile = path.join(repoRoot, UI_GENERATED_SOURCE);
  if (!existsSync(generatedFile) || readTextFile(generatedFile, UI_GENERATED_SOURCE) !== generatedUiManifestSource(expected)) {
    drift.push(UI_GENERATED_SOURCE);
  }

  const descriptorFiles = ["src/tools.ts"]
    .filter((relative) => existsSync(path.join(repoRoot, relative)));
  const descriptorSource = descriptorFiles.map((relative) =>
    readTextFile(path.join(repoRoot, relative), relative)
  ).join("\n");
  const expectedFiles = expectedUiResourceFiles();
  const actualFiles = listUiResourceFiles(repoRoot);
  if (!sameJson(actualFiles, expectedFiles)) drift.push(`${UI_RESOURCE_DIRECTORY} file inventory`);
  for (const name of manifest.uiResources.resources) {
    const entry = expected.resources[name];
    if (rendered.resources[name].uri !== entry.uri) drift.push(`runtime ${name} resource URI`);
    const sourceFile = uiResourceSourceFile(repoRoot, name);
    if (!existsSync(sourceFile)) {
      drift.push(`${name} current HTML file`);
      continue;
    }
    const html = readTextFile(sourceFile, `UI resource ${name}`);
    if (uiResourceDigest(expected.hashAlgorithm, html, entry.metadata) !== entry.digest) {
      drift.push(`${name} current HTML digest`);
    }
    if (html !== rendered.resources[name].html) {
      drift.push(`${name} current HTML file`);
    }
  }
  for (const name of manifest.uiResources.resources) {
    const constant = `${name.toUpperCase()}_CARD_URI`;
    const escaped = constant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`ui:\\s*\\{[\\s\\S]{0,120}?resourceUri:\\s*${escaped}\\b`).test(descriptorSource)) {
      drift.push(`${constant} _meta.ui.resourceUri`);
    }
    if (!new RegExp(`['\"]openai/outputTemplate['\"]:\\s*${escaped}`).test(descriptorSource)) {
      drift.push(`${constant} openai/outputTemplate`);
    }
  }
  if (drift.length > 0) {
    throw new Error(`UI resource drift in ${[...new Set(drift)].join(", ")}. Run npm run release:sync.`);
  }
  return expected;
}

export function setReleaseVersion(requested, repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const version = resolveVersion(packageVersionFromSource(repoRoot), requested);
  const candidate = candidateVersionParts(version);
  const sameBasePromotion = manifest.release.stage === "candidate" &&
    candidateVersionParts(manifest.release.version)?.base === version;
  const stage = candidate ? "candidate" : sameBasePromotion ? "stable" : "development";
  const sourceCandidate = stage === "stable" ? manifest.release.version : null;
  const sourceVersion = stage === "candidate"
    ? manifest.release.stage === "candidate"
      ? manifest.release.sourceVersion
      : packageVersionFromSource(repoRoot)
    : stage === "stable"
      ? manifest.release.sourceVersion
      : null;
  return setReleaseState({ version, stage, sourceVersion, sourceCandidate }, repoRoot);
}

export function setReleaseState(state, repoRoot = DEFAULT_REPO_ROOT) {
  const manifest = loadReleaseManifest(repoRoot);
  const version = resolveVersion(packageVersionFromSource(repoRoot), state?.version);
  const nextManifest = manifestForReleaseState(
    manifest,
    version,
    state?.stage,
    state?.sourceVersion ?? null,
    state?.sourceCandidate ?? null
  );
  const prepared = preparePackageMetadata(repoRoot, nextManifest);
  writeJsonAtomically(path.join(repoRoot, MANIFEST_FILENAME), nextManifest);
  writeJsonIfChanged(path.join(repoRoot, "package.json"), prepared.packageJson, prepared.nextPackageJson);
  writeJsonIfChanged(path.join(repoRoot, "package-lock.json"), prepared.packageLock, prepared.nextPackageLock);
  writePluginManifests(repoRoot, nextManifest);
  return deriveReleaseMetadata(nextManifest);
}

function writePluginManifests(repoRoot, manifest) {
  const derived = derivePluginManifests(manifest);
  writeJsonArtifactIfChanged(path.join(repoRoot, PLUGIN_MANIFEST_FILENAME), derived.pluginManifest);
  writeJsonArtifactIfChanged(path.join(repoRoot, APP_MANIFEST_FILENAME), derived.appManifest);
}

function preparePackageMetadata(repoRoot, manifest) {
  const metadata = deriveReleaseMetadata(manifest);
  const packageFile = path.join(repoRoot, "package.json");
  const lockFile = path.join(repoRoot, "package-lock.json");
  const packageJson = readJson(packageFile);
  const packageLock = readJson(lockFile);
  if (!isRecord(packageLock.packages) || !isRecord(packageLock.packages[""])) {
    throw new Error("package-lock.json is missing packages[''] metadata.");
  }

  const nextPackageJson = structuredClone(packageJson);
  nextPackageJson.name = metadata.packageName;
  nextPackageJson.version = metadata.version;
  nextPackageJson.description = manifest.product.description;
  nextPackageJson.packageManager = `npm@${metadata.npmVersion}`;
  nextPackageJson.bin = { [metadata.binaryName]: "dist/cli.js" };
  nextPackageJson.files = [...manifest.package.files];
  nextPackageJson.keywords = [...manifest.package.keywords];
  nextPackageJson.license = manifest.package.license;
  nextPackageJson.repository = { type: "git", url: `${metadata.repositoryUrl}.git` };
  nextPackageJson.homepage = `${metadata.repositoryUrl}#readme`;
  nextPackageJson.bugs = { url: `${metadata.repositoryUrl}/issues` };
  nextPackageJson.engines = { node: metadata.nodeEngine };

  const nextPackageLock = structuredClone(packageLock);
  nextPackageLock.name = metadata.packageName;
  nextPackageLock.version = metadata.version;
  nextPackageLock.packages[""].name = metadata.packageName;
  nextPackageLock.packages[""].version = metadata.version;
  return { packageJson, nextPackageJson, packageLock, nextPackageLock };
}

function packageVersionFromSource(repoRoot) {
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  if (typeof packageJson.version !== "string" || !SEMVER_PATTERN.test(packageJson.version)) {
    throw new Error("package.json version must be a valid SemVer value.");
  }
  return packageJson.version;
}

function manifestForPackageVersion(manifest, version) {
  return manifestForReleaseState(
    manifest,
    version,
    manifest.release.stage,
    manifest.release.sourceVersion,
    manifest.release.sourceCandidate
  );
}

function manifestForReleaseState(manifest, version, stage, sourceVersion, sourceCandidate) {
  const nextManifest = structuredClone(manifest);
  nextManifest.release.version = version;
  nextManifest.release.stage = stage;
  nextManifest.release.channel = releaseChannelForStage(stage);
  nextManifest.release.sourceVersion = sourceVersion;
  nextManifest.release.sourceCandidate = sourceCandidate;
  validateReleaseManifest(nextManifest);
  return nextManifest;
}

function releaseChannelForStage(stage) {
  if (stage === "candidate") return "prerelease";
  if (stage === "stable") return "stable";
  return "none";
}

function candidateVersionParts(version) {
  if (typeof version !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/.exec(version);
  if (!match) return null;
  return {
    base: `${match[1]}.${match[2]}.${match[3]}`,
    rc: Number(match[4])
  };
}

function baseVersionParts(version) {
  if (typeof version !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareBaseVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function resolveVersion(current, requested) {
  if (requested === "major" || requested === "minor" || requested === "patch") {
    const match = SEMVER_PATTERN.exec(current);
    if (!match) fail(`Cannot increment invalid current version: ${current}`);
    let major = Number(match[1]);
    let minor = Number(match[2]);
    let patch = Number(match[3]);
    if (requested === "major") {
      major += 1;
      minor = 0;
      patch = 0;
    } else if (requested === "minor") {
      minor += 1;
      patch = 0;
    } else {
      patch += 1;
    }
    return `${major}.${minor}.${patch}`;
  }
  if (typeof requested === "string" && SEMVER_PATTERN.test(requested)) return requested;
  throw new Error("Version must be major, minor, patch, or an exact SemVer value.");
}

function requiredRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(`${label} keys must be exactly: ${wanted.join(", ")}`);
  }
}

function boundedString(value, label, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || /[\r\n\0]/.test(value)) {
    fail(`${label} must be a single-line string of at most ${maxLength} characters`);
  }
  return value;
}

function identifier(value, label, pattern, maxLength) {
  boundedString(value, label, maxLength);
  if (!pattern.test(value)) fail(`${label} contains unsupported characters`);
  return value;
}

function validateSchemaFingerprint(value, label) {
  const fingerprint = requiredRecord(value, `App Server schema lock ${label}`);
  assertKeys(fingerprint, ["fileCount", "sha256"], `App Server schema lock ${label}`);
  if (!Number.isSafeInteger(fingerprint.fileCount) || fingerprint.fileCount <= 0) {
    throw new Error(`Invalid App Server schema lock: ${label}.fileCount must be a positive integer.`);
  }
  if (typeof fingerprint.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint.sha256)) {
    throw new Error(`Invalid App Server schema lock: ${label}.sha256 must be a SHA-256 digest.`);
  }
}

function readJson(file) {
  try {
    return parseJsonUtf8Strict(readFileSync(file), path.basename(file));
  } catch (error) {
    throw new Error(`Could not read ${path.basename(file)}: ${errorMessage(error)}`);
  }
}

function renderUiResources(repoRoot) {
  const script = path.join(repoRoot, "scripts/render-ui-resources.ts");
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", script],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (error) {
    throw new Error(`Could not render final UI resources: ${errorMessage(error)}`);
  }
  let rendered;
  try {
    rendered = parseJsonUtf8Strict(stdout, "UI resource renderer output");
  } catch (error) {
    throw new Error(`UI resource renderer returned invalid JSON: ${errorMessage(error)}`);
  }
  for (const name of UI_RESOURCE_NAMES) {
    const resource = rendered?.resources?.[name];
    if (
      !isRecord(resource) ||
      typeof resource.uri !== "string" ||
      typeof resource.html !== "string" ||
      !isRecord(resource.metadata)
    ) {
      throw new Error(`UI resource renderer omitted ${name}.`);
    }
  }
  return rendered;
}

function uiResourceSourceFile(repoRoot, name) {
  return path.join(repoRoot, UI_RESOURCE_DIRECTORY, `${name}.html`);
}

function expectedUiResourceFiles() {
  return UI_ACTIVE_RESOURCE_NAMES.map((name) => `${name}.html`).sort();
}

function listUiResourceFiles(repoRoot) {
  const root = path.join(repoRoot, UI_RESOURCE_DIRECTORY);
  if (!existsSync(root)) return [];
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(root, "");
  return files.sort();
}

function cleanupLegacyUiResourceSnapshots(repoRoot) {
  const root = path.join(repoRoot, UI_RESOURCE_DIRECTORY);
  for (const name of LEGACY_UI_RESOURCE_DIRECTORIES) {
    const directory = path.join(root, name);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isFile() && LEGACY_UI_SNAPSHOT_PATTERN.test(entry.name)) {
        rmSync(path.join(directory, entry.name), { force: true });
      }
    }
    if (readdirSync(directory).length === 0) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function uiContractGeneration(revision) {
  const value = revision?.metadata?.content?.["codex/uiContractGeneration"];
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function uiResourceDigest(algorithm, html, metadata) {
  return createHash(algorithm)
    .update(stableJson({ html, metadata }))
    .digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function generatedUiManifestSource(manifest) {
  return `/**\n * Generated by \`npm run release:sync\` from the final self-contained card HTML.\n * Do not edit this file by hand.\n */\nexport const UI_RESOURCE_MANIFEST = ${JSON.stringify(manifest, null, 2)} as const;\n\nexport type UiResourceName = keyof typeof UI_RESOURCE_MANIFEST.resources;\n`;
}

function writeJsonIfChanged(file, current, next) {
  if (!sameJson(current, next)) writeJsonAtomically(file, next);
}

function writeJsonArtifactIfChanged(file, next) {
  if (!jsonFileMatches(file, next)) writeJsonAtomically(file, next);
}

function writeJsonAtomically(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  mkdirSync(path.dirname(file), { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, file);
}

function writeTextAtomically(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file) && readTextFile(file, path.basename(file)) === value) return;
  const temporary = `${file}.tmp-${process.pid}`;
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644;
  writeFileSync(temporary, value, { mode });
  renameSync(temporary, file);
}

function readTextFile(file, field = path.basename(file)) {
  return decodeUtf8Strict(readFileSync(file), field);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function jsonFileMatches(file, expected) {
  if (!existsSync(file)) return false;
  try {
    return sameJson(readJson(file), expected);
  } catch {
    return false;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  throw new Error(`Invalid ${MANIFEST_FILENAME}: ${message}.`);
}

function printGithubOutput(metadata) {
  const output = {
    manifest_version: metadata.manifestVersion,
    release_unit_id: metadata.releaseUnitId,
    display_name: metadata.displayName,
    runtime_name: metadata.runtimeName,
    package_name: metadata.packageName,
    binary_name: metadata.binaryName,
    node_version: metadata.nodeVersion,
    node_engine: metadata.nodeEngine,
    npm_version: metadata.npmVersion,
    codex_cli_version: metadata.codexCliVersion,
    version: metadata.version,
    stage: metadata.stage,
    source_version: metadata.sourceVersion ?? "",
    source_candidate: metadata.sourceCandidate ?? "",
    source_candidate_tag: metadata.sourceCandidateTag,
    source_candidate_package_filename: metadata.sourceCandidatePackageFilename,
    source_candidate_macos_arm64_archive_filename: metadata.sourceCandidateMacosArm64ArchiveFilename,
    source_candidate_macos_x64_archive_filename: metadata.sourceCandidateMacosX64ArchiveFilename,
    tag: metadata.tag,
    release_title: metadata.releaseTitle,
    release_notes_file: metadata.releaseNotesFile,
    channel: metadata.channel,
    prerelease: metadata.prerelease,
    generate_notes: metadata.generateNotes,
    package_filename: metadata.packageFilename,
    checksum_filename: metadata.checksumFilename,
    macos_architectures: metadata.macosArchitectures.join(","),
    macos_minimum_version: metadata.macosMinimumVersion,
    macos_arm64_archive_filename: metadata.macosArm64ArchiveFilename,
    macos_x64_archive_filename: metadata.macosX64ArchiveFilename,
    release_checksums_filename: metadata.releaseChecksumsFilename,
    repository: metadata.repositorySlug,
    repository_url: metadata.repositoryUrl
  };
  for (const [key, value] of Object.entries(output)) process.stdout.write(`${key}=${String(value)}\n`);
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === "check") {
    const metadata = checkReleaseMetadata();
    console.log(`Release manifest is synchronized for ${metadata.tag}.`);
    return;
  }
  if (command === "sync") {
    const metadata = syncReleaseMetadata();
    console.log(`Synchronized package metadata from ${MANIFEST_FILENAME} for ${metadata.tag}.`);
    return;
  }
  if (command === "github-output") {
    // This command bootstraps the workflow before setup-node/npm ci, so it
    // must only depend on built-in Node modules and the canonical manifest.
    // The later build/check step performs the full generated-file/UI drift
    // validation once development dependencies such as tsx are installed.
    const metadata = deriveReleaseMetadata(loadReleaseManifest());
    checkReleaseNotesFile(DEFAULT_REPO_ROOT, metadata);
    printGithubOutput(metadata);
    return;
  }
  throw new Error("Usage: release-manifest.mjs <check|sync|github-output>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
