import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
  constants as fsConstants
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parseJsonTextStrict, parseJsonUtf8Strict } from "./textIntegrity.js";
import { BRIDGE_BUILD_INFO } from "./buildInfo.js";
import { PRODUCT_INFO } from "./productInfo.js";
import {
  CURRENT_STATE_DATABASE_SCHEMA,
  STATE_MIGRATIONS,
  SUPPORTED_STATE_SCHEMA_VERSIONS,
  type StateMigrationCatalogEntry
} from "./stateCompatibility.js";

const UPGRADE_HEADROOM_BYTES = 16 * 1024 * 1024;
const MAX_PRIVATE_JSON_BYTES = 1024 * 1024;
export const STATE_MIGRATION_PROGRESS_FRESH_MS = 30_000;

export type StateDatabaseInspection = {
  file: string;
  exists: boolean;
  schemaVersion: number | null;
  integrityCheck: "ok" | "not-run";
  foreignKeyViolationCount: number | null;
  activeProcessIds: number[];
  serviceOpenedAfterMigration: boolean | null;
  lastMigrationId: string | null;
  pendingMigrationId: string | null;
  migrationSourceSchema: number | null;
};

export type StateMigrationStatus = {
  statusVersion: 1;
  databaseIdentity: string;
  sourceSchema: number;
  targetSchema: number;
  currentSchema: number;
  phase: "preflight" | "backup" | "migrating" | "verifying" | "completed" | "failed";
  migrationId: string | null;
  processId: number;
  productVersion: string;
  buildId: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
};

export type StateMigrationLease = {
  readonly databaseFile: string;
  /** Schema observed at this startup, which may be a committed retry checkpoint. */
  readonly observedSchema: number;
  /** Original pre-upgrade schema retained across retries. */
  readonly sourceSchema: number;
  readonly targetSchema: number;
  readonly statusFile: string;
  reportBackup(): void;
  reportMigration(entry: Pick<StateMigrationCatalogEntry, "id" | "toSchema">): void;
  reportCheckpoint(entry: Pick<StateMigrationCatalogEntry, "id" | "toSchema">): void;
  reportVerifying(): void;
  complete(): void;
  fail(error: unknown): void;
};

export type StateDatabaseOpenLease = StateMigrationLease & {
  readonly requiresMigration: boolean;
};

export type StateDatabaseLifecycleOptions = {
  /** Injectable capacity for deterministic failure tests. */
  availableBytes?: number;
  /** Injectable permission result for deterministic failure tests. */
  writable?: boolean;
  now?: () => Date;
  processId?: number;
};

export type StateMaintenanceLease = {
  databaseFile: string;
  lockFile: string;
  release(): void;
};

/**
 * Inspect an existing database without creating tables or changing pragmas.
 * Full SQLite checks are reserved for migration/recovery paths because they can
 * be expensive for a large operational database.
 */
