import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256, COGATE_UNIFIED_SCHEMA_TABLES } from "./cogateUnifiedSchema.js";
import { parseJsonTextStrict } from "./textIntegrity.js";

/** Current runtime has storage/inspectors, but no reviewed CoGate actors or
 * authenticated activation path. Never admit converted/active CoGate state
 * through ordinary startup merely because its integer schema is 31. This
 * read-only preflight deliberately offers no caller bypass or approval flag. */
export function assertCoGateUnifiedRuntimeAdmission(database: Database.Database): void {
  const ownsSnapshot = !database.inTransaction;
  if (ownsSnapshot) database.exec("BEGIN");
  try {
    assertAdmissionInSnapshot(database);
  } finally {
    if (ownsSnapshot && database.inTransaction) database.exec("ROLLBACK");
  }
}

function assertAdmissionInSnapshot(database: Database.Database): void {
  const placeholders = COGATE_UNIFIED_SCHEMA_TABLES.map(() => "?").join(",");
  const objects = database.prepare(`SELECT type,name,tbl_name AS tableName,sql
    FROM main.sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7) != 'sqlite_'
      AND tbl_name IN (${placeholders}) ORDER BY type,name`).all(...COGATE_UNIFIED_SCHEMA_TABLES);
  if (createHash("sha256").update(JSON.stringify(objects)).digest("hex") !== COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256) {
    throw new Error("State schema31 CoGate storage objects conflict with the fixed contract.");
  }
  const blocked = () => { throw new Error("COGATE_STATE_ACTIVATION_UNAVAILABLE: Unified CoGate authority and runtime actors are not implemented."); };
  for (const table of COGATE_UNIFIED_SCHEMA_TABLES.filter(name => name !== "workspace_control")) {
    if (database.prepare(`SELECT 1 FROM main."${table}" LIMIT 1`).get()) blocked();
  }
  const baseline = database.prepare(`SELECT COUNT(*) AS n FROM main.workspace_control
    WHERE singleton=1 AND mode='disabled' AND revision=1 AND maintenance=0 AND updated_at=0
      AND typeof(singleton)='integer' AND typeof(mode)='text' AND typeof(revision)='integer'
      AND typeof(maintenance)='integer' AND typeof(updated_at)='integer'`).get() as {n:number};
  if (baseline.n !== 1 || (database.prepare("SELECT COUNT(*) AS n FROM main.workspace_control").get() as {n:number}).n !== 1) {
    blocked();
  }
  if (database.prepare("SELECT 1 FROM main.bridge_meta WHERE key='cogate_lineage_conversion_v1'").get()) blocked();
  const origin = (database.prepare("SELECT value FROM main.bridge_meta WHERE key='state_schema_origin'").get() as
    {value:string}|undefined)?.value;
  if (origin !== undefined) {
    let parsed: unknown;
    try { parsed = parseJsonTextStrict(origin,"Current state schema origin"); } catch { blocked(); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) blocked();
    const record = parsed as Record<string,unknown>;
    if (record.kind === "lineage-conversion" || record.format === "cogate-unified-origin/v1") blocked();
  }
}
