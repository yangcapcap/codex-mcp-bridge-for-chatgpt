import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import profile from "./cogateLegacySourceProfile.json" with { type: "json" };
import { parseJsonTextStrict } from "./textIntegrity.js";
import {
  loadSecurityHmacKeyring, SCOPE_HMAC_PURPOSE, EXECUTION_POLICY_HMAC_PURPOSE,
  SECURITY_ROTATION_REQUIRED_META_KEY
} from "./cogateLegacySecurityRead.js";

/** This is a fixed source identity, not another runtime or a numeric-schema alias. */
export const COGATE_LEGACY_SOURCE_PROFILE = "cogate-v2-workspace-hmac/schema21/v1";
const PROFILE_DIGEST = "ee659c7eec7062654df2deb318f8d2530c15cfdad76bd20525d7255e7f806dc3";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CoGateLegacySourceInspection = {
  sourceProfile: typeof COGATE_LEGACY_SOURCE_PROFILE;
  sourceSchema: 21;
  logicalDatabaseId: string;
  schemaObjectsSha256: string;
  migrationEvidenceSha256: string;
  appliedReceiptCount: number;
  historicalGapRetained: boolean;
  activeInstanceCount: number;
  nonterminalJobCount: number;
  workspacesByLifecycle: Record<string, number>;
  workspaceControl: { mode: string; revision: number; maintenance: boolean };
  security: {
    scopeGeneration: number;
    executionGeneration: number;
    rotationRequired: boolean;
    pendingRotation: boolean;
  };
  /** An inspection never grants conversion, deployment, or signing authority. */
  authority: "none";
};

/** Private preservation evidence, never a conversion grant or an apply receipt. */
export type CoGateLegacyPreservationInspection = {
  format: "cogate-legacy-preservation/v1";
  source: CoGateLegacySourceInspection;
  databaseEncoding: string;
  tables: Array<{ name: string; columns: string[]; rowCount: number; contentSha256: string }>;
  sequences: Array<{ name: string; highWaterMark: string }>;
  preservationSha256: string;
  authority: "none";
};

type Receipt = {
  id: string; fromSchema: number; toSchema: number; implementationSha256: string;
  originalSourceSchema: number; productVersion: string; buildId: string; appliedAt: string;
};
type Entry = (typeof profile.migrations)[number];

/**
 * Inspect a caller-owned read-only connection. This never invokes StateStore,
 * creates a backup, reconciles an owner, rotates a key, or changes a receipt.
 * In-memory writable fixtures are allowed; file-backed writable connections
 * are rejected before any pragma or statement.
 */
export function inspectCoGateLegacySource(database: Database.Database): CoGateLegacySourceInspection {
  return inspectSourceSnapshot(database, (_database, source) => source);
}

/** Authenticate and hash every retained cell in the same read-only snapshot. */
export function inspectCoGateLegacyPreservation(
  database: Database.Database
): CoGateLegacyPreservationInspection {
  return inspectSourceSnapshot(database, preservationInspection);
}