export function inspectStateDatabase(
  file: string,
  options: { verifyIntegrity?: boolean } = {}
): StateDatabaseInspection {
  if (file === ":memory:") {
    return {
      file,
      exists: false,
      schemaVersion: null,
      integrityCheck: "not-run",
      foreignKeyViolationCount: null,
      activeProcessIds: [],
      serviceOpenedAfterMigration: null,
      lastMigrationId: null,
      pendingMigrationId: null,
      migrationSourceSchema: null
    };
  }
  if (!existsSync(file)) {
    return {
      file: canonicalMissingFile(file),
      exists: false,
      schemaVersion: null,
      integrityCheck: "not-run",
      foreignKeyViolationCount: null,
      activeProcessIds: [],
      serviceOpenedAfterMigration: null,
      lastMigrationId: null,
      pendingMigrationId: null,
      migrationSourceSchema: null
    };
  }
  assertRegularDatabaseFile(file);
  const canonicalFile = realpathSync.native(file);
  const database = new Database(canonicalFile, { readonly: true, fileMustExist: true });
  try {
    database.pragma("query_only = ON");
    database.exec("BEGIN");
    const hasMeta = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='bridge_meta'"
    ).get();
    if (!hasMeta) {
      const otherTables = Number((database.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ).get() as { count: number }).count);
      if (otherTables > 0) {
        throw new Error("Existing bridge state database has tables but no bridge_meta schema marker.");
      }
      return {
        file: canonicalFile,
        exists: true,
        schemaVersion: null,
        integrityCheck: "not-run",
        foreignKeyViolationCount: null,
        activeProcessIds: [],
        serviceOpenedAfterMigration: null,
        lastMigrationId: null,
        pendingMigrationId: null,
        migrationSourceSchema: null
      };
    }
    const metaRows = database.prepare(
      "SELECT key,value FROM bridge_meta WHERE key IN (" +
      "'schema_version','state_last_migration_id','state_service_opened_after_migration'," +
      "'state_migration_pending','schema_v19_upgrade_source')"
    ).all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    const rawSchema = meta.get("schema_version");
    if (!rawSchema || !/^\d+$/.test(rawSchema) || String(Number(rawSchema)) !== rawSchema) {
      throw new Error("Bridge state database has no valid integer schema_version marker.");
    }
    const schemaVersion = Number(rawSchema);
    assertStateLineageAdmission(database, schemaVersion);
    const pendingRaw = meta.get("state_migration_pending");
    let pendingMigrationId: string | null = null;
    let pendingOriginalSource: number | null = null;
    if (pendingRaw !== undefined) {
      try {
        const pending = parseJsonTextStrict<Record<string, unknown>>(
          pendingRaw,
          "Bridge state pending migration provenance"
        );
        const entry = STATE_MIGRATIONS.find((candidate) => candidate.id === pending.id);
        pendingOriginalSource = Number(pending.originalSourceSchema);
        if (
          !entry ||
          pending.fromSchema !== entry.fromSchema ||
          pending.toSchema !== entry.toSchema ||
          pending.implementationSha256 !== entry.sha256 ||
          !SUPPORTED_STATE_SCHEMA_VERSIONS.has(pendingOriginalSource) ||
          ![entry.fromSchema, entry.toSchema].includes(schemaVersion)
        ) throw new Error("invalid pending record");
        pendingMigrationId = entry.id;
      } catch {
        throw new Error("Bridge state database has invalid pending migration provenance.");
      }
    }
    const rawMigrationSource = meta.get("schema_v19_upgrade_source");
    let migrationSourceSchema: number | null = null;
    if (rawMigrationSource !== undefined) {
      if (
        !/^\d+$/.test(rawMigrationSource) ||
        String(Number(rawMigrationSource)) !== rawMigrationSource ||
        !SUPPORTED_STATE_SCHEMA_VERSIONS.has(Number(rawMigrationSource)) ||
        rawMigrationSource === String(CURRENT_STATE_DATABASE_SCHEMA)
      ) {
        throw new Error("Bridge state database has an invalid migration source marker.");
      }
      migrationSourceSchema = Number(rawMigrationSource);
    }
    if (pendingMigrationId !== null && migrationSourceSchema === null) {
      throw new Error("Pending state migration has no durable original-source marker.");
    }
    if (
      pendingOriginalSource !== null &&
      migrationSourceSchema !== pendingOriginalSource
    ) {
      throw new Error("Pending state migration conflicts with its original-source marker.");
    }
    let activeProcessIds: number[] = [];
    if (tableExists(database, "bridge_instances")) {
      const rows = database.prepare(
        "SELECT DISTINCT process_id FROM bridge_instances WHERE stopped_at IS NULL AND process_id IS NOT NULL"
      ).all() as Array<{ process_id: number }>;
      activeProcessIds = rows.map((row) => Number(row.process_id)).filter(
        (processId) => Number.isSafeInteger(processId) && processId > 0
      );
    }
    let integrityCheck: "ok" | "not-run" = "not-run";
    let foreignKeyViolationCount: number | null = null;
    if (options.verifyIntegrity) {
      const integrityRows = database.pragma("integrity_check") as Array<{ integrity_check?: string }>;
      if (
        integrityRows.length !== 1 ||
        String(Object.values(integrityRows[0] || {})[0]).toLowerCase() !== "ok"
      ) {
        throw new Error("Bridge state database failed PRAGMA integrity_check.");
      }
      integrityCheck = "ok";
      foreignKeyViolationCount = (database.pragma("foreign_key_check") as unknown[]).length;
      if (foreignKeyViolationCount !== 0) {
        throw new Error(
          `Bridge state database has ${foreignKeyViolationCount} foreign-key violation(s).`
        );
      }
    }
    return {
      file: canonicalFile,
      exists: true,
      schemaVersion,
      integrityCheck,
      foreignKeyViolationCount,
      activeProcessIds,
      serviceOpenedAfterMigration: meta.get("state_service_opened_after_migration") === "1"
        ? true
        : meta.get("state_service_opened_after_migration") === "0"
          ? false
          : null,
      lastMigrationId: meta.get("state_last_migration_id") || null,
      pendingMigrationId,
      migrationSourceSchema
    };
  } finally {
    if (database.inTransaction) database.exec("ROLLBACK");
    database.close();
  }
}

