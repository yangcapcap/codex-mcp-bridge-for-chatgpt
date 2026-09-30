import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  acquireStateMaintenanceLease,
  inspectStateDatabase,
  prepareStateDatabaseOpen,
  prepareStateDatabaseUpgrade,
  readStateMigrationStatus,
  stateMigrationExtendsStartupDeadline
} from "../src/stateDatabaseLifecycle.js";
import { BridgeStateStore } from "../src/stateStore.js";
import {
  createSchema16Fixture,
  createSchema18Fixture,
  createSeededSchema3Fixture
} from "./helpers/stateSchemaFixtures.js";

describe("state database lifecycle", () => {
  it("fails capacity preflight before changing the supported source database", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-capacity-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const before = readFileSync(file);

    expect(() => prepareStateDatabaseUpgrade(file, { availableBytes: 0 }))
      .toThrow(/Insufficient space/);
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(`${file}.pre-v18-to-v31.sqlite`)).toBe(false);
    expect(existsSync(`${file}.migration-lock.json`)).toBe(false);
    expect(readStateMigrationStatus(file)).toMatchObject({
      phase: "failed",
      sourceSchema: 18,
      targetSchema: 31
    });
  });

  it("fails permission preflight before changing the supported source database", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-permission-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const before = readFileSync(file);

    expect(() => prepareStateDatabaseUpgrade(file, { writable: false }))
      .toThrow(/permission preflight reported a read-only database or directory/);
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(`${file}.pre-v18-to-v31.sqlite`)).toBe(false);
    expect(existsSync(`${file}.migration-lock.json`)).toBe(false);
  });

  it("rejects malformed and unsupported databases before creating lifecycle sidecars", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-readonly-reject-"));
    const malformed = path.join(root, "malformed.sqlite");
    writeFileSync(malformed, "not a sqlite database");
    const malformedBefore = readFileSync(malformed);
    expect(() => prepareStateDatabaseOpen(malformed)).toThrow();
    expect(readFileSync(malformed)).toEqual(malformedBefore);
    expect(existsSync(`${malformed}.migration-lock.json`)).toBe(false);
    expect(existsSync(`${malformed}.migration-status.json`)).toBe(false);

    const future = path.join(root, "future.sqlite");
    const current = new BridgeStateStore({ file: future });
    current.close();
    const database = new Database(future);
    database.prepare("UPDATE bridge_meta SET value='999' WHERE key='schema_version'").run();
    database.close();
    const futureBefore = readFileSync(future);
    expect(() => prepareStateDatabaseOpen(future)).toThrow(/Unsupported.*999/);
    expect(readFileSync(future)).toEqual(futureBefore);
    expect(existsSync(`${future}.migration-lock.json`)).toBe(false);
    expect(existsSync(`${future}.migration-status.json`)).toBe(false);

    const nonCanonical = path.join(root, "non-canonical.sqlite");
    const nonCanonicalStore = new BridgeStateStore({ file: nonCanonical });
    nonCanonicalStore.close();
    const nonCanonicalDatabase = new Database(nonCanonical);
    nonCanonicalDatabase.prepare("UPDATE bridge_meta SET value='019' WHERE key='schema_version'").run();
    nonCanonicalDatabase.close();
    const nonCanonicalBefore = readFileSync(nonCanonical);
    expect(() => prepareStateDatabaseOpen(nonCanonical)).toThrow(/valid integer schema_version/);
    expect(readFileSync(nonCanonical)).toEqual(nonCanonicalBefore);
    expect(existsSync(`${nonCanonical}.migration-lock.json`)).toBe(false);
    expect(existsSync(`${nonCanonical}.migration-status.json`)).toBe(false);
  });

  it("uses the real database target for alias-safe maintenance ownership", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-alias-"));
    const file = path.join(root, "state.sqlite");
    const alias = path.join(root, "state-alias.sqlite");
    createSchema18Fixture(file);
    symlinkSync(file, alias);

    const lease = acquireStateMaintenanceLease(file, "recovery");
    try {
      expect(() => new BridgeStateStore({ file: alias })).toThrow(
        /migration is already owned by live process/
      );
    } finally {
      lease.release();
    }
    expect(existsSync(`${file}.migration-lock.json`)).toBe(false);
  });

  it("prevents a second current runtime from opening the same database through an alias", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-current-owner-"));
    const file = path.join(root, "state.sqlite");
    const first = new BridgeStateStore({ file });
    const alias = path.join(root, "current-alias.sqlite");
    symlinkSync(file, alias);
    try {
      expect(() => new BridgeStateStore({ file: alias })).toThrow(
        /upgrade\/startup requires every database owner to stop/
      );
    } finally {
      first.close();
    }
    const reopened = new BridgeStateStore({ file: alias });
    reopened.close();
  });

  it("rejects a migration while a live bridge instance owns the database", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-owner-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const database = new Database(file);
    database.prepare(`INSERT INTO bridge_instances(
      instance_id,started_at,stopped_at,termination_reason,process_id,payload
    ) VALUES ('live-test-owner',1,NULL,NULL,?,'{}')`).run(process.pid);
    database.close();

    expect(() => new BridgeStateStore({ file })).toThrow(/requires every database owner to stop/);
    expect(inspectStateDatabase(file).schemaVersion).toBe(18);
    expect(existsSync(`${file}.pre-v18-to-v31.sqlite`)).toBe(false);
  });

  it("derives every supported intermediate start from real committed checkpoints", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-checkpoints-"));
    for (let targetSchema = 4; targetSchema <= 18; targetSchema += 1) {
      const file = path.join(root, `schema-${targetSchema}.sqlite`);
      if (targetSchema === 16) {
        createSchema16Fixture(file);
        const direct = new BridgeStateStore({ file });
        expect(direct.schemaVersion).toBe(31);
        expect(direct.getMeta("schema_v19_source_version")).toBe("16");
        direct.close();
        continue;
      }
      createSeededSchema3Fixture(file);
      expect(() => new BridgeStateStore({
        file,
        onMigrationProgress(progress) {
          if (progress.targetSchema === targetSchema) throw new Error(`checkpoint-${targetSchema}`);
        }
      })).toThrow(`checkpoint-${targetSchema}`);
      const checkpoint = new Database(file);
      expect(readSchema(checkpoint)).toBe(targetSchema);
      // A real interrupted upgrade retains its durable original-source marker.
      // Deleting that marker would fabricate a different upgrade lineage.
      checkpoint.close();

      const resumed = new BridgeStateStore({ file });
      expect(resumed.schemaVersion).toBe(31);
      expect(resumed.getMeta("schema_v19_source_version")).toBe("3");
      resumed.close();
    }
  }, 30_000);

  it("records a completed progress status for the exact committed path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-progress-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const checkpoints: number[] = [];
    const store = new BridgeStateStore({
      file,
      onMigrationProgress: (progress) => checkpoints.push(progress.targetSchema)
    });
    store.close();

    expect(checkpoints).toEqual([19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
    expect(readStateMigrationStatus(file)).toMatchObject({
      phase: "completed",
      sourceSchema: 18,
      currentSchema: 31,
      migrationId: "bridge-state-30-to-31"
    });
  });

  it("reconciles a crash after schema commit without inventing a provenance gap", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-provenance-crash-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);

    expect(() => new BridgeStateStore({
      file,
      onMigrationSchemaCommitted() {
        throw new Error("crash-after-schema-commit");
      }
    })).toThrow("crash-after-schema-commit");
    const interrupted = new Database(file, { readonly: true, fileMustExist: true });
    expect(readSchema(interrupted)).toBe(19);
    expect(readMeta(interrupted, "state_migration_pending")).toContain("bridge-state-18-to-19");
    expect(readMeta(interrupted, "state_migration_provenance_gap")).toBeUndefined();
    interrupted.close();
    expect(readStateMigrationStatus(file)).toMatchObject({
      phase: "failed",
      sourceSchema: 18,
      currentSchema: 19
    });

    const resumed = new BridgeStateStore({ file });
    expect(resumed.getMeta("state_migration_pending")).toBeUndefined();
    expect(resumed.getMeta("state_migration_provenance_gap")).toBeUndefined();
    expect(JSON.parse(resumed.getMeta("state_migration:bridge-state-18-to-19")!)).toMatchObject({
      id: "bridge-state-18-to-19",
      fromSchema: 18,
      toSchema: 19,
      originalSourceSchema: 18
    });
    resumed.close();
  });

  it("rejects a changed applied-migration checksum on a later startup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-provenance-tamper-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const store = new BridgeStateStore({ file });
    store.close();
    const database = new Database(file);
    const key = "state_migration:bridge-state-18-to-19";
    const record = JSON.parse(readMeta(database, key)!);
    record.implementationSha256 = "0".repeat(64);
    database.prepare("UPDATE bridge_meta SET value=? WHERE key=?")
      .run(JSON.stringify(record), key);
    database.close();

    expect(() => new BridgeStateStore({ file })).toThrow(
      /provenance conflicts with bridge-state-18-to-19/
    );
  });

  it("extends helper readiness only for fresh, live, identity-bound migration progress", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-progress-freshness-"));
    const file = path.join(root, "state.sqlite");
    const alias = path.join(root, "state-alias.sqlite");
    const now = Date.parse("2026-09-12T00:00:00.000Z");
    createSchema18Fixture(file);
    symlinkSync(file, alias);
    const lease = prepareStateDatabaseUpgrade(file, { now: () => new Date(now) })!;
    try {
      lease.reportMigration({ id: "bridge-state-18-to-19", toSchema: 19 });
      const status = readStateMigrationStatus(alias)!;
      expect(stateMigrationExtendsStartupDeadline(file, status, now + 1_000)).toBe(true);
      expect(stateMigrationExtendsStartupDeadline(alias, status, now + 1_000)).toBe(true);
      expect(stateMigrationExtendsStartupDeadline(file, {
        ...status,
        databaseIdentity: "0".repeat(64)
      }, now + 1_000)).toBe(false);
      expect(stateMigrationExtendsStartupDeadline(file, status, now + 31_000)).toBe(false);
      expect(stateMigrationExtendsStartupDeadline(file, {
        ...status,
        phase: "completed"
      }, now + 1_000)).toBe(false);
    } finally {
      lease.fail(new Error("test-complete"));
    }
  });
});

function readSchema(database: Database.Database): number {
  return Number((database.prepare(
    "SELECT value FROM bridge_meta WHERE key='schema_version'"
  ).get() as { value: string }).value);
}

function readMeta(database: Database.Database, key: string): string | undefined {
  return (database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as
    | { value: string }
    | undefined)?.value;
}
