import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256, COGATE_UNIFIED_SCHEMA_TABLES } from "./cogateUnifiedSchema.js";
import { parseJsonTextStrict, assertWellFormedUnicode, decodeUtf8Strict } from "./textIntegrity.js";

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
  assertCoGateConversionOriginUnavailable(database);
  const placeholders = COGATE_UNIFIED_SCHEMA_TABLES.map(() => "?").join(",");
  const objects = database.prepare(`SELECT type,name,tbl_name AS tableName,sql
    FROM main.sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7) != 'sqlite_'
      AND tbl_name IN (${placeholders}) ORDER BY type,name`).all(...COGATE_UNIFIED_SCHEMA_TABLES);
  if (createHash("sha256").update(JSON.stringify(objects)).digest("hex") !== COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256) {
    throw new Error("State schema31 CoGate storage objects conflict with the fixed contract.");
  }
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
}

/** Called inside the startup preflight snapshot for every numeric schema,
 * before any automatic migration or runtime ownership write. */
export function assertCoGateConversionOriginUnavailable(database: Database.Database): void {
  // Reading value as driver text would replace invalid SQLite TEXT bytes
  // before our Unicode check. Bound and decode the original stored bytes.
  const rows = database.prepare(`SELECT key,typeof(value) AS storageClass,
    length(CAST(value AS BLOB)) AS byteLength,
    CASE WHEN length(CAST(value AS BLOB)) <= 65536 THEN CAST(value AS BLOB) ELSE NULL END AS bytes
    FROM main.bridge_meta WHERE key IN ('cogate_lineage_conversion_v1','state_schema_origin')`).all() as
    Array<{key:string;storageClass:string;byteLength:number;bytes:Buffer|null}>;
  if (rows.some(row => row.key === "cogate_lineage_conversion_v1")) blocked();
  const originRow = rows.find(row => row.key === "state_schema_origin");
  if (originRow !== undefined) {
    let parsed: unknown;
    let origin: string;
    try {
      if(originRow.storageClass!=="text" || !Number.isSafeInteger(originRow.byteLength) ||
        originRow.byteLength<0 || originRow.byteLength>65536 || !Buffer.isBuffer(originRow.bytes) ||
        originRow.bytes.length!==originRow.byteLength) blocked();
      const encoding=database.pragma("main.encoding",{simple:true});
      if(encoding==="UTF-8") origin=decodeUtf8Strict(originRow.bytes,"Current state schema origin bytes");
      else if(encoding==="UTF-16le" || encoding==="UTF-16be") {
        origin=new TextDecoder(encoding.toLowerCase(),{fatal:true,ignoreBOM:true}).decode(originRow.bytes);
        assertWellFormedUnicode(origin,"Current state schema origin bytes");
      } else blocked();
      if (Buffer.byteLength(origin,"utf8") > 64 * 1024) blocked();
      parsed = parseJsonTextStrict(origin,"Current state schema origin");
      assertUniqueOriginMembers(origin);
    } catch { blocked(); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) blocked();
    const record = parsed as Record<string,unknown>;
    if (record.kind === "lineage-conversion" || record.format === "cogate-unified-origin/v1") blocked();
  }
}

function blocked(): never {
  throw new Error("COGATE_STATE_ACTIVATION_UNAVAILABLE: Unified CoGate authority and runtime actors are not implemented.");
}

/** Grammar/Unicode were already checked; preserve decoded member ambiguity
 * before JSON.parse's last-value interpretation could grant startup. */
function assertUniqueOriginMembers(raw: string): void {
  const stack: Array<{object:boolean;expectsKey:boolean;keys:Set<string>}> = [];
  for (let index=0; index<raw.length; index++) {
    const token=raw[index];
    if(token==='"') {
      let end=index+1;
      while(end<raw.length && raw[end]!=='"') end+=raw[end]==="\\" ? 2 : 1;
      const current=stack.at(-1);
      if(current?.object && current.expectsKey) {
        const key=JSON.parse(raw.slice(index,end+1)) as string;
        if(current.keys.has(key)) blocked();
        current.keys.add(key);current.expectsKey=false;
      }
      index=end;
    } else if(token==="{" || token==="[") stack.push({object:token==="{",expectsKey:token==="{",keys:new Set()});
    else if(token==="}" || token==="]") stack.pop();
    else if(token==="," && stack.at(-1)?.object) stack.at(-1)!.expectsKey=true;
  }
}