/** An integer version alone does not identify a migration lineage. Authenticate
 * every retained implementation before any startup or upgrade write. Fresh and
 * pre-contract checkpoints also need the positive structures introduced by the
 * published async/completion migrations; they may have no applied receipts. */
function assertStateLineageAdmission(database: Database.Database, schemaVersion: number): void {
  const records = database.prepare(
    "SELECT key,value FROM bridge_meta WHERE substr(key,1,16)='state_migration:'"
  ).all() as Array<{ key: string; value: string }>;
  for (const record of records) {
    const id = record.key.slice("state_migration:".length);
    const entry = STATE_MIGRATIONS.find(candidate => candidate.id === id);
    let parsed: Record<string, unknown> | undefined;
    try { parsed = parseJsonTextStrict<Record<string, unknown>>(record.value, "Applied state migration provenance"); }
    catch { /* A malformed historical receipt never grants admission. */ }
    if (
      !entry || !parsed || parsed.id !== entry.id ||
      parsed.fromSchema !== entry.fromSchema || parsed.toSchema !== entry.toSchema ||
      parsed.implementationSha256 !== entry.sha256 ||
      !Number.isSafeInteger(parsed.originalSourceSchema) ||
      !SUPPORTED_STATE_SCHEMA_VERSIONS.has(Number(parsed.originalSourceSchema)) ||
      Number(parsed.originalSourceSchema) > entry.fromSchema || entry.toSchema > schemaVersion ||
      typeof parsed.productVersion !== "string" || typeof parsed.buildId !== "string" ||
      typeof parsed.appliedAt !== "string" || !Number.isFinite(Date.parse(parsed.appliedAt))
    ) throw new Error(`State migration provenance conflicts with ${id}.`);
  }
  if (!SUPPORTED_STATE_SCHEMA_VERSIONS.has(schemaVersion) || schemaVersion < 20) return;
  const columns = (table: string) => new Set(
    (database.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name)
  );
  const jobs = columns("jobs"), activities = columns("activities");
  const completions = schemaVersion >= 21 ? columns("job_completion_deliveries") : new Set<string>();
  if (
    !jobs.has("job_id") || !activities.has("activity_id") ||
    jobs.has("execution_mode") || activities.has("execution_mode") ||
    ["workspace_control", "workspaces", "security_hmac_keys"].some(table => tableExists(database, table)) ||
    (schemaVersion >= 21 && ![
      "job_id", "scope_id", "terminal_version", "receipt", "state", "attempt_count",
      "lease_owner", "lease_expires_at", "created_at", "updated_at"
    ].every(column => completions.has(column)))
  ) throw new Error(`State migration lineage shape conflicts with schema ${schemaVersion}.`);
}

/**
 * Acquire one alias-safe owner for a supported upgrade. Unsupported versions
 * are rejected from the read-only probe before WAL mode or bridge metadata can
 * be changed.
 */
export function prepareStateDatabaseUpgrade(
  file: string,
  options: StateDatabaseLifecycleOptions = {}
): StateMigrationLease | null {
  const initial = inspectStateDatabase(file);
  if (
    initial.schemaVersion === null ||
    (initial.schemaVersion === CURRENT_STATE_DATABASE_SCHEMA && initial.pendingMigrationId === null)
  ) {
    return null;
  }
  if (!SUPPORTED_STATE_SCHEMA_VERSIONS.has(initial.schemaVersion)) {
    throw new Error(`Unsupported bridge state database schema version: ${initial.schemaVersion}.`);
  }

  return acquireStateDatabaseOpenLease(initial, options) as StateMigrationLease;
}