function inspectSourceSnapshot<T>(
  database: Database.Database,
  project: (database: Database.Database, source: CoGateLegacySourceInspection) => T
): T {
  if ((!database.readonly && !database.memory) || database.inTransaction) {
    throw new Error("CoGate source inspection requires an idle read-only connection.");
  }
  if (digest(JSON.stringify(profile)) !== PROFILE_DIGEST) {
    throw new Error("CoGate source profile digest conflicts with the fixed contract.");
  }
  const queryOnly = database.pragma("query_only", { simple: true });
  database.pragma("query_only = ON");
  database.exec("BEGIN");
  try {
    const objects = database.prepare(`SELECT type,name,tbl_name AS tableName,sql
      FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY type,name`).all();
    const schemaObjectsSha256 = digest(JSON.stringify(objects));
    if (schemaObjectsSha256 !== profile.schemaObjectsSha256) {
      throw new Error("CoGate source schema objects conflict with the fixed schema21 profile.");
    }
    const rows = database.prepare(`SELECT key,value FROM bridge_meta
      WHERE key IN ('schema_version','state_database_id','state_schema_origin',
        'state_last_migration_id','state_last_migration_source_schema',
        'state_last_migration_target_schema','state_last_migration_completed_at',
        'state_migration_pending','schema_v19_upgrade_source',
        'state_migration_provenance_gap','state_migration_catalog_version')
      OR key LIKE 'state_migration:%' ORDER BY key`).all() as Array<{ key: string; value: string }>;
    const meta = new Map(rows.map(row => [row.key, row.value]));
    const logicalDatabaseId = meta.get("state_database_id");
    if (meta.get("schema_version") !== "21" || !logicalDatabaseId || !UUID.test(logicalDatabaseId)) {
      throw new Error("CoGate source has no fixed schema21 logical database identity.");
    }
    if (meta.has("state_migration_pending") || meta.has("schema_v19_upgrade_source")) {
      throw new Error("CoGate source has an unfinished migration; source-runtime recovery is required.");
    }
    const { receiptCount, historicalGapRetained } = inspectReceipts(meta);
    if (database.pragma("integrity_check", { simple: true }) !== "ok" ||
        (database.pragma("foreign_key_check") as unknown[]).length !== 0) {
      throw new Error("CoGate source integrity or foreign-key verification failed.");
    }
    // Preserve the original fixed semantics including retired lookup evidence,
    // legacy tombstones and append-only rotation provenance. Return no key material.
    const scope = loadSecurityHmacKeyring(database, SCOPE_HMAC_PURPOSE,
      { allowRotationRequired: true, allowPendingRotation: true });
    const execution = loadSecurityHmacKeyring(database, EXECUTION_POLICY_HMAC_PURPOSE,
      { allowRotationRequired: true, allowPendingRotation: true });
    const rotationRequired = (database.prepare("SELECT value FROM bridge_meta WHERE key=?")
      .get(SECURITY_ROTATION_REQUIRED_META_KEY) as { value: string }).value === "1";
    const control = database.prepare("SELECT mode,revision,maintenance FROM workspace_control WHERE singleton=1")
      .get() as { mode: string; revision: number; maintenance: number } | undefined;
    if (!control) throw new Error("CoGate source workspace control is missing.");
    const lifecycleRows = database.prepare(`SELECT lifecycle,COUNT(*) AS count FROM workspaces
      GROUP BY lifecycle ORDER BY lifecycle`).all() as Array<{ lifecycle: string; count: number }>;
    return project(database, {
      sourceProfile: COGATE_LEGACY_SOURCE_PROFILE, sourceSchema: 21, logicalDatabaseId,
      schemaObjectsSha256, migrationEvidenceSha256: digest(JSON.stringify(rows)),
      appliedReceiptCount: receiptCount, historicalGapRetained,
      activeInstanceCount: count(database, "SELECT COUNT(*) AS count FROM bridge_instances WHERE stopped_at IS NULL"),
      nonterminalJobCount: count(database, `SELECT COUNT(*) AS count FROM jobs
        WHERE status NOT IN ('completed','failed','interrupted','cancelled')`),
      workspacesByLifecycle: Object.fromEntries(lifecycleRows.map(row => [row.lifecycle, row.count])),
      workspaceControl: { mode: control.mode, revision: control.revision, maintenance: control.maintenance === 1 },
      security: { scopeGeneration: scope.active.generation, executionGeneration: execution.active.generation,
        rotationRequired, pendingRotation: Boolean(scope.pending || execution.pending) },
      authority: "none"
    });
  } finally {
    database.exec("ROLLBACK");
    database.pragma(`query_only = ${queryOnly ? "ON" : "OFF"}`);
  }
}

