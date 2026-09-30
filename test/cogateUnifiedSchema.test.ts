import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import profile from "../src/cogateLegacySourceProfile.json" with { type: "json" };
import {
  COGATE_UNIFIED_SCHEMA_TABLES, COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256,
  COGATE_UNIFIED_SCHEMA_OBJECT_NAMES,
  V31_COGATE_UNIFIED_MIGRATION_SCHEMA
} from "../src/cogateUnifiedSchema.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { prepareStateDatabaseOpen } from "../src/stateDatabaseLifecycle.js";
import { STATE_MIGRATIONS } from "../src/stateCompatibility.js";
import { createSchema18Fixture } from "./helpers/stateSchemaFixtures.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function file(): string {
  const root = mkdtempSync(path.join(tmpdir(), "cogate-schema31-"));
  roots.push(root); return path.join(root, "state.sqlite");
}
function objects(db: Database.Database) {
  return db.prepare(`SELECT type,name,tbl_name AS tableName,sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      AND tbl_name IN (${COGATE_UNIFIED_SCHEMA_TABLES.map(() => "?").join(",")})
    ORDER BY type,name`).all(...COGATE_UNIFIED_SCHEMA_TABLES);
}
function seedReceipt(db: Database.Database): void {
  db.prepare(`INSERT INTO cogate_lineage_conversions VALUES
    (?,'cogate-lineage-conversion/v1',?,'cogate-v2-workspace-hmac/schema21/v1',21,31,
      ?,?,?,?,?,?,?,'2026-10-01T00:00:00Z','{"outcome":"UNKNOWN"}')`)
    .run("fixture-conversion", "fixture-logical-id", ...Array(7).fill("a".repeat(64)));
}

