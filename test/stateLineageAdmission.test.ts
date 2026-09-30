import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { prepareStateDatabaseOpen } from "../src/stateDatabaseLifecycle.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { createSchema18Fixture } from "./helpers/stateSchemaFixtures.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true }); });
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-lineage-"));
  roots.push(root);
  return path.join(root, "state.sqlite");
}
function upstream21(file: string): void {
  createSchema18Fixture(file);
  expect(() => new BridgeStateStore({ file, onMigrationProgress(progress) {
    if (progress.targetSchema === 21) throw new Error("fixture-checkpoint-21");
  } })).toThrow("fixture-checkpoint-21");
}
function probe(file: string): void {
  const lease = prepareStateDatabaseOpen(file);
  lease?.complete();
}
function unchangedRejectedFixture(
  edit: (database: Database.Database) => void, error: RegExp, pendingSchema?: number
): void {
  const file = fixture();
  if (pendingSchema === undefined) upstream21(file);
  else {
    createSchema18Fixture(file);
    expect(() => new BridgeStateStore({ file, onMigrationSchemaCommitted(progress) {
      if (progress.targetSchema === pendingSchema) throw new Error("fixture-pending");
    } })).toThrow("fixture-pending");
  }
  const database = new Database(file);
  edit(database);
  const before = readFileSync(file), walBefore = readFileSync(`${file}-wal`);
  const entries = readdirSync(path.dirname(file)).sort();
  try {
    expect(() => new BridgeStateStore({ file })).toThrow(error);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(`${file}-wal`)).toEqual(walBefore);
    expect(readdirSync(path.dirname(file)).sort()).toEqual(entries);
  } finally { database.close(); }
}