/**
 * Serialize every persistent database startup with migration and recovery.
 * The short startup lease remains held until the bridge instance row exists,
 * closing the gap between a read-only probe and durable runtime ownership.
 */
export function prepareStateDatabaseOpen(
  file: string,
  options: StateDatabaseLifecycleOptions = {}
): StateDatabaseOpenLease | null {
  if (file === ":memory:") return null;
  const initial = inspectStateDatabase(file);
  if (
    initial.schemaVersion !== null &&
    !SUPPORTED_STATE_SCHEMA_VERSIONS.has(initial.schemaVersion)
  ) {
    throw new Error(`Unsupported bridge state database schema version: ${initial.schemaVersion}.`);
  }
  return acquireStateDatabaseOpenLease(initial, options);
}

function acquireStateDatabaseOpenLease(
  initial: StateDatabaseInspection,
  options: StateDatabaseLifecycleOptions
): StateDatabaseOpenLease {
  const requiresMigration = initial.schemaVersion !== null && (
    initial.schemaVersion !== CURRENT_STATE_DATABASE_SCHEMA ||
    initial.pendingMigrationId !== null
  );

  const processId = options.processId ?? process.pid;
  const now = options.now ?? (() => new Date());
  const databaseFile = initial.file;
  const lockFile = `${databaseFile}.migration-lock.json`;
  const statusFile = `${databaseFile}.migration-status.json`;
  const token = randomUUID();
  acquireMigrationLock(lockFile, { token, processId, databaseFile, acquiredAt: now().toISOString() });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const lock = readPrivateJson(lockFile) as { token?: unknown };
      if (lock.token === token) {
        rmSync(lockFile, { force: true });
        syncDirectory(path.dirname(lockFile));
      }
    } catch {
      // Never remove a lock whose identity cannot be proven.
    }
  };

  const sourceSchema = initial.migrationSourceSchema ??
    initial.schemaVersion ??
    CURRENT_STATE_DATABASE_SCHEMA;
  const startedAt = now().toISOString();
  let status: StateMigrationStatus = {
    statusVersion: 1,
    databaseIdentity: databaseIdentity(databaseFile),
    sourceSchema,
    targetSchema: CURRENT_STATE_DATABASE_SCHEMA,
    currentSchema: initial.schemaVersion ?? CURRENT_STATE_DATABASE_SCHEMA,
    phase: "preflight",
    migrationId: null,
    processId,
    productVersion: PRODUCT_INFO.version,
    buildId: BRIDGE_BUILD_INFO.id,
    startedAt,
    updatedAt: startedAt
  };
  const writeStatus = (next: Partial<StateMigrationStatus>) => {
    status = { ...status, ...next, updatedAt: now().toISOString() };
    writePrivateJson(statusFile, status);
  };

  try {
    if (requiresMigration) writeStatus({ phase: "preflight" });
    const lockedInspection = inspectStateDatabase(databaseFile, {
      verifyIntegrity: requiresMigration
    });
    if (
      lockedInspection.exists !== initial.exists ||
      lockedInspection.schemaVersion !== initial.schemaVersion ||
      lockedInspection.pendingMigrationId !== initial.pendingMigrationId ||
      lockedInspection.migrationSourceSchema !== initial.migrationSourceSchema
    ) {
      throw new Error(
        `Bridge state schema changed from ${String(initial.schemaVersion)} to ` +
        `${String(lockedInspection.schemaVersion)} while acquiring migration ownership.`
      );
    }
    const live = lockedInspection.activeProcessIds.filter(isProcessAlive);
    if (live.length > 0) {
      throw new Error(
        `Bridge state upgrade/startup requires every database owner to stop; live process(es): ${live.join(", ")}.`
      );
    }
    if (requiresMigration) {
      assertUpgradeWritable(databaseFile, options.writable);
      assertUpgradeCapacity(databaseFile, options.availableBytes);
    }
  } catch (error) {
    if (requiresMigration) writeStatus({ phase: "failed", error: errorMessage(error) });
    release();
    throw error;
  }

  return {
    databaseFile,
    observedSchema: initial.schemaVersion ?? CURRENT_STATE_DATABASE_SCHEMA,
    sourceSchema,
    targetSchema: CURRENT_STATE_DATABASE_SCHEMA,
    statusFile,
    requiresMigration,
    reportBackup() {
      if (requiresMigration) writeStatus({ phase: "backup" });
    },
    reportMigration(entry) {
      if (requiresMigration) {
        writeStatus({ phase: "migrating", migrationId: entry.id });
      }
    },
    reportCheckpoint(entry) {
      if (requiresMigration) {
        writeStatus({ phase: "migrating", migrationId: entry.id, currentSchema: entry.toSchema });
      }
    },
    reportVerifying() {
      if (requiresMigration) writeStatus({ phase: "verifying" });
    },
    complete() {
      if (requiresMigration) {
        writeStatus({
          phase: "completed",
          currentSchema: CURRENT_STATE_DATABASE_SCHEMA,
          error: undefined
        });
      }
      release();
    },
    fail(error) {
      if (requiresMigration) {
        let currentSchema = status.currentSchema;
        try {
          const observed = inspectStateDatabase(databaseFile).schemaVersion;
          if (observed !== null) currentSchema = observed;
        } catch {
          // Keep the last durable checkpoint when the failed database cannot
          // be inspected safely.
        }
        writeStatus({ phase: "failed", currentSchema, error: errorMessage(error) });
      }
      release();
    }
  };
}

