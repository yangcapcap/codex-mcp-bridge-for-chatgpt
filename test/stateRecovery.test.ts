import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { inspectStateRecovery, restoreStateDatabase } from "../src/stateRecovery.js";
import { createSchema18Fixture, V18_RUNNING_JOB_ID } from "./helpers/stateSchemaFixtures.js";

describe("state recovery boundary", { timeout: 15_000 }, () => {
  it("restores the verified original only before service-open and preserves the replaced files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-restore-"));
    const file = path.join(root, "state.sqlite");
    seedKnownSourceRuntime(file);
    const store = new BridgeStateStore({ file });
    expect(store.schemaVersion).toBe(31);
    store.close();
    const backup = `${file}.pre-v18-to-v31.sqlite`;
    const backupBefore = readFileSync(backup);

    expect(inspectStateRecovery({ databaseFile: file, backupFile: backup })).toMatchObject({
      eligible: true,
      sourceSchema: 18,
      targetSchema: 31,
      sourceRuntimeKnown: true,
      serviceOpenedAfterMigration: false
    });
    const result = restoreStateDatabase({
      databaseFile: file,
      backupFile: backup,
      sourceRuntime: { productVersion: "0.3.0-dev-source", buildId: "source-build-18" }
    });

    expect(readSchema(file)).toBe(18);
    expect(readFileSync(backup)).toEqual(backupBefore);
    expect(existsSync(result.receiptFile)).toBe(true);
    expect(result.receipt).toMatchObject({
      sourceSchema: 18,
      replacedSchema: 31,
      sourceRuntimeProvenance: "recorded",
      serviceRestartVerified: false
    });
    expect(existsSync(path.join(root, result.receipt.quarantineDirectory, "state.sqlite"))).toBe(true);
  });

  it("refuses snapshot rollback after either HTTP or stdio service-open evidence", () => {
    for (const transport of ["http", "stdio"] as const) {
      const root = mkdtempSync(path.join(tmpdir(), `bridge-state-open-${transport}-`));
      const file = path.join(root, "state.sqlite");
      seedKnownSourceRuntime(file);
      const store = new BridgeStateStore({ file });
      store.markServiceOpen(transport);
      store.close();
      const backup = `${file}.pre-v18-to-v31.sqlite`;

      expect(inspectStateRecovery({ databaseFile: file, backupFile: backup })).toMatchObject({
        eligible: false,
        serviceOpenedAfterMigration: true
      });
      expect(() => restoreStateDatabase({
        databaseFile: file,
        backupFile: backup,
        sourceRuntime: { productVersion: "0.3.0-dev-source", buildId: "source-build-18" }
      })).toThrow(/forbidden after the migrated service has opened/);
      expect(readSchema(file)).toBe(31);
    }
  });

  it("rejects corrupted and same-schema backups from another database", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-backup-binding-"));
    const first = path.join(root, "first.sqlite");
    const second = path.join(root, "second.sqlite");
    createSchema18Fixture(first, { malformedJobPayload: true });
    createSchema18Fixture(second, { malformedJobPayload: true });
    expect(() => new BridgeStateStore({ file: first })).toThrow(/malformed JSON|Invalid job payload/);
    expect(() => new BridgeStateStore({ file: second })).toThrow(/malformed JSON|Invalid job payload/);
    const firstBackup = `${first}.pre-v18-to-v31.sqlite`;
    const secondBackup = `${second}.pre-v18-to-v31.sqlite`;

    const original = readFileSync(firstBackup);
    appendFileSync(firstBackup, "corrupt-checksum");
    repairMalformedJob(first);
    expect(() => new BridgeStateStore({ file: first })).toThrow(/checksum/);
    copyFileSync(secondBackup, firstBackup);
    expect(() => new BridgeStateStore({ file: first })).toThrow(/checksum|another state database/);
    writeFileSync(firstBackup, original);
  });

  it("requires an explicit source-runtime attestation when old metadata had none", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-runtime-attestation-"));
    const file = path.join(root, "state.sqlite");
    createSchema18Fixture(file);
    const store = new BridgeStateStore({ file });
    store.close();
    const backup = `${file}.pre-v18-to-v31.sqlite`;

    expect(() => restoreStateDatabase({
      databaseFile: file,
      backupFile: backup,
      sourceRuntime: { productVersion: "0.3.0", buildId: "operator-held-build" }
    })).toThrow(/Explicitly attest/);
    const restored = restoreStateDatabase({
      databaseFile: file,
      backupFile: backup,
      sourceRuntime: { productVersion: "0.3.0", buildId: "operator-held-build" },
      acknowledgeUnrecordedSourceRuntime: true
    });
    expect(restored.receipt.sourceRuntimeProvenance).toBe("operator-asserted");
    expect(readSchema(file)).toBe(18);
  });

  it("reports a checksum-corrupted recovery point as ineligible before restore", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-inspect-corrupt-"));
    const file = path.join(root, "state.sqlite");
    seedKnownSourceRuntime(file);
    const store = new BridgeStateStore({ file });
    store.close();
    const backup = `${file}.pre-v18-to-v31.sqlite`;
    appendFileSync(backup, "corrupt-after-migration");

    const inspection = inspectStateRecovery({ databaseFile: file, backupFile: backup });
    expect(inspection.eligible).toBe(false);
    expect(inspection.reasons.join(" ")).toMatch(/checksum/);
    expect(() => restoreStateDatabase({
      databaseFile: file,
      backupFile: backup,
      sourceRuntime: { productVersion: "0.3.0-dev-source", buildId: "source-build-18" }
    })).toThrow(/checksum/);
    expect(readSchema(file)).toBe(31);
  });

  it("rejects partially recorded source-runtime identity in backup metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-partial-runtime-"));
    const file = path.join(root, "state.sqlite");
    seedKnownSourceRuntime(file);
    const store = new BridgeStateStore({ file });
    store.close();
    const backup = `${file}.pre-v18-to-v31.sqlite`;
    const metadataFile = `${file}.migration-v18-to-v31.backup.json`;
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    metadata.sourceRuntime.buildId = null;
    metadata.restoreContract.sourceRuntimeKnown = false;
    metadata.restoreContract.unknownSourceRuntimeAction =
      "supply-exact-pre-upgrade-runtime-and-settings";
    writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);

    const inspection = inspectStateRecovery({ databaseFile: file, backupFile: backup });
    expect(inspection.eligible).toBe(false);
    expect(inspection.reasons.join(" ")).toMatch(/metadata does not match/);
    expect(() => restoreStateDatabase({
      databaseFile: file,
      backupFile: backup,
      sourceRuntime: { productVersion: "0.3.0-dev-source", buildId: "source-build-18" }
    })).toThrow(/metadata does not match/);
  });

  it("rejects a recovery point created by a different target build", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-target-runtime-"));
    const file = path.join(root, "state.sqlite");
    seedKnownSourceRuntime(file);
    const store = new BridgeStateStore({ file });
    store.close();
    const backup = `${file}.pre-v18-to-v31.sqlite`;
    const metadataFile = `${file}.migration-v18-to-v31.backup.json`;
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    metadata.targetRuntime.buildId = "another-target-build";
    writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);

    const inspection = inspectStateRecovery({ databaseFile: file, backupFile: backup });
    expect(inspection.eligible).toBe(false);
    expect(inspection.reasons.join(" ")).toMatch(/metadata does not match/);
    expect(() => restoreStateDatabase({
      databaseFile: file,
      backupFile: backup,
      sourceRuntime: { productVersion: "0.3.0-dev-source", buildId: "source-build-18" }
    })).toThrow(/metadata does not match/);
  });

  it("treats an invalid service-open marker as an unknown and unsafe boundary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bridge-state-unknown-open-boundary-"));
    const file = path.join(root, "state.sqlite");
    seedKnownSourceRuntime(file);
    const store = new BridgeStateStore({ file });
    store.close();
    const database = new Database(file);
    database.prepare(
      "UPDATE bridge_meta SET value='invalid' WHERE key='state_service_opened_after_migration'"
    ).run();
    database.close();
    const backup = `${file}.pre-v18-to-v31.sqlite`;

    expect(inspectStateRecovery({ databaseFile: file, backupFile: backup })).toMatchObject({
      eligible: false,
      serviceOpenedAfterMigration: null
    });
    expect(() => restoreStateDatabase({
      databaseFile: file,
      backupFile: backup,
      sourceRuntime: { productVersion: "0.3.0-dev-source", buildId: "source-build-18" }
    })).toThrow(/service-open boundary is unknown/);
  });
});

function seedKnownSourceRuntime(file: string): void {
  createSchema18Fixture(file);
  const database = new Database(file);
  database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_runtime_product_version',?)")
    .run("0.3.0-dev-source");
  database.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_runtime_build_id',?)")
    .run("source-build-18");
  database.close();
}

function repairMalformedJob(file: string): void {
  const database = new Database(file);
  database.prepare("UPDATE jobs SET payload='{}' WHERE job_id=?").run(V18_RUNNING_JOB_ID);
  database.close();
}

function readSchema(file: string): number {
  const database = new Database(file, { readonly: true, fileMustExist: true });
  const version = Number((database.prepare(
    "SELECT value FROM bridge_meta WHERE key='schema_version'"
  ).get() as { value: string }).value);
  database.close();
  return version;
}