describe("state lineage admission before writes", () => {
  it.each(["startedAt", "productVersion", "buildId", "originalSourceSchema"])(
    "rejects a malformed pending %s before startup writes", field => {
      unchangedRejectedFixture(database => {
        const raw = database.prepare("SELECT value FROM bridge_meta WHERE key='state_migration_pending'").get() as { value: string };
        const pending = JSON.parse(raw.value);
        if (field === "originalSourceSchema") pending[field] = String(pending[field]);
        else delete pending[field];
        database.prepare("UPDATE bridge_meta SET value=? WHERE key='state_migration_pending'").run(JSON.stringify(pending));
      }, /invalid pending migration provenance/, 20);
    }
  );

  it("rejects a malformed retained gap before the first pending migration is finalized", () => {
    unchangedRejectedFixture(database => {
      database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_migration_provenance_gap',?)").run("{malformed");
    }, /provenance gap marker is invalid/, 19);
  });

  it("rejects a retained gap ahead of the pending checkpoint before startup writes", () => {
    unchangedRejectedFixture(database => {
      database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_migration_provenance_gap',?)").run(JSON.stringify({
        kind: "pre-contract-intermediate-checkpoint", originalSourceSchema: 18,
        observedSchema: 21, recordedAt: new Date().toISOString()
      }));
    }, /provenance gap marker is invalid/, 19);
  });

  it("rejects a pending first receipt whose claimed earlier source has no preceding path", () => {
    unchangedRejectedFixture(database => {
      const raw = database.prepare("SELECT value FROM bridge_meta WHERE key='state_migration_pending'").get() as { value: string };
      const pending = JSON.parse(raw.value);
      pending.originalSourceSchema = 3;
      database.prepare("UPDATE bridge_meta SET value=? WHERE key='state_migration_pending'").run(JSON.stringify(pending));
      database.prepare("UPDATE bridge_meta SET value='3' WHERE key='schema_v19_upgrade_source'").run();
    }, /no complete preceding provenance path/, 19);
  });
  it("rejects a missing durable original-source marker before startup writes", () => {
    unchangedRejectedFixture(database => {
      database.prepare("DELETE FROM bridge_meta WHERE key='schema_v19_upgrade_source'").run();
    }, /provenance has no supported original source schema/);
  });
  it("rejects a missing applied receipt before startup writes", () => {
    unchangedRejectedFixture(database => {
      database.prepare("DELETE FROM bridge_meta WHERE key=?").run("state_migration:bridge-state-19-to-20");
    }, /provenance is missing bridge-state-19-to-20/);
  });

  it("rejects an applied receipt with a different original source before startup writes", () => {
    unchangedRejectedFixture(database => {
      const key = "state_migration:bridge-state-19-to-20";
      const raw = database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string };
      const record = JSON.parse(raw.value);
      record.originalSourceSchema = 17;
      database.prepare("UPDATE bridge_meta SET value=? WHERE key=?").run(JSON.stringify(record), key);
    }, /provenance conflicts with bridge-state-19-to-20/);
  });

  it("rejects a completion table missing a required retry column before startup writes", () => {
    unchangedRejectedFixture(database => {
      const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
        .all("job_completion_deliveries") as Array<{ name: string }>;
      for (const index of indexes) database.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
      database.exec("ALTER TABLE job_completion_deliveries DROP COLUMN next_attempt_at");
    }, /lineage shape conflicts with schema 21/);
  });

  it.each([19, 21, 22])("retains committed pending migration recovery at schema %s", targetSchema => {
    const file = fixture();
    createSchema18Fixture(file);
    expect(() => new BridgeStateStore({ file, onMigrationSchemaCommitted(progress) {
      if (progress.targetSchema === targetSchema) throw new Error(`fixture-pending-${targetSchema}`);
    } })).toThrow(`fixture-pending-${targetSchema}`);
    const store = new BridgeStateStore({ file });
    try { expect(store.schemaVersion).toBe(30); }
    finally { store.close(); }
  });
  it("rejects a conflicting applied migration before creating upgrade sidecars or modifying the database", () => {
    const file = fixture();
    upstream21(file);
    const database = new Database(file);
    const key = "state_migration:bridge-state-19-to-20";
    const raw = database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string };
    const record = JSON.parse(raw.value);
    record.implementationSha256 = "2026875a08cfb857d0d217ef29a6b99efa667c947a0eb221cc9bf29115d8f38f";
    database.prepare("UPDATE bridge_meta SET value=? WHERE key=?").run(JSON.stringify(record), key);
    database.pragma("journal_mode = DELETE");
    database.close();
    const before = readFileSync(file);
    const entries = readdirSync(path.dirname(file)).sort();
    expect(() => probe(file)).toThrow(/provenance conflicts with bridge-state-19-to-20/);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(path.dirname(file)).sort()).toEqual(entries);
  });

  it("rejects a fresh foreign schema 21 with no migration records before any upgrade write", () => {
    const file = fixture();
    createSchema18Fixture(file);
    const database = new Database(file);
    database.prepare("UPDATE bridge_meta SET value='21' WHERE key='schema_version'").run();
    database.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES ('state_schema_origin',?)")
      .run(JSON.stringify({ kind: "fresh", schema: 21 }));
    database.close();
    const before = readFileSync(file);
    expect(() => probe(file)).toThrow(/lineage shape conflicts with schema 21/);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(path.dirname(file))).toEqual(["state.sqlite"]);
  });

  it("rejects an unknown applied migration even when the latest marker is otherwise valid", () => {
    const file = fixture();
    upstream21(file);
    const database = new Database(file);
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)")
      .run("state_migration:foreign-lineage", JSON.stringify({ id: "foreign-lineage" }));
    database.close();
    const before = readFileSync(file);
    expect(() => probe(file)).toThrow(/provenance conflicts with foreign-lineage/);
    expect(readFileSync(file)).toEqual(before);
  });

  it("retains supported upstream schema-21 checkpoint migration", () => {
    const file = fixture();
    upstream21(file);
    const store = new BridgeStateStore({ file });
    try { expect(store.schemaVersion).toBe(30); }
    finally { store.close(); }
  });

  it("retains historical receipts when a later published-version upgrade is interrupted", () => {
    const file = fixture();
    upstream21(file);
    const database = new Database(file);
    // Model the completion markers of an earlier release whose current schema
    // was 21. Its historical receipts remain bound to source18.
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)").run("state_last_migration_source_schema", "18");
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)").run("state_last_migration_target_schema", "21");
    database.prepare("DELETE FROM bridge_meta WHERE key='schema_v19_upgrade_source'").run();
    database.close();
    expect(() => new BridgeStateStore({ file, onMigrationProgress(progress) {
      if (progress.targetSchema === 22) throw new Error("fixture-later-upgrade-22");
    } })).toThrow("fixture-later-upgrade-22");
    const store = new BridgeStateStore({ file });
    try {
      expect(store.schemaVersion).toBe(30);
      expect(store.getMeta("state_last_migration_source_schema")).toBe("21");
      expect(JSON.parse(store.getMeta("state_migration:bridge-state-19-to-20")!).originalSourceSchema).toBe(18);
      expect(JSON.parse(store.getMeta("state_migration:bridge-state-21-to-22")!).originalSourceSchema).toBe(21);
    } finally { store.close(); }
  });

  it.each(["before-commit", "after-commit"])(
    "rejects a different later-upgrade pending source %s before startup writes", phase => {
      const file = fixture();
      upstream21(file);
      let database = new Database(file);
      database.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)").run("state_last_migration_source_schema", "18");
      database.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)").run("state_last_migration_target_schema", "21");
      database.prepare("DELETE FROM bridge_meta WHERE key='schema_v19_upgrade_source'").run();
      database.close();
      expect(() => new BridgeStateStore({ file, onMigrationSchemaCommitted(progress) {
        if (progress.targetSchema === 22) throw new Error("fixture-new-pending-22");
      } })).toThrow("fixture-new-pending-22");
      database = new Database(file);
      const raw = database.prepare("SELECT value FROM bridge_meta WHERE key='state_migration_pending'").get() as { value: string };
      const pending = JSON.parse(raw.value);
      pending.originalSourceSchema = 17;
      database.prepare("UPDATE bridge_meta SET value=? WHERE key='state_migration_pending'").run(JSON.stringify(pending));
      database.prepare("UPDATE bridge_meta SET value='17' WHERE key='schema_v19_upgrade_source'").run();
      if (phase === "before-commit") {
        database.exec("ALTER TABLE job_completion_deliveries DROP COLUMN result_read_source");
        database.prepare("UPDATE bridge_meta SET value='21' WHERE key='schema_version'").run();
      }
      const before = readFileSync(file), walBefore = readFileSync(`${file}-wal`);
      const entries = readdirSync(path.dirname(file)).sort();
      try {
        expect(() => new BridgeStateStore({ file })).toThrow(/Prospective state migration provenance is missing bridge-state-17-to-18/);
        expect(readFileSync(file)).toEqual(before);
        expect(readFileSync(`${file}-wal`)).toEqual(walBefore);
        expect(readdirSync(path.dirname(file)).sort()).toEqual(entries);
      } finally { database.close(); }
    }
  );

  it.each([17, 21, 22])("authenticates durable source %s before pending is created", source => {
    const file = fixture();
    upstream21(file);
    let database = new Database(file);
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)").run("state_last_migration_source_schema", "18");
    database.prepare("INSERT INTO bridge_meta(key,value) VALUES (?,?)").run("state_last_migration_target_schema", "21");
    database.prepare("DELETE FROM bridge_meta WHERE key='schema_v19_upgrade_source'").run();
    database.close();
    expect(() => new BridgeStateStore({ file, onMigrationSchemaCommitted(progress) {
      if (progress.targetSchema === 22) throw new Error("fixture-no-pending");
    } })).toThrow("fixture-no-pending");
    database = new Database(file);
    database.prepare("DELETE FROM bridge_meta WHERE key='state_migration_pending'").run();
    database.prepare("UPDATE bridge_meta SET value='21' WHERE key='schema_version'").run();
    database.exec("ALTER TABLE job_completion_deliveries DROP COLUMN result_read_source");
    database.prepare("UPDATE bridge_meta SET value=? WHERE key='schema_v19_upgrade_source'").run(String(source));
    if (source === 21) {
      database.close();
      const store = new BridgeStateStore({ file });
      try {
        expect(store.schemaVersion).toBe(30);
        expect(store.getMeta("state_last_migration_source_schema")).toBe("21");
        expect(JSON.parse(store.getMeta("state_migration:bridge-state-19-to-20")!).originalSourceSchema).toBe(18);
      } finally { store.close(); }
      return;
    }
    const before = readFileSync(file), walBefore = readFileSync(`${file}-wal`);
    const entries = readdirSync(path.dirname(file)).sort();
    try {
      expect(() => new BridgeStateStore({ file })).toThrow(source === 17
        ? /Prospective state migration provenance is missing bridge-state-17-to-18/
        : /original source is ahead of its observed checkpoint/);
      expect(readFileSync(file)).toEqual(before);
      expect(readFileSync(`${file}-wal`)).toEqual(walBefore);
      expect(readdirSync(path.dirname(file)).sort()).toEqual(entries);
    } finally { database.close(); }
  });

  it("rejects mixed CoGate structures even if the upstream completion shape is also present", () => {
    const file = fixture();
    upstream21(file);
    const database = new Database(file);
    database.exec("CREATE TABLE workspace_control(singleton INTEGER PRIMARY KEY, mode TEXT)");
    database.pragma("journal_mode = DELETE");
    database.close();
    const before = readFileSync(file);
    expect(() => probe(file)).toThrow(/lineage shape conflicts with schema 21/);
    expect(readFileSync(file)).toEqual(before);
  });

  it("rejects conflicting lineage without changing the source database or existing WAL bytes", () => {
    const file = fixture();
    upstream21(file);
    const database = new Database(file);
    const key = "state_migration:bridge-state-19-to-20";
    const raw = database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string };
    const record = JSON.parse(raw.value);
    record.implementationSha256 = "0".repeat(64);
    database.prepare("UPDATE bridge_meta SET value=? WHERE key=?").run(JSON.stringify(record), key);
    const before = readFileSync(file), walBefore = readFileSync(`${file}-wal`);
    const entries = readdirSync(path.dirname(file)).sort();
    try {
      expect(() => probe(file)).toThrow(/provenance conflicts with bridge-state-19-to-20/);
      expect(readFileSync(file)).toEqual(before);
      expect(readFileSync(`${file}-wal`)).toEqual(walBefore);
      expect(readdirSync(path.dirname(file)).sort()).toEqual(entries);
    } finally { database.close(); }
  });

  it("retains supported schema-20 crash recovery after schema commit and before provenance finalization", () => {
    const file = fixture();
    createSchema18Fixture(file);
    expect(() => new BridgeStateStore({ file, onMigrationSchemaCommitted(progress) {
      if (progress.targetSchema === 20) throw new Error("fixture-pending-20");
    } })).toThrow("fixture-pending-20");
    const store = new BridgeStateStore({ file });
    try { expect(store.schemaVersion).toBe(30); }
    finally { store.close(); }
  });
});
