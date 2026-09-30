import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import profile from "../src/cogateLegacySourceProfile.json" with { type: "json" };
import { inspectCoGateLegacySource } from "../src/cogateLegacySource.js";
import { securityKeyFingerprint } from "../src/cogateLegacySecurityRead.js";

function fixture(file = ":memory:"): Database.Database {
  const db = new Database(file);
  for (const object of profile.objects.filter(value => value.type === "table")) db.exec(object.sql);
  for (const object of profile.objects.filter(value => value.type !== "table")) db.exec(object.sql);
  meta(db, "schema_version", "21"); meta(db, "state_database_id", randomUUID());
  meta(db, "state_schema_origin", JSON.stringify({ kind: "fresh", schema: 21,
    productVersion: "0.4.1", buildId: "fixture-source", recordedAt: "2026-09-30T00:00:00Z" }));
  meta(db, "security_key_rotation_required_v1", "0");
  db.prepare("INSERT INTO workspace_control VALUES(1,'disabled',1,0,0)").run();
  for (const [index, purpose] of (["scope", "execution-policy"] as const).entries()) {
    const secret = Buffer.alloc(32, index + 1); const encoded = secret.toString("base64url");
    meta(db, `${purpose === "scope" ? "scope" : "execution_policy"}_hmac_secret_v1`, encoded);
    db.prepare(`INSERT INTO security_hmac_keys VALUES(?,1,'active','sign-and-verify',?,?,NULL,0,NULL)`)
      .run(purpose, encoded, securityKeyFingerprint(purpose, secret));
  }
  return db;
}
function meta(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO bridge_meta(key,value) VALUES(?,?)").run(key, value);
}
function receipt(db: Database.Database, from: number, original = from): void {
  const entry = profile.migrations.find(value => value.fromSchema === from)!;
  meta(db, `state_migration:${entry.id}`, JSON.stringify({ id: entry.id, fromSchema: entry.fromSchema,
    toSchema: entry.toSchema, implementationSha256: entry.sha256, originalSourceSchema: original,
    productVersion: "0.4.1", buildId: "fixture-source", appliedAt: "2026-09-30T00:00:00Z" }));
}
function completed(db: Database.Database, source: number): void {
  meta(db, "state_last_migration_id", "bridge-state-20-to-21");
  meta(db, "state_last_migration_source_schema", String(source));
  meta(db, "state_last_migration_target_schema", "21");
  meta(db, "state_last_migration_completed_at", "2026-09-30T00:00:00Z");
  meta(db, "state_migration_catalog_version", "1");
}
function withFixture(action: (db: Database.Database) => void): void {
  const db = fixture(); try { action(db); } finally { db.close(); }
}

