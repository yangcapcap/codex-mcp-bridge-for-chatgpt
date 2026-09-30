import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import profile from "../../src/cogateLegacySourceProfile.json" with { type: "json" };
import plan from "../../src/cogateLegacyProjectionPlan.json" with { type: "json" };
import { securityKeyFingerprint } from "../../src/cogateLegacySecurityRead.js";
import { inspectCoGateLegacyPreservation } from "../../src/cogateLegacySource.js";
import { BridgeStateStore } from "../../src/stateStore.js";
export function legacyFixture(file = ":memory:", encoding = "UTF-8"): Database.Database {
  const db = new Database(file);
  db.pragma(`encoding = '${encoding}'`);
  for (const object of profile.objects.filter(value => value.type === "table")) db.exec(object.sql);
  for (const object of profile.objects.filter(value => value.type !== "table")) db.exec(object.sql);
  legacyMeta(db, "schema_version", "21"); legacyMeta(db, "state_database_id", randomUUID());
  legacyMeta(db, "state_migration_catalog_version", "1");
  legacyMeta(db, "state_schema_origin", JSON.stringify({ kind: "fresh", schema: 21,
    productVersion: "0.4.1", buildId: "fixture-source", recordedAt: "2026-09-30T00:00:00Z" }));
  legacyMeta(db, "security_key_rotation_required_v1", "0");
  db.prepare("INSERT INTO workspace_control VALUES(1,'disabled',1,0,0)").run();
  for (const [index, purpose] of (["scope", "execution-policy"] as const).entries()) {
    const secret = Buffer.alloc(32, index + 1); const encoded = secret.toString("base64url");
    legacyMeta(db, `${purpose === "scope" ? "scope" : "execution_policy"}_hmac_secret_v1`, encoded);
    db.prepare(`INSERT INTO security_hmac_keys VALUES(?,1,'active','sign-and-verify',?,?,NULL,0,NULL)`)
      .run(purpose, encoded, securityKeyFingerprint(purpose, secret));
  }
  return db;
}
export function legacyMeta(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES(?,?)").run(key, value);
}

