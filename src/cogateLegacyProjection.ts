import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import plan from "./cogateLegacyProjectionPlan.json" with { type: "json" };
import type { CoGateLegacyPreservationInspection } from "./cogateLegacySource.js";

const PLAN_SHA256 = "d9fce658244857598812635344b0fccf5f96da585648be64d873a371184c1329";
const PROVENANCE_KEYS = [
  "schema_version", "state_migration_catalog_version", "state_schema_origin",
  "state_last_migration_id", "state_last_migration_source_schema",
  "state_last_migration_target_schema", "state_last_migration_completed_at",
  "state_migration_pending", "schema_v19_upgrade_source", "state_migration_provenance_gap",
  "state_service_opened_after_migration", "state_service_opened_at",
  "state_service_opened_transport", "state_service_opened_migration_id",
  "state_runtime_product_version", "state_runtime_build_id"
] as const;
const TARGET_ONLY_KEYS = [
  "schema_v31_created_at", "schema_v31_migrated_at", "schema_v31_cogate_storage",
  "cogate_lineage_conversion_v1"
] as const;

export type CoGateLegacyProjectionInspection = {
  format: "cogate-legacy-projection-inspection/v1";
  sourcePreservationSha256: string;
  conversionId: string;
  logicalDatabaseId: string;
  sourceTableCount: 42;
  matchedTables: CoGateLegacyPreservationInspection["tables"];
  /** Content equality does not authenticate an approval or maintenance owner. */
  authority: "none";
  approvalVerification: "not-performed";
  ownerVerification: "not-performed";
  targetInitializationVerification: "not-performed";
};

/**
 * Verify the original 42-table projection on a caller-owned read-only target.
 * This is pre-service content evidence only. It cannot convert/promote a file,
 * verify a signature, initialize upstream delivery/model state, or grant launch.
 */
export function inspectCoGateLegacyProjection(
  database: Database.Database,
  source: CoGateLegacyPreservationInspection,
  conversionId: string
): CoGateLegacyProjectionInspection {
  if ((!database.readonly && !database.memory) || database.inTransaction) {
    throw new Error("CoGate target projection requires an idle read-only connection.");
  }
  if (hash(JSON.stringify(plan)) !== PLAN_SHA256 || typeof conversionId !== "string" ||
      conversionId.length === 0 || conversionId.length > 256) {
    throw new Error("CoGate projection plan or conversion identity is invalid.");
  }
  const { preservationSha256, ...evidence } = source;
  if (source.format !== "cogate-legacy-preservation/v1" || source.authority !== "none" ||
      source.source.sourceProfile !== plan.sourceProfile || source.source.sourceSchema !== 21 ||
      source.source.schemaObjectsSha256 !== plan.sourceSchemaObjectsSha256 ||
      hash(JSON.stringify(evidence)) !== preservationSha256 || source.tables.length !== 42 ||
      !plan.tables.every((table, index) => table.name === source.tables[index]?.name &&
        JSON.stringify(table.sourceColumns) === JSON.stringify(source.tables[index]?.columns))) {
    throw new Error("CoGate projection source ledger conflicts with its fixed contract.");
  }
  const queryOnly = database.pragma("query_only", { simple: true });
  try {
    database.pragma("query_only = ON"); database.exec("BEGIN");
    const objects = database.prepare(`SELECT type,name,tbl_name AS tableName,sql
      FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY type,name`).all();
    if (hash(JSON.stringify(objects)) !== plan.targetSchemaObjectsSha256 ||
        database.pragma("encoding", { simple: true }) !== source.databaseEncoding) {
      throw new Error("CoGate target schema or encoding conflicts with the fixed projection.");
    }
    const meta = (key: string) => (database.prepare("SELECT value FROM bridge_meta WHERE key=?")
      .get(key) as { value: string } | undefined)?.value;
    if (meta("schema_version") !== "31" || meta("state_database_id") !== source.source.logicalDatabaseId) {
      throw new Error("CoGate target logical database identity is invalid.");
    }
    if (database.prepare("SELECT 1 FROM sessions WHERE auth_boundary IS NOT NULL LIMIT 1").get()) {
      throw new Error("CoGate target assigned an unproven owner to a legacy session.");
    }
    for (const table of ["job_completion_deliveries", "operational_command_receipts"]) {
      if (database.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get()) {
        throw new Error("CoGate target fabricated delivery or operational command evidence.");
      }
    }
    const receipt = database.prepare(`SELECT logical_database_id,source_profile,source_schema,
      target_schema,source_preservation_sha256 FROM cogate_lineage_conversions WHERE conversion_id=?`)
      .get(conversionId) as Record<string, unknown> | undefined;
    if (!receipt || receipt.logical_database_id !== source.source.logicalDatabaseId ||
        receipt.source_profile !== plan.sourceProfile || receipt.source_schema !== 21 ||
        receipt.target_schema !== 31 || receipt.source_preservation_sha256 !== preservationSha256) {
      throw new Error("CoGate target has no matching typed content binding.");
    }
    for (const table of ["cogate_lineage_conversions", "cogate_legacy_metadata", "cogate_legacy_execution_modes"]) {
      if (database.prepare(`SELECT 1 FROM ${quote(table)} WHERE conversion_id!=? LIMIT 1`).get(conversionId)) {
        throw new Error("CoGate target contains evidence for another conversion.");
      }
    }
    const keys = PROVENANCE_KEYS.map(() => "?").join(",");
    if (database.prepare(`SELECT 1 FROM cogate_legacy_metadata WHERE conversion_id=?
      AND key NOT IN (${keys}) AND substr(key,1,16)!='state_migration:' LIMIT 1`)
      .get(conversionId, ...PROVENANCE_KEYS)) {
      throw new Error("CoGate target archive contains an unexpected metadata namespace.");
    }
    const matchedTables = plan.tables.map((table, index) => {
      let query = `SELECT ${table.sourceColumns.map(quote).join(",")} FROM ${quote(table.name)}`;
      let parameters: unknown[] = [];
      if (table.name === "jobs" || table.name === "activities") {
        const count = Number((database.prepare(`SELECT COUNT(*) AS n FROM ${quote(table.name)}`)
          .get() as { n: number }).n);
        if (count !== source.tables[index]?.rowCount) {
          throw new Error(`CoGate target has unbound rows in table ${table.name}.`);
        }
        const kind = table.name === "jobs" ? "job" : "activity";
        const id = kind === "job" ? "job_id" : "activity_id";
        query = `SELECT ${table.sourceColumns.map(column => column === "execution_mode" ?
          `m.execution_mode AS ${quote(column)}` : `t.${quote(column)}`).join(",")}
          FROM ${quote(table.name)} t JOIN cogate_legacy_execution_modes m
          ON m.entity_id=t.${quote(id)} AND m.entity_kind=? AND m.conversion_id=?`;
        parameters = [kind, conversionId];
      } else if (table.name === "bridge_meta") {
        const excluded = [...PROVENANCE_KEYS, ...TARGET_ONLY_KEYS];
        query = `SELECT key,value FROM bridge_meta
          WHERE key NOT IN (${excluded.map(() => "?").join(",")})
            AND substr(key,1,16)!='state_migration:'
          UNION ALL SELECT key,value FROM cogate_legacy_metadata WHERE conversion_id=?`;
        parameters = [...excluded, conversionId];
      }
      const result = hashProjection(database, table.name, table.sourceColumns, query, parameters);
      if (JSON.stringify(result) !== JSON.stringify(source.tables[index])) {
        throw new Error(`CoGate target does not preserve table ${table.name}.`);
      }
      return result;
    });
    const modes = Number((database.prepare(`SELECT COUNT(*) AS n FROM cogate_legacy_execution_modes
      WHERE conversion_id=?`).get(conversionId) as { n: number }).n);
    const expectedModes = source.tables.filter(table => ["jobs", "activities"].includes(table.name))
      .reduce((total, table) => total + table.rowCount, 0);
    if (modes !== expectedModes) throw new Error("CoGate target has orphan execution-mode evidence.");
    const sequences = (database.prepare("SELECT name,seq FROM sqlite_sequence ORDER BY name COLLATE BINARY")
      .safeIntegers(true).all() as Array<{ name: string; seq: bigint }>).map(row => ({
        name: row.name, highWaterMark: row.seq.toString()
      }));
    if (JSON.stringify(sequences) !== JSON.stringify(source.sequences) ||
        database.pragma("integrity_check", { simple: true }) !== "ok" ||
        (database.pragma("foreign_key_check") as unknown[]).length !== 0) {
      throw new Error("CoGate target sequence, integrity or foreign-key evidence conflicts.");
    }
    return { format: "cogate-legacy-projection-inspection/v1", sourcePreservationSha256: preservationSha256,
      conversionId, logicalDatabaseId: source.source.logicalDatabaseId, sourceTableCount: 42,
      matchedTables, authority: "none", approvalVerification: "not-performed",
      ownerVerification: "not-performed", targetInitializationVerification: "not-performed" };
  } finally {
    try { if (database.inTransaction) database.exec("ROLLBACK"); }
    finally { database.pragma(`query_only = ${queryOnly ? "ON" : "OFF"}`); }
  }
}