export function stateMigrationStatusFile(file: string): string {
  if (file === ":memory:") return file;
  const canonical = existsSync(file) ? realpathSync.native(file) : canonicalMissingFile(file);
  return `${canonical}.migration-status.json`;
}

export function acquireStateMaintenanceLease(
  file: string,
  kind: "migration" | "recovery",
  processId = process.pid
): StateMaintenanceLease {
  if (file === ":memory:") throw new Error("In-memory state has no maintenance lease.");
  const databaseFile = existsSync(file) ? realpathSync.native(file) : canonicalMissingFile(file);
  const lockFile = `${databaseFile}.migration-lock.json`;
  const token = randomUUID();
  acquireMigrationLock(lockFile, {
    token,
    processId,
    kind,
    databaseFile,
    acquiredAt: new Date().toISOString()
  });
  let released = false;
  return {
    databaseFile,
    lockFile,
    release() {
      if (released) return;
      released = true;
      try {
        const lock = readPrivateJson(lockFile) as { token?: unknown };
        if (lock.token === token) {
          rmSync(lockFile, { force: true });
          syncDirectory(path.dirname(lockFile));
        }
      } catch {
        // Never remove a lock whose identity cannot be proven.
      }
    }
  };
}

export function liveStateDatabaseOwners(file: string): number[] {
  return inspectStateDatabase(file).activeProcessIds.filter(isProcessAlive);
}

export function readStateMigrationStatus(file: string): StateMigrationStatus | null {
  const statusFile = stateMigrationStatusFile(file);
  if (!existsSync(statusFile)) return null;
  try {
    const value = readPrivateJson(statusFile) as Partial<StateMigrationStatus>;
    if (
      value.statusVersion !== 1 ||
      typeof value.databaseIdentity !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.databaseIdentity) ||
      !Number.isSafeInteger(value.sourceSchema) ||
      !SUPPORTED_STATE_SCHEMA_VERSIONS.has(Number(value.sourceSchema)) ||
      value.targetSchema !== CURRENT_STATE_DATABASE_SCHEMA ||
      !Number.isSafeInteger(value.currentSchema) ||
      Number(value.currentSchema) < Number(value.sourceSchema) ||
      Number(value.currentSchema) > CURRENT_STATE_DATABASE_SCHEMA ||
      !Number.isSafeInteger(value.processId) ||
      Number(value.processId) <= 0 ||
      typeof value.productVersion !== "string" ||
      typeof value.buildId !== "string" ||
      typeof value.startedAt !== "string" ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      !["preflight", "backup", "migrating", "verifying", "completed", "failed"].includes(
        String(value.phase)
      ) ||
      !(value.migrationId === null ||
        (typeof value.migrationId === "string" &&
          STATE_MIGRATIONS.some((entry) => entry.id === value.migrationId)))
    ) return null;
    return value as StateMigrationStatus;
  } catch {
    return null;
  }
}