function preservationInspection(
  database: Database.Database, source: CoGateLegacySourceInspection
): CoGateLegacyPreservationInspection {
  const tables: CoGateLegacyPreservationInspection["tables"] = [];
  for (const object of profile.objects.filter(value => value.type === "table")) {
    const name = object.name;
    const columns = (database.pragma(`table_info(${quoteIdentifier(name)})`) as
      Array<{ name: string }>).map(column => column.name);
    const cells = columns.flatMap(column => {
      const id = quoteIdentifier(column);
      // SQL yields the original TEXT/BLOB bytes, including embedded NUL and
      // invalid UTF-8. JavaScript decoding must not collapse distinct values.
      return [`typeof(${id})`, `CASE WHEN typeof(${id}) IN ('text','blob')
        THEN hex(CAST(${id} AS BLOB)) ELSE ${id} END`];
    });
    const order = columns.flatMap(column => {
      const id = quoteIdentifier(column);
      return [`typeof(${id}) COLLATE BINARY`, `CASE WHEN typeof(${id}) IN ('text','blob')
        THEN CAST(${id} AS BLOB) ELSE ${id} END COLLATE BINARY`];
    });
    const hash = createHash("sha256").update("cogate-legacy-table/v1\0")
      .update(JSON.stringify({ name, columns })).update("\0");
    let rowCount = 0;
    const statement = database.prepare(`SELECT ${cells.join(",")} FROM ${quoteIdentifier(name)}
      ORDER BY ${order.join(",")}`).raw(true).safeIntegers(true);
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      hash.update("row\0");
      for (let index = 0; index < row.length; index += 2) {
        const storage = row[index]; const value = row[index + 1];
        let bytes: Buffer;
        if (storage === "null" && value === null) bytes = Buffer.alloc(0);
        else if ((storage === "text" || storage === "blob") && typeof value === "string") {
          bytes = Buffer.from(value, "hex");
        } else if (storage === "integer" && typeof value === "bigint") {
          bytes = Buffer.from(value.toString(), "utf8");
        } else if (storage === "real" && typeof value === "number") {
          bytes = Buffer.alloc(8); bytes.writeDoubleBE(value);
        } else throw new Error("CoGate preservation encountered an unsupported SQLite cell.");
        const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
        hash.update(`${storage}\0`).update(length).update(bytes);
      }
      rowCount += 1;
      if (!Number.isSafeInteger(rowCount)) throw new Error("CoGate preservation row count is unsafe.");
    }
    hash.update(`count\0${rowCount}`);
    tables.push({ name, columns, rowCount, contentSha256: hash.digest("hex") });
  }
  const sequenceTables = new Set(profile.objects.filter(object => object.type === "table" &&
    /\bAUTOINCREMENT\b/.test(object.sql)).map(object => object.name));
  const seenSequences = new Set<string>();
  const sequences = (database.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name COLLATE BINARY")
    .safeIntegers(true).all() as Array<{ name: string; seq: bigint }>).map(row => {
    if (typeof row.name !== "string" || !sequenceTables.has(row.name) || seenSequences.has(row.name) ||
        typeof row.seq !== "bigint" || row.seq < 0n) {
      throw new Error("CoGate preservation has malformed sequence evidence.");
    }
    seenSequences.add(row.name);
    return { name: row.name, highWaterMark: row.seq.toString() };
  });
  const evidence = { format: "cogate-legacy-preservation/v1" as const, source,
    databaseEncoding: String(database.pragma("encoding", { simple: true })), tables, sequences,
    authority: "none" as const };
  return { ...evidence, preservationSha256: digest(JSON.stringify(evidence)) };
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }

function inspectReceipts(meta: Map<string, string>): { receiptCount: number; historicalGapRetained: boolean } {
  const originRaw = meta.get("state_schema_origin");
  const origin = originRaw === undefined ? null : parseRecord(originRaw);
  if (origin && (!hasKeys(origin, ["kind", "schema", "productVersion", "buildId", "recordedAt"]) ||
      !["fresh", "pre-contract-current"].includes(String(origin.kind)) || !isSource(origin.schema) ||
      !isText(origin.productVersion) || !isText(origin.buildId) || !isDate(origin.recordedAt))) {
    throw new Error("CoGate source has invalid retained schema-origin evidence.");
  }
  if (meta.get("state_migration_catalog_version") !== "1") {
    throw new Error("CoGate source migration catalog identity conflicts with the fixed profile.");
  }
  const receipts = new Map<string, Receipt>();
  for (const [key, raw] of meta) {
    if (!key.startsWith("state_migration:")) continue;
    const record = parseRecord(raw);
    const entry = profile.migrations.find(candidate => key === `state_migration:${candidate.id}`);
    if (!entry || !hasKeys(record, ["id", "fromSchema", "toSchema", "implementationSha256",
        "originalSourceSchema", "productVersion", "buildId", "appliedAt"]) ||
        record.id !== entry.id || record.fromSchema !== entry.fromSchema ||
        record.toSchema !== entry.toSchema || record.implementationSha256 !== entry.sha256 ||
        !isSource(record.originalSourceSchema) || Number(record.originalSourceSchema) > entry.fromSchema ||
        !isText(record.productVersion) || !isText(record.buildId) || !isDate(record.appliedAt)) {
      throw new Error("CoGate source has a conflicting retained migration receipt.");
    }
    receipts.set(entry.id, record as Receipt);
  }
  const gapRaw = meta.get("state_migration_provenance_gap");
  let gap: { originalSourceSchema: number; observedSchema: number } | null = null;
  if (gapRaw !== undefined) {
    const value = parseRecord(gapRaw);
    if (!hasKeys(value, ["kind", "originalSourceSchema", "observedSchema", "recordedAt"]) ||
        value.kind !== "pre-contract-intermediate-checkpoint" || !isSource(value.originalSourceSchema) ||
        !Number.isSafeInteger(value.observedSchema) || !isDate(value.recordedAt) ||
        !migrationPath(Number(value.originalSourceSchema)).some(entry => entry.toSchema === value.observedSchema)) {
      throw new Error("CoGate source has invalid retained provenance-gap evidence.");
    }
    gap = { originalSourceSchema: Number(value.originalSourceSchema), observedSchema: Number(value.observedSchema) };
  }
  const last = meta.get("state_last_migration_id");
  if (last === undefined) {
    // A current fresh source has no synthetic applied receipts. Historical
    // checkpoints must finish in the legacy runtime, not be reclassified here.
    const orphanCompletion = ["state_last_migration_source_schema", "state_last_migration_target_schema",
      "state_last_migration_completed_at"].some(key => meta.has(key));
    if (receipts.size || gap || orphanCompletion || !origin || origin.kind !== "fresh" || origin.schema !== 21 ||
        !isText(origin.productVersion) || !isText(origin.buildId) || !isDate(origin.recordedAt)) {
      throw new Error("CoGate source has no authenticated current fresh origin or completed path.");
    }
  } else {
    const sourceRaw = meta.get("state_last_migration_source_schema");
    if (!sourceRaw || String(Number(sourceRaw)) !== sourceRaw || !isSource(Number(sourceRaw)) ||
        meta.get("state_last_migration_target_schema") !== "21" ||
        !isDate(meta.get("state_last_migration_completed_at")) ||
        meta.get("state_migration_catalog_version") !== "1") {
      throw new Error("CoGate source has invalid completed migration identity.");
    }
    const source = Number(sourceRaw);
    const path = migrationPath(source);
    let start = 0;
    if (gap) {
      if (gap.originalSourceSchema !== source) {
        throw new Error("CoGate source completed path conflicts with the retained historical gap.");
      }
      start = path.findIndex(entry => entry.toSchema === gap.observedSchema) + 1;
    }
    for (const entry of path.slice(start)) {
      if (receipts.get(entry.id)?.originalSourceSchema !== source) {
        throw new Error("CoGate source completed path has missing or conflicting receipts.");
      }
    }
    if (path.at(-1)?.id !== last || !receipts.has(last)) {
      throw new Error("CoGate source last migration does not reach the fixed schema21 checkpoint.");
    }
    // A missing pre-contract historical origin remains missing. Never invent a
    // fresh origin for an upgraded source. When present, a fresh origin cannot
    // be newer than the source of any authenticated retained generation.
    if (origin?.kind === "fresh" && [...receipts.values()].some(receipt =>
      Number(origin.schema) > receipt.originalSourceSchema)) {
      throw new Error("CoGate source fresh origin conflicts with its retained migration generations.");
    }
  }
  // Older completed generations can have their own original source (for
  // example 19->20 source19, then 20->21 source20). Authenticate every retained
  // generation's preceding path instead of treating the newest source as all history.
  for (const receipt of receipts.values()) {
    const path = migrationPath(receipt.originalSourceSchema);
    const endpoint = path.findIndex(entry => entry.id === receipt.id);
    let start = 0;
    if (gap?.originalSourceSchema === receipt.originalSourceSchema) {
      start = path.findIndex(entry => entry.toSchema === gap.observedSchema) + 1;
    }
    if (endpoint < start) throw new Error("CoGate source retained receipt precedes its declared provenance gap.");
    for (const entry of path.slice(start, endpoint + 1)) {
      if (receipts.get(entry.id)?.originalSourceSchema !== receipt.originalSourceSchema) {
        throw new Error("CoGate source retained generation has an unauthenticated preceding path.");
      }
    }
  }
  return { receiptCount: receipts.size, historicalGapRetained: gap !== null };
}