function hashProjection(database: Database.Database, name: string, columns: string[], query: string,
  parameters: unknown[]): CoGateLegacyPreservationInspection["tables"][number] {
  const cells = columns.flatMap(column => {
    const id = quote(column);
    return [`typeof(${id})`, `CASE WHEN typeof(${id}) IN ('text','blob')
      THEN hex(CAST(${id} AS BLOB)) ELSE ${id} END`];
  });
  const order = columns.flatMap(column => {
    const id = quote(column);
    return [`typeof(${id}) COLLATE BINARY`, `CASE WHEN typeof(${id}) IN ('text','blob')
      THEN CAST(${id} AS BLOB) ELSE ${id} END COLLATE BINARY`];
  });
  const digest = createHash("sha256").update("cogate-legacy-table/v1\0")
    .update(JSON.stringify({ name, columns })).update("\0");
  let rowCount = 0;
  const statement = database.prepare(`SELECT ${cells.join(",")} FROM (${query})
    ORDER BY ${order.join(",")}`).raw(true).safeIntegers(true);
  for (const row of statement.iterate(...parameters) as Iterable<unknown[]>) {
    digest.update("row\0");
    for (let index = 0; index < row.length; index += 2) {
      const storage = row[index], value = row[index + 1]; let bytes: Buffer;
      if (storage === "null" && value === null) bytes = Buffer.alloc(0);
      else if ((storage === "text" || storage === "blob") && typeof value === "string") bytes = Buffer.from(value, "hex");
      else if (storage === "integer" && typeof value === "bigint") bytes = Buffer.from(value.toString(), "utf8");
      else if (storage === "real" && typeof value === "number") { bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); }
      else throw new Error("CoGate projection encountered an unsupported SQLite cell.");
      const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
      digest.update(`${storage}\0`).update(length).update(bytes);
    }
    rowCount += 1;
    if (!Number.isSafeInteger(rowCount)) throw new Error("CoGate projection row count is unsafe.");
  }
  digest.update(`count\0${rowCount}`);
  return { name, columns, rowCount, contentSha256: digest.digest("hex") };
}

function quote(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