export function stateMigrationExtendsStartupDeadline(
  file: string,
  status: StateMigrationStatus | null,
  now = Date.now()
): boolean {
  if (
    !status ||
    !["preflight", "backup", "migrating", "verifying"].includes(status.phase) ||
    !isProcessAlive(status.processId)
  ) return false;
  const updatedAt = Date.parse(status.updatedAt);
  if (
    updatedAt > now + 5_000 ||
    now - updatedAt > STATE_MIGRATION_PROGRESS_FRESH_MS
  ) return false;
  try {
    return status.databaseIdentity === databaseIdentity(file);
  } catch {
    return false;
  }
}

export function writePrivateJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    syncDirectory(path.dirname(file));
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readPrivateJson(file: string): unknown {
  const noFollow = "O_NOFOLLOW" in fsConstants
    ? (fsConstants as typeof fsConstants & { O_NOFOLLOW: number }).O_NOFOLLOW
    : 0;
  const descriptor = openSync(file, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_PRIVATE_JSON_BYTES) {
      throw new Error(`Private state metadata is not a bounded regular file: ${file}.`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Private state metadata permissions are broader than 0600: ${file}.`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Private state metadata is owned by another user: ${file}.`);
    }
    return parseJsonUtf8Strict(readFileSync(descriptor), "Private state metadata");
  } finally {
    closeSync(descriptor);
  }
}

export function databaseIdentity(file: string): string {
  const canonical = existsSync(file) ? realpathSync.native(file) : canonicalMissingFile(file);
  const stat = existsSync(canonical) ? statSync(canonical) : null;
  return createHash("sha256")
    .update([canonical, stat?.dev ?? "new", stat?.ino ?? "new"].join("\0"))
    .digest("hex");
}

function acquireMigrationLock(file: string, value: unknown): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(file, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(file, 0o600);
      syncDirectory(path.dirname(file));
      return;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: { processId?: unknown } = {};
      try {
        existing = readPrivateJson(file) as { processId?: unknown };
      } catch {
        throw new Error(`State migration lock is unreadable: ${file}.`);
      }
      const owner = Number(existing.processId);
      if (Number.isSafeInteger(owner) && isProcessAlive(owner)) {
        throw new Error(`State database migration is already owned by live process ${owner}.`);
      }
      rmSync(file, { force: true });
    }
  }
  throw new Error("Could not acquire state database migration ownership.");
}

function assertRegularDatabaseFile(file: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) {
    const target = statSync(file);
    if (!target.isFile()) throw new Error("Bridge state database symlink target is not a regular file.");
    return;
  }
  if (!stat.isFile()) throw new Error("Bridge state database path is not a regular file.");
}

function assertUpgradeWritable(file: string, writableOverride?: boolean): void {
  if (writableOverride === false) {
    throw new Error("State migration permission preflight reported a read-only database or directory.");
  }
  accessSync(file, fsConstants.R_OK | fsConstants.W_OK);
  accessSync(path.dirname(file), fsConstants.R_OK | fsConstants.W_OK);
}

function assertUpgradeCapacity(file: string, availableBytesOverride?: number): void {
  const databaseBytes = [file, `${file}-wal`, `${file}-shm`]
    .filter(existsSync)
    .reduce((total, candidate) => total + statSync(candidate).size, 0);
  const requiredBytes = databaseBytes * 2 + UPGRADE_HEADROOM_BYTES;
  const availableBytes = availableBytesOverride ?? (() => {
    const stat = statfsSync(path.dirname(file));
    return Number(stat.bavail) * Number(stat.bsize);
  })();
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient space for state migration: ${availableBytes} bytes available, ` +
      `${requiredBytes} bytes required for the verified backup and migration headroom.`
    );
  }
}

function tableExists(database: Database.Database, name: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name));
}

function canonicalMissingFile(file: string): string {
  const directory = path.dirname(path.resolve(file));
  const canonicalDirectory = existsSync(directory) ? realpathSync.native(directory) : directory;
  return path.join(canonicalDirectory, path.basename(file));
}

function isProcessAlive(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support fsync on directories. File fsync and
    // atomic rename still provide the strongest portable behavior available.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