describe("fixed CoGate legacy source inspection", () => {
  test("authenticates a fresh source without issuing authority or returning HMAC material", () => withFixture(db => {
    const before = db.serialize(); const result = inspectCoGateLegacySource(db);
    expect(result).toMatchObject({ sourceSchema: 21, appliedReceiptCount: 0, authority: "none",
      historicalGapRetained: false, activeInstanceCount: 0, nonterminalJobCount: 0,
      security: { scopeGeneration: 1, executionGeneration: 1, rotationRequired: false, pendingRotation: false } });
    expect(JSON.stringify(result)).not.toMatch(/secret|key_material|fingerprint|AQEBAQ/);
    expect(db.serialize()).toEqual(before); expect(db.inTransaction).toBe(false);
    expect(db.pragma("query_only", { simple: true })).toBe(0);
  }));
  test("supports separate completed source generations without rewriting old receipts", () => withFixture(db => {
    receipt(db, 19); receipt(db, 20); completed(db, 20);
    meta(db, "state_schema_origin", JSON.stringify({ kind: "fresh", schema: 19,
      productVersion: "0.4.1", buildId: "fixture-source", recordedAt: "2026-09-13T00:00:00Z" }));
    const before = db.serialize(); expect(inspectCoGateLegacySource(db).appliedReceiptCount).toBe(2);
    expect(db.serialize()).toEqual(before);
  }));
  test("retains a genuine source19 gap and does not convert it into applied proof", () => withFixture(db => {
    receipt(db, 20, 19); completed(db, 19);
    const raw = JSON.stringify({ kind: "pre-contract-intermediate-checkpoint", originalSourceSchema: 19,
      observedSchema: 20, recordedAt: "2026-09-30T00:00:00Z" });
    meta(db, "state_migration_provenance_gap", raw);
    expect(inspectCoGateLegacySource(db)).toMatchObject({ historicalGapRetained: true, appliedReceiptCount: 1 });
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key='state_migration_provenance_gap'").get()).toEqual({ value: raw });
  }));
  test("rejects numeric schema21 with upstream or altered DDL", () => withFixture(db => {
    db.exec("ALTER TABLE sessions ADD COLUMN auth_boundary TEXT");
    const before = db.serialize(); expect(() => inspectCoGateLegacySource(db)).toThrow(/schema objects/);
    expect(db.serialize()).toEqual(before);
  }));
  test("rejects a changed HMAC immutability trigger", () => withFixture(db => {
    db.exec("DROP TRIGGER security_hmac_keys_no_delete");
    expect(() => inspectCoGateLegacySource(db)).toThrow(/schema objects/);
  }));
  test("rejects a target-lineage receipt under the colliding migration ID", () => withFixture(db => {
    receipt(db, 20); completed(db, 20);
    const key = "state_migration:bridge-state-20-to-21";
    const record = JSON.parse((db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string }).value);
    record.implementationSha256 = "779549234164d275635d5a5d5a3b2aa0df07dc0981035636795d110e5dd5b48a";
    meta(db, key, JSON.stringify(record));
    const before = db.serialize(); expect(() => inspectCoGateLegacySource(db)).toThrow(/conflicting retained/);
    expect(db.serialize()).toEqual(before);
  }));
  test("rejects a missing preceding receipt in a retained generation", () => withFixture(db => {
    receipt(db, 20, 19); completed(db, 19);
    expect(() => inspectCoGateLegacySource(db)).toThrow(/missing or conflicting/);
  }));
  test("rejects a malformed old receipt even when the current completed generation is valid", () => withFixture(db => {
    receipt(db, 19); receipt(db, 20); completed(db, 20);
    const key = "state_migration:bridge-state-19-to-20";
    const row = JSON.parse((db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string }).value);
    row.originalSourceSchema = "19"; meta(db, key, JSON.stringify(row));
    expect(() => inspectCoGateLegacySource(db)).toThrow(/conflicting retained/);
  }));
  test("rejects an unfinished source migration without recovery writes", () => withFixture(db => {
    meta(db, "state_migration_pending", "{}"); const before = db.serialize();
    expect(() => inspectCoGateLegacySource(db)).toThrow(/unfinished migration/);
    expect(db.serialize()).toEqual(before);
  }));
  test("rejects invalid HMAC fingerprints without exposing key material", () => withFixture(db => {
    db.exec("DROP TRIGGER security_hmac_keys_guard_update");
    // Recreate exactly the pinned DDL after preparing a corrupt fixture row.
    db.prepare("UPDATE security_hmac_keys SET fingerprint=? WHERE purpose='scope'").run("a".repeat(64));
    db.exec(profile.objects.find(value => value.name === "security_hmac_keys_guard_update")!.sql);
    expect(() => inspectCoGateLegacySource(db)).toThrow(/^SECURITY_/);
  }));
  test("reports live source ownership and retained workspaces without granting conversion readiness", () => withFixture(db => {
    db.prepare(`INSERT INTO bridge_instances VALUES('fixture-owner',0,NULL,NULL,12345,'{}')`).run();
    db.prepare("UPDATE workspace_control SET mode='enabled',revision=13,maintenance=0").run();
    expect(inspectCoGateLegacySource(db)).toMatchObject({ activeInstanceCount: 1, authority: "none",
      workspaceControl: { mode: "enabled", revision: 13, maintenance: false } });
  }));
  test("rejects file-backed writable and nested connections; accepts a private read-only source", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "legacy-source-")); const file = path.join(root, "state.sqlite");
    try {
      const writable = fixture(file);
      try { expect(() => inspectCoGateLegacySource(writable)).toThrow(/idle read-only/); } finally { writable.close(); }
      const readonly = new Database(file, { readonly: true, fileMustExist: true });
      try {
        expect(inspectCoGateLegacySource(readonly).authority).toBe("none");
        readonly.exec("BEGIN"); expect(() => inspectCoGateLegacySource(readonly)).toThrow(/idle read-only/);
        readonly.exec("ROLLBACK");
      } finally { readonly.close(); }
    } finally { rmSync(root, { recursive: true }); }
  });
});