describe("unified schema31 storage without conversion authority", () => {
  it("retains every fixed legacy Workspace/HMAC constraint and starts disabled", () => {
    const db = new Database(":memory:");
    try {
      db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA);
      const actual = objects(db) as Array<{ type: string; name: string; tableName: string; sql: string }>;
      const old = profile.objects.filter(object =>
        (COGATE_UNIFIED_SCHEMA_TABLES as readonly string[]).slice(0, 10).includes(object.tableName));
      expect(actual.filter(object => old.some(prior => prior.name === object.name))).toEqual(old);
      expect(actual).toHaveLength(old.length + 12);
      expect(actual.map(object => object.name)).toEqual(COGATE_UNIFIED_SCHEMA_OBJECT_NAMES);
      expect(createHash("sha256").update(JSON.stringify(actual)).digest("hex"))
        .toBe(COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256);
      expect(db.prepare("SELECT * FROM workspace_control").get())
        .toEqual({ singleton: 1, mode: "disabled", revision: 1, maintenance: 0, updated_at: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM security_hmac_keys").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM cogate_lineage_conversions").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("upgrades a real upstream schema30 checkpoint without replacing its history or creating delivery proof", () => {
    const name = file(); createSchema18Fixture(name);
    expect(() => new BridgeStateStore({ file: name, onMigrationProgress(progress) {
      if (progress.targetSchema === 30) throw new Error("fixture-schema30");
    } })).toThrow("fixture-schema30");
    let db = new Database(name);
    const logicalId = db.prepare("SELECT value FROM bridge_meta WHERE key='state_database_id'").get();
    const priorReceipts = db.prepare("SELECT key,value FROM bridge_meta WHERE key LIKE 'state_migration:%' ORDER BY key").all();
    const priorJobs = db.prepare("SELECT * FROM jobs ORDER BY job_id").all();
    const priorDeliveries = db.prepare("SELECT * FROM job_completion_deliveries ORDER BY job_id").all();
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key='schema_version'").get()).toEqual({ value: "30" });
    db.close();
    const upgraded = new BridgeStateStore({ file: name });
    expect(upgraded.schemaVersion).toBe(31); upgraded.close();
    db = new Database(name, { readonly: true });
    try {
      expect(db.prepare("SELECT value FROM bridge_meta WHERE key='state_database_id'").get()).toEqual(logicalId);
      expect(db.prepare("SELECT key,value FROM bridge_meta WHERE key LIKE 'state_migration:%' AND key!='state_migration:bridge-state-30-to-31' ORDER BY key").all()).toEqual(priorReceipts);
      expect(db.prepare("SELECT * FROM jobs ORDER BY job_id").all()).toEqual(priorJobs);
      expect(db.prepare("SELECT * FROM job_completion_deliveries ORDER BY job_id").all()).toEqual(priorDeliveries);
      expect(db.prepare("SELECT COUNT(*) AS n FROM cogate_lineage_conversions").get()).toEqual({ n: 0 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
    expect(() => new BridgeStateStore({ file: name }).close()).not.toThrow();
    expect(STATE_MIGRATIONS.find(entry => entry.fromSchema === 19)?.sha256)
      .toBe("222930aeebb1d123777b3b614bccac9b0ecedd58634b4861056ed5a6ce68ac81");
    expect(STATE_MIGRATIONS.find(entry => entry.fromSchema === 20)?.sha256)
      .toBe("779549234164d275635d5a5d5a3b2aa0df07dc0981035636795d110e5dd5b48a");
  });

  it.each([
    "DROP TRIGGER security_hmac_keys_no_delete",
    "DROP TABLE cogate_legacy_execution_modes",
    "CREATE TRIGGER foreign_writer AFTER INSERT ON workspaces BEGIN SELECT 1; END"
  ])("rejects changed schema31 objects before startup writes: %s", sql => {
    const name = file(); new BridgeStateStore({ file: name }).close();
    const db = new Database(name); db.exec(sql); db.pragma("journal_mode = DELETE"); db.close();
    const before = readFileSync(name), entries = readdirSync(path.dirname(name)).sort();
    expect(() => prepareStateDatabaseOpen(name)).toThrow(/schema31 CoGate storage objects conflict/);
    expect(readFileSync(name)).toEqual(before);
    expect(readdirSync(path.dirname(name)).sort()).toEqual(entries);
  });

  it("keeps the old numeric schema21 out of automatic startup", () => {
    const name = file(), db = new Database(name);
    for (const object of profile.objects.filter(object => object.type === "table")) db.exec(object.sql);
    for (const object of profile.objects.filter(object => object.type !== "table")) db.exec(object.sql);
    db.prepare("INSERT INTO bridge_meta VALUES('schema_version','21')").run(); db.close();
    const before = readFileSync(name), entries = readdirSync(path.dirname(name)).sort();
    expect(() => new BridgeStateStore({ file: name })).toThrow(/lineage shape conflicts/);
    expect(readFileSync(name)).toEqual(before);
    expect(readdirSync(path.dirname(name)).sort()).toEqual(entries);
  });

  it.each([19, 30])("rejects a partial CoGate namespace under upstream schema%s", schema => {
    const name = file(); createSchema18Fixture(name);
    expect(() => new BridgeStateStore({ file: name, onMigrationProgress(progress) {
      if (progress.targetSchema === schema) throw new Error("fixture-before-extension");
    } })).toThrow("fixture-before-extension");
    const db = new Database(name);
    db.exec("CREATE TABLE cogate_legacy_metadata(fake TEXT)");
    db.pragma("journal_mode = DELETE"); db.close();
    const before = readFileSync(name), entries = readdirSync(path.dirname(name)).sort();
    const status = readFileSync(`${name}.migration-status.json`);
    expect(() => new BridgeStateStore({ file: name })).toThrow(/lineage shape conflicts/);
    expect(readFileSync(name)).toEqual(before);
    expect(readFileSync(`${name}.migration-status.json`)).toEqual(status);
    expect(readdirSync(path.dirname(name)).sort()).toEqual(entries);
  });

  it.each([
    "CREATE VIEW cogate_legacy_metadata AS SELECT 1 AS marker",
    "CREATE INDEX security_hmac_one_active ON jobs(job_id)",
    "CREATE TRIGGER cogate_lineage_conversions_no_update AFTER INSERT ON bridge_meta BEGIN SELECT 1; END",
    "CREATE VIEW COGATE_LEGACY_METADATA AS SELECT 1 AS marker",
    "CREATE INDEX SECURITY_HMAC_ONE_ACTIVE ON jobs(job_id)",
    "CREATE TRIGGER COGATE_LINEAGE_CONVERSIONS_NO_UPDATE AFTER INSERT ON bridge_meta BEGIN SELECT 1; END"
  ])("rejects a reserved non-table name before pending/status writes: %s", sql => {
    const name = file(); createSchema18Fixture(name);
    expect(() => new BridgeStateStore({ file: name, onMigrationProgress(progress) {
      if (progress.targetSchema === 30) throw new Error("fixture-reserved-name");
    } })).toThrow("fixture-reserved-name");
    const db = new Database(name); db.exec(sql);
    const before = readFileSync(name), wal = readFileSync(`${name}-wal`);
    const entries = readdirSync(path.dirname(name)).sort();
    const status = readFileSync(`${name}.migration-status.json`);
    try {
      expect(() => new BridgeStateStore({ file: name })).toThrow(/lineage shape conflicts/);
      expect(readFileSync(name)).toEqual(before);
      expect(readFileSync(`${name}-wal`)).toEqual(wal);
      expect(readFileSync(`${name}.migration-status.json`)).toEqual(status);
      expect(readdirSync(path.dirname(name)).sort()).toEqual(entries);
      expect(db.prepare("SELECT value FROM bridge_meta WHERE key='state_migration_pending'").get()).toBeUndefined();
    } finally { db.close(); }
  });

  it("recovers the schema31 committed checkpoint without replaying DDL or replacing prior receipts", () => {
    const name = file(); createSchema18Fixture(name);
    expect(() => new BridgeStateStore({ file: name, onMigrationSchemaCommitted(progress) {
      if (progress.targetSchema === 31) throw new Error("fixture-committed-extension");
    } })).toThrow("fixture-committed-extension");
    let db = new Database(name);
    const prior = db.prepare("SELECT key,value FROM bridge_meta WHERE key LIKE 'state_migration:%' ORDER BY key").all();
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key='schema_version'").get()).toEqual({ value: "31" });
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key='state_migration:bridge-state-30-to-31'").get()).toBeUndefined();
    db.close();
    new BridgeStateStore({ file: name }).close();
    db = new Database(name, { readonly: true });
    try {
      expect(db.prepare("SELECT key,value FROM bridge_meta WHERE key LIKE 'state_migration:%' AND key!='state_migration:bridge-state-30-to-31' ORDER BY key").all()).toEqual(prior);
      expect(db.prepare("SELECT value FROM bridge_meta WHERE key='state_migration_pending'").get()).toBeUndefined();
      expect(db.prepare("SELECT COUNT(*) AS n FROM cogate_lineage_conversions").get()).toEqual({ n: 0 });
      expect(createHash("sha256").update(JSON.stringify(objects(db))).digest("hex"))
        .toBe(COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256);
    } finally { db.close(); }
  });

  it("preserves raw metadata bytes and UNKNOWN in immutable archives", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON"); db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA); seedReceipt(db);
      const raw = "7b22554e4b4e4f574e223a2200ffc080227d";
      db.prepare("INSERT INTO cogate_legacy_metadata VALUES('fixture-conversion','old-gap',CAST(? AS TEXT))")
        .run(Buffer.from(raw, "hex"));
      db.prepare("INSERT INTO cogate_legacy_execution_modes VALUES('fixture-conversion','job','old-job','foreground')").run();
      expect(db.prepare("SELECT hex(CAST(value AS BLOB)) AS raw FROM cogate_legacy_metadata").get())
        .toEqual({ raw: raw.toUpperCase() });
      expect(db.prepare("SELECT evidence FROM cogate_lineage_conversions").get())
        .toEqual({ evidence: '{"outcome":"UNKNOWN"}' });
      for (const table of COGATE_UNIFIED_SCHEMA_TABLES.slice(10)) {
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/evidence is immutable/);
        const column = table === "cogate_legacy_metadata" ? "value" :
          table === "cogate_legacy_execution_modes" ? "execution_mode" : "evidence";
        expect(() => db.exec(`UPDATE ${table} SET ${column}=${column}`)).toThrow(/evidence is immutable/);
      }
      expect(() => db.prepare("INSERT INTO cogate_legacy_metadata VALUES('orphan','key','value')").run())
        .toThrow(/FOREIGN KEY/);
      expect(() => seedReceipt(db)).toThrow(/evidence is immutable/);
    } finally { db.close(); }
  });

  it.each([0, 1])("rejects REPLACE, UPSERT and rowid aliases with recursive_triggers=%s", recursive => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON"); db.pragma(`recursive_triggers = ${recursive}`);
      db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA); seedReceipt(db);
      db.exec("INSERT INTO cogate_legacy_metadata VALUES('fixture-conversion','old-gap','UNKNOWN')");
      db.exec("INSERT INTO cogate_legacy_execution_modes VALUES('fixture-conversion','job','old-job','foreground')");
      for (const table of COGATE_UNIFIED_SCHEMA_TABLES.slice(10)) {
        const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(row => row.name);
        const column = table === "cogate_legacy_metadata" ? "value" :
          table === "cogate_legacy_execution_modes" ? "execution_mode" : "evidence";
        const changed = column === "evidence" ? "'{\"outcome\":\"PASS\"}'" :
          column === "value" ? "'PASS'" : "'background'";
        const projection = columns.map(name => name === column ? changed : name).join(",");
        const before = db.prepare(`SELECT * FROM ${table}`).all();
        expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT ${projection} FROM ${table}`))
          .toThrow(/evidence is immutable/);
        expect(() => db.exec(`INSERT INTO ${table} SELECT ${projection} FROM ${table} WHERE 1
          ON CONFLICT DO UPDATE SET ${column}=${changed}`)).toThrow(/evidence is immutable/);
        expect(() => db.exec(`INSERT INTO ${table}(rowid) VALUES(1)`)).toThrow(/no column named rowid/);
        expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
      }
      const columns = (db.pragma("table_info(cogate_lineage_conversions)") as Array<{ name: string }>).map(row => row.name);
      const projection = columns.map(name => name === "conversion_id" ? "'new-id-same-logical-db'" : name).join(",");
      expect(() => db.exec(`INSERT OR REPLACE INTO cogate_lineage_conversions
        SELECT ${projection} FROM cogate_lineage_conversions`)).toThrow(/evidence is immutable/);
      expect(db.prepare("SELECT conversion_id,evidence FROM cogate_lineage_conversions").all())
        .toEqual([{ conversion_id: "fixture-conversion", evidence: '{"outcome":"UNKNOWN"}' }]);
    } finally { db.close(); }
  });

  it.each(["source_schema=30", "target_schema=21", "approval_sha256='NOT-A-DIGEST'"])(
    "rejects an untyped conversion binding: %s", bad => {
      const db = new Database(":memory:");
      try {
        db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA); seedReceipt(db);
        // INSERT bypasses no mutation guard: CHECK constraints must reject it.
        const column = bad.slice(0, bad.indexOf("=")), expression = bad.slice(bad.indexOf("=") + 1);
        const columns = (db.pragma("table_info(cogate_lineage_conversions)") as Array<{ name: string }>).map(row => row.name);
        const projection = columns.map(name => name === column ? expression :
          name === "conversion_id" || name === "logical_database_id" ? `${name} || '-other'` : name).join(",");
        expect(() => db.exec(`INSERT INTO cogate_lineage_conversions SELECT ${projection} FROM cogate_lineage_conversions`))
          .toThrow(/CHECK/);
        expect(db.prepare("SELECT COUNT(*) AS n FROM cogate_lineage_conversions").get()).toEqual({ n: 1 });
      } finally { db.close(); }
    }
  );
});
