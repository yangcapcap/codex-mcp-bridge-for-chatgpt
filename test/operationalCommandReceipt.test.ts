import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { V24_DECISION_CARD_MIGRATION_SCHEMA } from "../src/decisionCardStore.js";
import { MAINTENANCE_COMMAND_RECEIPT_RETENTION_MS } from "../src/operationalCommandReceipt.js";
import {
  CURRENT_STATE_SCHEMA,
  V20_ASYNC_EXECUTION_MIGRATION_SCHEMA,
  V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA,
  V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA,
  V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA
} from "../src/stateSchema.js";
import { BridgeStateStore } from "../src/stateStore.js";

const hash = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

describe("operational command receipts", () => {
  it("commits a mutation and receipt together and replays the first result", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const commandId = randomUUID();
    const generation = randomUUID();
    const payloadSha256 = hash({ operation: "probe", value: 1 });
    const phases: string[] = [];
    const apply = vi.fn(() => {
      store.setMeta("receipt_probe", "committed-once");
      return { result: { value: 7 }, resultingVersion: 3 };
    });
    try {
      expect(store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256,
        aggregateKey: "probe:one",
        workerGeneration: generation,
        committedAt: 123
      }, apply, phase => phases.push(phase))).toEqual({
        replayed: false,
        receipt: {
          commandId,
          operation: "probe",
          payloadSha256,
          aggregateKey: "probe:one",
          resultingVersion: 3,
          result: { value: 7 },
          workerGeneration: generation,
          committedAt: 123
        }
      });
      expect(phases).toEqual(["write-lock-wait", "executing", "committing"]);

      expect(store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256,
        aggregateKey: "probe:one",
        workerGeneration: randomUUID()
      }, apply)).toMatchObject({
        replayed: true,
        receipt: { result: { value: 7 }, workerGeneration: generation }
      });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(store.getMeta("receipt_probe")).toBe("committed-once");
      expect(store.getOperationalCommandReceipt(commandId)).toMatchObject({
        commandId,
        payloadSha256,
        result: { value: 7 }
      });
    } finally {
      store.close();
    }
  });

  it("rejects command-ID reuse with a different payload without applying it", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const commandId = randomUUID();
    const generation = randomUUID();
    try {
      store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256: hash({ value: 1 }),
        workerGeneration: generation
      }, () => ({ result: { value: 1 } }));
      expect(() => store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256: hash({ value: 2 }),
        workerGeneration: generation
      }, () => ({ result: { value: 2 } }))).toThrow(/STATE_COMMAND_CONFLICT/);
    } finally {
      store.close();
    }
  });

  it("does not let phase-observation failures change transaction semantics", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      expect(store.executeOperationalCommand({
        commandId: randomUUID(),
        operation: "probe",
        payloadSha256: hash({ operation: "probe" }),
        workerGeneration: randomUUID()
      }, () => {
        store.setMeta("receipt_observation_probe", "committed");
        return { result: { committed: true } };
      }, () => {
        throw new Error("diagnostic transport unavailable");
      })).toMatchObject({
        replayed: false,
        receipt: { result: { committed: true } }
      });
      expect(store.getMeta("receipt_observation_probe")).toBe("committed");
    } finally {
      store.close();
    }
  });

  it("rolls back the mutation when its receipt result is invalid", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      expect(() => store.executeOperationalCommand({
        commandId: randomUUID(),
        operation: "probe",
        payloadSha256: hash({ value: 1 }),
        workerGeneration: randomUUID()
      }, () => {
        store.setMeta("receipt_probe", "must-rollback");
        return { result: { oversized: "x".repeat(70 * 1024) } };
      })).toThrow(/STATE_COMMAND_RESULT_TOO_LARGE/);
      expect(store.getMeta("receipt_probe")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("persists receipts across a clean state-owner restart", () => {
    const root = mkdtempSync(path.join(tmpdir(), "operational-receipt-restart-"));
    const file = path.join(root, "state.sqlite");
    const commandId = randomUUID();
    const payloadSha256 = hash({ operation: "probe" });
    try {
      let store = new BridgeStateStore({ file });
      store.executeOperationalCommand({
        commandId,
        operation: "probe",
        payloadSha256,
        workerGeneration: randomUUID()
      }, () => ({ result: { retained: true } }));
      store.close();

      store = new BridgeStateStore({ file });
      expect(store.getOperationalCommandReceipt(commandId)).toMatchObject({
        operation: "probe",
        payloadSha256,
        result: { retained: true }
      });
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes only expired maintenance receipts in bounded slices", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    const generation = randomUUID();
    const now = MAINTENANCE_COMMAND_RECEIPT_RETENTION_MS + 10_000;
    const oldest = randomUUID();
    const older = randomUUID();
    const recent = randomUUID();
    const business = randomUUID();
    const commit = (commandId: string, operation: string, committedAt: number) =>
      store.executeOperationalCommand({
        commandId,
        operation,
        payloadSha256: hash({ commandId, operation }),
        workerGeneration: generation,
        committedAt
      }, () => ({ result: { commandId } }));
    try {
      commit(oldest, "maintain", 1);
      commit(older, "maintain", 2);
      commit(recent, "maintain", now);
      commit(business, "cancel-intent", 1);

      expect(store.maintainOperationalCommandReceiptRetention(now, 1))
        .toEqual({ receiptsRemoved: 1 });
      expect(store.getOperationalCommandReceipt(oldest)).toBeUndefined();
      expect(store.getOperationalCommandReceipt(older)).toBeDefined();

      expect(store.maintainOperationalCommandReceiptRetention(now, 1))
        .toEqual({ receiptsRemoved: 1 });
      expect(store.maintainOperationalCommandReceiptRetention(now, 1))
        .toEqual({ receiptsRemoved: 0 });

      for (let index = 0; index < 501; index += 1) {
        commit(randomUUID(), "maintain", index + 3);
      }
      let removed = 0;
      for (let slice = 0; slice < 8; slice++) {
        const result = store.maintainOperationalCommandReceiptRetention(now, 1_000);
        expect(result.receiptsRemoved).toBeLessThanOrEqual(64);
        removed += result.receiptsRemoved;
      }
      expect(removed).toBe(501);
      expect(store.maintainOperationalCommandReceiptRetention(now, 1_000))
        .toEqual({ receiptsRemoved: 0 });
      expect(store.getOperationalCommandReceipt(recent)).toBeDefined();
      expect(store.getOperationalCommandReceipt(business)).toBeDefined();
      expect(() => store.maintainOperationalCommandReceiptRetention(-1))
        .toThrow(/STATE_COMMAND_RECEIPT_RETENTION_INVALID/);
      expect(() => store.maintainOperationalCommandReceiptRetention(now, 0))
        .toThrow(/STATE_COMMAND_RECEIPT_RETENTION_INVALID/);
    } finally {
      store.close();
    }
  });

  it("upgrades schema 23 through the immutable Decision migration without retaining its tables", () => {
    const root = mkdtempSync(path.join(tmpdir(), "decision-retirement-v23-"));
    const file = path.join(root, "state.sqlite");
    const legacy = new Database(file);
    try {
      legacy.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;");
      legacy.exec(CURRENT_STATE_SCHEMA);
      legacy.exec(V20_ASYNC_EXECUTION_MIGRATION_SCHEMA);
      legacy.exec(V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA);
      legacy.exec(V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA);
      legacy.exec(V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA);
      legacy.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_version','23')").run();
      legacy.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_database_id',?)")
        .run(randomUUID());
    } finally {
      legacy.close();
    }

    try {
      const store = new BridgeStateStore({ file });
      expect(store.schemaVersion).toBe(31);
      store.close();
      const upgraded = new Database(file, { readonly: true });
      const names = (upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map((row) => row.name);
      for (const table of ["decision_cards", "decision_card_versions", "decision_card_requests", "decision_submissions"]) {
        expect(names).not.toContain(table);
      }
      expect(names).toEqual(expect.arrayContaining(["user_questions", "codex_question_deliveries"]));
      expect(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
      upgraded.close();
      expect(existsSync(`${file}.pre-v23-to-v31.sqlite`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops legacy Decision tables when upgrading schema 24 and restoring its source snapshot", () => {
    const root = mkdtempSync(path.join(tmpdir(), "operational-receipt-v24-"));
    const file = path.join(root, "state.sqlite");
    const databaseId = randomUUID();
    const legacy = new Database(file);
    try {
      legacy.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;");
      legacy.exec(CURRENT_STATE_SCHEMA);
      legacy.exec(V20_ASYNC_EXECUTION_MIGRATION_SCHEMA);
      legacy.exec(V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA);
      legacy.exec(V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA);
      legacy.exec(V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA);
      legacy.exec(V24_DECISION_CARD_MIGRATION_SCHEMA);
      const cardId = randomUUID();
      const scopeId = randomUUID();
      legacy.prepare(`INSERT INTO decision_cards
        (card_id,scope_id,current_version,created_at,updated_at,expires_at)
        VALUES (?,?,1,1,1,1)`).run(cardId, scopeId);
      legacy.prepare(`INSERT INTO decision_card_versions
        (card_id,scope_id,version,title,html,content_digest,fields,policy,presentation_ref,created_at,expires_at)
        VALUES (?,?,1,'Legacy choice','<p>Legacy</p>',?, '[]','{}',?,1,1)`)
        .run(cardId, scopeId, "a".repeat(64), "b".repeat(64));
      legacy.prepare(`INSERT INTO decision_card_requests
        (scope_id,request_id,operation_hash,card_id,version,created_at)
        VALUES (?,?,?,?,1,1)`).run(scopeId, randomUUID(), "c".repeat(64), cardId);
      legacy.prepare(`INSERT INTO decision_submissions
        (submission_id,card_id,scope_id,card_version,sequence,receipt,intent,selections,summary,decision_digest,delivery_state,created_at,updated_at)
        VALUES (?,?,?,1,1,?,'confirm','[]','Legacy choice',?,'stored',1,1)`)
        .run(randomUUID(), cardId, scopeId, "r".repeat(73), "d".repeat(64));
      legacy.prepare("INSERT INTO bridge_meta(key,value) VALUES ('schema_version','24')").run();
      legacy.prepare("INSERT INTO bridge_meta(key,value) VALUES ('state_database_id',?)")
        .run(databaseId);
    } finally {
      legacy.close();
    }

    try {
      const store = new BridgeStateStore({ file });
      expect(store.schemaVersion).toBe(31);
      expect(store.getMeta("schema_v25_operational_command_receipts"))
        .toBe("durable-command-receipts-v1");
      expect(store.getMeta("schema_v27_decision_card_retirement"))
        .toBe("legacy-tables-dropped-v1");
      store.maintainRetention();
      store.close();

      const restarted = new BridgeStateStore({ file });
      restarted.close();

      const migrated = new Database(file, { readonly: true });
      for (const table of ["decision_cards", "decision_card_versions", "decision_card_requests", "decision_submissions"]) {
        expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
          .toBeUndefined();
      }
      expect(migrated.prepare(
        "SELECT COUNT(*) AS count FROM operational_command_receipts"
      ).get()).toEqual({ count: 0 });
      expect(migrated.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
      migrated.close();
      expect(existsSync(`${file}.pre-v24-to-v31.sqlite`)).toBe(true);

      const source = new Database(`${file}.pre-v24-to-v31.sqlite`, { readonly: true });
      expect(source.prepare("SELECT COUNT(*) AS count FROM decision_submissions").get())
        .toEqual({ count: 1 });
      source.close();

      const restoredFile = path.join(root, "restored.sqlite");
      copyFileSync(`${file}.pre-v24-to-v31.sqlite`, restoredFile);
      const restored = new BridgeStateStore({ file: restoredFile });
      expect(restored.schemaVersion).toBe(31);
      restored.close();
      const backup = new Database(restoredFile, { readonly: true });
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_submissions'").get())
        .toBeUndefined();
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(backup.pragma("foreign_key_check")).toEqual([]);
      backup.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