// Pure synthetic fixture builder. Its arbitrary hashes are not approval evidence;
// this helper is never exported by the runtime or used against installed state.
export function projectionFixture(options: { encoding?: string; mode?: "missing" | "changed" | "orphan";
  metadata?: "missing" | "unexpected"; initialized?: boolean; settings?: string } = {}) {
  const source = legacyFixture(":memory:", options.encoding);
  legacyMeta(source, "retained_writer_unknown", '{ "outcome": "UNKNOWN" }\0opaque');
  source.prepare("INSERT INTO bridge_meta VALUES('opaque_bytes',CAST(? AS TEXT))").run(Buffer.from([0x80,0,0x81]));
  source.prepare("INSERT INTO scopes VALUES('fixture-scope',?,0,0)").run(9007199254740993n);
  source.exec(`INSERT INTO activities(activity_id,scope_id,title,kind,execution_mode,handoff_policy,
    completion_trigger,lifecycle,waiting_on,verification,version,created_at,updated_at)
    VALUES('fixture-activity','fixture-scope','retained','other','background','none','manual',
      'open','none','not-required',1,0,0);
    INSERT INTO jobs(job_id,scope_id,request_id,activity_id,status,execution_mode,backend_kind,
      cwd,sandbox,created_at,updated_at,job_version,last_progress_at,payload)
    VALUES('fixture-job','fixture-scope','fixture-request','fixture-activity','completed','foreground',
      'mcp-server','/tmp/synthetic-cogate','read-only',0,0,1,0,'{"outcome":"UNKNOWN"}');
    INSERT INTO sessions(thread_id,scope_id,backend_kind,cwd,sandbox,persistence,created_at,updated_at,last_used_at)
    VALUES('fixture-thread','fixture-scope','app-server','/tmp/synthetic-cogate','read-only','unknown',0,0,0);`);
  source.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('activity_events',?)").run(9007199254740993n);
  if (options.settings !== undefined) source.prepare("INSERT INTO user_settings(singleton,payload) VALUES(1,?)")
    .run(options.settings);
  const ledger = inspectCoGateLegacyPreservation(source);
  const store = new BridgeStateStore({ file: ":memory:" });
  const current = (store as unknown as { database: Database.Database }).database;
  const objects = current.prepare("SELECT type,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7) != 'sqlite_' ORDER BY type,name")
    .all() as Array<{ type: string; sql: string }>;
  const target = new Database(":memory:");
  target.pragma(`encoding = '${options.encoding ?? "UTF-8"}'`);
  target.pragma("foreign_keys = OFF"); // Synthetic rows are copied before dependency ordering.
  for (const object of objects.filter(value => value.type === "table")) target.exec(object.sql);
  for (const object of objects.filter(value => value.type !== "table")) target.exec(object.sql);
  store.close();
  const conversionId = "synthetic-fixture-conversion";
  target.prepare(`INSERT INTO cogate_lineage_conversions VALUES
    (?,'cogate-lineage-conversion/v1',?,'cogate-v2-workspace-hmac/schema21/v1',21,31,
      ?,?,?,?,?,?,?,?,'{"outcome":"UNKNOWN","synthetic":true}')`)
    .run(conversionId, ledger.source.logicalDatabaseId, ledger.preservationSha256,
      options.initialized ? "d9fce658244857598812635344b0fccf5f96da585648be64d873a371184c1329" : "a".repeat(64),
      ...Array(5).fill("a".repeat(64)), options.initialized ? "2026-10-01T00:00:00.000Z" : "2026-10-01T00:00:00Z");
  const archivedKeys = new Set(["schema_version", "state_migration_catalog_version", "state_schema_origin"]);
  for (const table of plan.tables) {
    const columns = table.sourceColumns.filter(column => column !== "execution_mode");
    const rows = source.prepare(`SELECT ${columns.map(column =>
      `typeof("${column}"),CASE WHEN typeof("${column}") IN ('text','blob') THEN hex(CAST("${column}" AS BLOB)) ELSE "${column}" END`)
      .join(",")} FROM "${table.name}"`).raw(true).safeIntegers(true).all() as unknown[][];
    for (const row of rows) {
      let key: string | undefined;
      if (table.name === "bridge_meta") {
        const bytes = Buffer.from(row[1] as string,"hex");
        if (ledger.databaseEncoding === "UTF-16be") bytes.swap16();
        key = bytes.toString(ledger.databaseEncoding === "UTF-8" ? "utf8" : "utf16le");
      }
      const archived = key !== undefined && archivedKeys.has(key);
      const expressions = columns.map((_,index) => row[index*2] === "text" ? "CAST(? AS TEXT)" : "?");
      const values = columns.map((_,index) => ["text","blob"].includes(row[index*2] as string) ?
        Buffer.from(row[index*2+1] as string,"hex") : row[index*2+1]);
      if (archived) {
        if (options.metadata !== "missing" || key !== "state_schema_origin") {
          target.prepare(`INSERT INTO cogate_legacy_metadata(conversion_id,key,value)
            VALUES(?,${expressions.join(",")})`).run(conversionId,...values);
        }
      }
      else target.prepare(`INSERT INTO "${table.name}"(${columns.map(column=>`"${column}"`).join(",")})
        VALUES(${expressions.join(",")})`).run(...values);
    }
    if (table.name === "activities" || table.name === "jobs") {
      const kind = table.name === "jobs" ? "job" : "activity";
      const rows = source.prepare(`SELECT ${kind}_id AS id,execution_mode FROM ${table.name}`).all() as Array<{id:string;execution_mode:string}>;
      for (const row of rows) {
        if (options.mode === "missing" && kind === "job") continue;
        target.prepare("INSERT INTO cogate_legacy_execution_modes VALUES(?,?,?,?)")
          .run(conversionId,kind,row.id,options.mode === "changed" ? "background" : row.execution_mode);
      }
    }
  }
  legacyMeta(target,"schema_version","31");
  legacyMeta(target,"state_migration_catalog_version","1");
  legacyMeta(target,"state_schema_origin",'{"kind":"synthetic-converted-fixture"}');
  if (options.initialized) {
    const recordedAt = "2026-10-01T00:00:00.000Z";
    legacyMeta(target,"state_schema_origin",JSON.stringify({ kind:"lineage-conversion",format:"cogate-unified-origin/v1",
      sourceProfile:plan.sourceProfile,sourceSchema:21,targetSchema:31,
      logicalDatabaseId:ledger.source.logicalDatabaseId,conversionId,
      sourcePreservationSha256:ledger.preservationSha256,recordedAt }));
    legacyMeta(target,"cogate_lineage_conversion_v1",conversionId);
    legacyMeta(target,"schema_v31_cogate_storage","workspace-hmac-and-lineage-evidence-v1");
    legacyMeta(target,"schema_v31_migrated_at",recordedAt);
    target.exec(`INSERT INTO model_description_versions(model_id,version,description,created_at)
      SELECT j.key,1,j.value,NULL FROM user_settings u,json_each(u.payload,'$.modelDescriptionOverrides') j
      WHERE j.type='text' AND j.value<>''`);
  }
  if (options.mode === "orphan") target.prepare("INSERT INTO cogate_legacy_execution_modes VALUES(?,?,?,?)")
    .run(conversionId,"job","orphan-job","foreground");
  if (options.metadata === "unexpected") target.prepare("INSERT INTO cogate_legacy_metadata VALUES(?,?,?)")
    .run(conversionId,"unexpected_namespace","retained");
  for (const row of source.prepare("SELECT name,seq FROM sqlite_sequence").safeIntegers(true).all() as Array<{name:string;seq:bigint}>)
    target.prepare("INSERT INTO sqlite_sequence VALUES(?,?)").run(row.name,row.seq);
  target.pragma("foreign_keys = ON");
  return { source,target,ledger,conversionId,close(){ source.close(); target.close(); } };
}