function migrationPath(source: number): Entry[] {
  const result: Entry[] = [];
  let current = source;
  while (current !== 21) {
    const entry = profile.migrations.find(value => value.fromSchema === current);
    if (!entry || result.length >= profile.migrations.length) {
      throw new Error("CoGate source migration path does not reach its fixed schema21 profile.");
    }
    result.push(entry); current = entry.toSchema;
  }
  return result;
}
function isSource(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    (value === 21 || profile.migrations.some(entry => entry.fromSchema === value));
}
function parseRecord(raw: string): Record<string, unknown> {
  const value = parseJsonTextStrict<unknown>(raw, "CoGate source provenance");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CoGate source provenance is not an object.");
  }
  assertUniqueRootMembers(raw);
  return value as Record<string, unknown>;
}
/** JSON.parse already authenticated grammar/text. Inspect the raw root keys
 * before last-member-wins decoding can conceal contradictory history. Nested
 * values are skipped here and subsequently rejected by the fixed scalar shapes.
 * This does not change the shared parser or the carried legacy HMAC semantics. */
function assertUniqueRootMembers(raw: string): void {
  const members = new Set<string>();
  let depth = 0;
  let expectsKey = false;
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === '"') {
      let end = index + 1;
      while (end < raw.length && raw[end] !== '"') {
        end += raw[end] === "\\" ? 2 : 1;
      }
      if (depth === 1 && expectsKey) {
        const key = JSON.parse(raw.slice(index, end + 1)) as string;
        if (members.has(key)) throw new Error("CoGate source provenance has duplicate root members.");
        members.add(key); expectsKey = false;
      }
      index = end;
    } else if (token === "{" || token === "[") {
      depth += 1;
      if (depth === 1) expectsKey = true;
    } else if (token === "}" || token === "]") {
      depth -= 1;
    } else if (token === "," && depth === 1) {
      expectsKey = true;
    }
  }
}
function isText(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function isDate(value: unknown): boolean { return isText(value) && Number.isFinite(Date.parse(value)); }
function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function count(database: Database.Database, sql: string): number {
  return (database.prepare(sql).get() as { count: number }).count;
}
