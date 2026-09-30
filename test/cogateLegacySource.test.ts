import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import profile from "../src/cogateLegacySourceProfile.json" with { type: "json" };
import { inspectCoGateLegacySource, inspectCoGateLegacyPreservation } from "../src/cogateLegacySource.js";
import { securityKeyFingerprint } from "../src/cogateLegacySecurityRead.js";

function fixture(file = ":memory:"): Database.Database {
  const db = new Database(file);
  for (const object of profile.objects.filter(value => value.type === "table")) db.exec(object.sql);
  for (const object of profile.objects.filter(value => value.type !== "table")) db.exec(object.sql);
  meta(db, "schema_version", "21"); meta(db, "state_database_id", randomUUID());
  meta(db, "state_migration_catalog_version", "1");
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
  meta(db, "state_schema_origin", JSON.stringify({ kind: "fresh", schema: source,
    productVersion: "0.4.1", buildId: "fixture-source", recordedAt: "2026-09-13T00:00:00Z" }));
  meta(db, "state_last_migration_id", "bridge-state-20-to-21");
  meta(db, "state_last_migration_source_schema", String(source));
  meta(db, "state_last_migration_target_schema", "21");
  meta(db, "state_last_migration_completed_at", "2026-09-30T00:00:00Z");
  meta(db, "state_migration_catalog_version", "1");
}
function withFixture(action: (db: Database.Database) => void): void {
  const db = fixture(); try { action(db); } finally { db.close(); }
}

describe.each([
  { name: "source", inspect: inspectCoGateLegacySource },
  { name: "preservation", inspect: inspectCoGateLegacyPreservation }
])("CoGate $name snapshot cleanup", ({ inspect }) => {
  test.each([0, 1])("restores query-only=%i after setup and rollback failures", initial => {
    for (const phase of ["enable-after", "begin-before", "begin-after", "rollback-before", "rollback-after"]) {
      withFixture(db => {
        db.pragma(`query_only = ${initial ? "ON" : "OFF"}`);
        const before = db.serialize(); const exec = db.exec.bind(db); const pragma = db.pragma.bind(db);
        let injected = false;
        const execution = vi.spyOn(db, "exec").mockImplementation(sql => {
          if ((phase.startsWith("begin-") && sql === "BEGIN") ||
              (phase.startsWith("rollback-") && sql === "ROLLBACK")) {
            injected = true;
            if (phase.endsWith("after")) exec(sql);
            throw new Error(`injected-${phase}`);
          }
          return exec(sql);
        });
        const setting = vi.spyOn(db, "pragma").mockImplementation((sql, options) => {
          const result = pragma(sql, options);
          if (phase === "enable-after" && sql === "query_only = ON" && !injected) {
            injected = true; throw new Error(`injected-${phase}`);
          }
          return result;
        });
        try {
          expect(() => inspect(db)).toThrow(`injected-${phase}`);
          expect(injected).toBe(true);
          expect(pragma("query_only", { simple: true })).toBe(initial);
          // A failed physical rollback is surfaced to the caller; the API
          // returns no evidence and does not claim that the transaction exited.
          expect(db.inTransaction).toBe(phase === "rollback-before");
          expect(db.serialize()).toEqual(before);
        } finally {
          execution.mockRestore(); setting.mockRestore();
          if (db.inTransaction) exec("ROLLBACK");
        }
      });
    }
  });
});

describe("CoGate source preservation ledger", () => {
  test("binds all 42 retained tables without granting authority or returning secret values", () => withFixture(db => {
    meta(db, "retained_writer_unknown", '{ "outcome": "UNKNOWN", "evidence": "TOP_SECRET_MARKER" }');
    const before = db.serialize(); const ledger = inspectCoGateLegacyPreservation(db);
    expect(ledger).toMatchObject({ format: "cogate-legacy-preservation/v1", authority: "none",
      source: { authority: "none", sourceSchema: 21 }, databaseEncoding: "UTF-8" });
    expect(ledger.tables).toHaveLength(42);
    expect(ledger.tables.map(table => table.name)).toEqual(profile.objects
      .filter(object => object.type === "table").map(object => object.name));
    expect(JSON.stringify(ledger)).not.toContain("TOP_SECRET_MARKER");
    expect(JSON.stringify(ledger)).not.toContain(Buffer.alloc(32, 1).toString("base64url"));
    expect(ledger.preservationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inspectCoGateLegacyPreservation(db)).toEqual(ledger);
    expect(db.serialize()).toEqual(before); expect(db.inTransaction).toBe(false);
    expect(db.pragma("query_only", { simple: true })).toBe(0);
  }));
  test("binds original opaque JSON bytes and embedded NUL rather than decoded JSON", () => withFixture(db => {
    meta(db, "retained_writer_unknown", '{ "outcome": "UNKNOWN" }\0first');
    const first = inspectCoGateLegacyPreservation(db);
    meta(db, "retained_writer_unknown", '{ "outcome": "UNKNOWN" }\0second');
    const second = inspectCoGateLegacyPreservation(db);
    meta(db, "retained_writer_unknown", '{"outcome":"UNKNOWN"}\0second');
    const third = inspectCoGateLegacyPreservation(db);
    expect(first.preservationSha256).not.toBe(second.preservationSha256);
    expect(second.preservationSha256).not.toBe(third.preservationSha256);
    expect(first.tables.find(table => table.name === "scopes"))
      .toEqual(third.tables.find(table => table.name === "scopes"));
  }));
  test("distinguishes invalid UTF-8 text bytes that JavaScript would decode identically", () => withFixture(db => {
    const write = db.prepare("INSERT OR REPLACE INTO bridge_meta VALUES('opaque_text',CAST(? AS TEXT))");
    write.run(Buffer.from([0x80])); const first = inspectCoGateLegacyPreservation(db);
    write.run(Buffer.from([0x81])); const second = inspectCoGateLegacyPreservation(db);
    expect(first.preservationSha256).not.toBe(second.preservationSha256);
    expect(first.tables.find(table => table.name === "bridge_meta")?.contentSha256)
      .not.toBe(second.tables.find(table => table.name === "bridge_meta")?.contentSha256);
  }));
  test("preserves distinct 64-bit integers beyond JavaScript's exact-number range", () => withFixture(db => {
    db.prepare("INSERT INTO scopes VALUES('retained-scope',?,0,0)").run(9007199254740992n);
    const first = inspectCoGateLegacyPreservation(db);
    db.prepare("UPDATE scopes SET version=?").run(9007199254740993n);
    const second = inspectCoGateLegacyPreservation(db);
    expect(first.tables.find(table => table.name === "scopes")?.contentSha256)
      .not.toBe(second.tables.find(table => table.name === "scopes")?.contentSha256);
  }));
  test("retains deleted-row sequence high-water marks exactly", () => withFixture(db => {
    db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('activity_events',?)")
      .run(9007199254740993n);
    const before = db.serialize(); const ledger = inspectCoGateLegacyPreservation(db);
    expect(ledger.sequences).toContainEqual({ name: "activity_events", highWaterMark: "9007199254740993" });
    db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='activity_events'").run(9007199254740994n);
    expect(inspectCoGateLegacyPreservation(db).preservationSha256).not.toBe(ledger.preservationSha256);
    expect(before.equals(db.serialize())).toBe(false);
  }));
  test("hashes table contents independently of physical insertion order", () => {
    const first = fixture(); const second = fixture();
    try {
      for (const id of ["a", "b"]) first.prepare("INSERT INTO scopes VALUES(?,0,0,0)").run(id);
      for (const id of ["b", "a"]) second.prepare("INSERT INTO scopes VALUES(?,0,0,0)").run(id);
      expect(inspectCoGateLegacyPreservation(first).tables.find(table => table.name === "scopes"))
        .toEqual(inspectCoGateLegacyPreservation(second).tables.find(table => table.name === "scopes"));
    } finally { first.close(); second.close(); }
  });
  test.each(["non-integer", "negative", "unknown-table", "duplicate"])(
    "rejects ambiguous sequence evidence without rewriting it: %s", kind => withFixture(db => {
      const name = kind === "unknown-table" ? "TOP_SECRET_UNKNOWN_TABLE" : "activity_events";
      const value = kind === "non-integer" ? "corrupt" : kind === "negative" ? -1 : 1;
      db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)").run(name, value);
      if (kind === "duplicate") db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES(?,1)").run(name);
      const before = db.serialize();
      expect(() => inspectCoGateLegacyPreservation(db)).toThrow(/malformed sequence/);
      expect(db.serialize()).toEqual(before); expect(db.inTransaction).toBe(false);
      expect(db.pragma("query_only", { simple: true })).toBe(0);
    })
  );
  test("restores an existing query-only setting and rejects unauthenticated source before hashing", () => withFixture(db => {
    db.pragma("query_only = ON"); inspectCoGateLegacyPreservation(db);
    expect(db.pragma("query_only", { simple: true })).toBe(1); expect(db.inTransaction).toBe(false);
    db.pragma("query_only = OFF"); db.exec("DROP TRIGGER security_hmac_keys_no_delete");
    const before = db.serialize(); expect(() => inspectCoGateLegacyPreservation(db)).toThrow(/schema objects/);
    expect(db.serialize()).toEqual(before); expect(db.inTransaction).toBe(false);
  }));
});

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
  test("rejects orphan completed identity on a fresh source", () => withFixture(db => {
    meta(db, "state_last_migration_source_schema", "999"); meta(db, "state_last_migration_target_schema", "30");
    meta(db, "state_last_migration_completed_at", "not-a-date"); const before = db.serialize();
    expect(() => inspectCoGateLegacySource(db)).toThrow(/authenticated current fresh/);
    expect(db.serialize()).toEqual(before);
  }));
  test("rejects a conflicting catalog even with a valid fresh origin", () => withFixture(db => {
    meta(db, "state_migration_catalog_version", "2");
    expect(() => inspectCoGateLegacySource(db)).toThrow(/catalog identity/);
  }));
  test.each(["not-json", JSON.stringify({ kind: "fresh", schema: 30,
    productVersion: "0.4.1", buildId: "fixture-source", recordedAt: "2026-09-30T00:00:00Z" })])(
    "rejects present corrupt or foreign origin on a completed source: %s", value => withFixture(db => {
      receipt(db, 20); completed(db, 20); meta(db, "state_schema_origin", value);
      const before = db.serialize(); expect(() => inspectCoGateLegacySource(db)).toThrow();
      expect(db.serialize()).toEqual(before);
    }));
  test("rejects a valid but contradictory fresh21 origin on a source20 completed path", () => withFixture(db => {
    receipt(db, 20); completed(db, 20); meta(db, "state_schema_origin", JSON.stringify({ kind: "fresh", schema: 21,
      productVersion: "0.4.1", buildId: "fixture-source", recordedAt: "2026-09-30T00:00:00Z" }));
    expect(() => inspectCoGateLegacySource(db)).toThrow(/fresh origin conflicts/);
  }));
  test("retains a missing pre-contract origin on a fully authenticated completed path", () => withFixture(db => {
    receipt(db, 20); completed(db, 20); db.prepare("DELETE FROM bridge_meta WHERE key='state_schema_origin'").run();
    const before = db.serialize(); expect(inspectCoGateLegacySource(db).appliedReceiptCount).toBe(1);
    expect(db.serialize()).toEqual(before);
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key='state_schema_origin'").get()).toBeUndefined();
  }));
  test("rejects extra receipt authority fields and preserves the rejected raw record", () => withFixture(db => {
    receipt(db, 20); completed(db, 20); const key = "state_migration:bridge-state-20-to-21";
    const value = JSON.parse((db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string }).value);
    value.authority = "approved"; const raw = JSON.stringify(value); meta(db, key, raw);
    expect(() => inspectCoGateLegacySource(db)).toThrow(/conflicting retained/);
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key)).toEqual({ value: raw });
  }));
  test("rejects uncontracted origin and gap extensions without deleting them", () => withFixture(db => {
    const origin = { kind: "fresh", schema: 21, productVersion: "0.4.1", buildId: "fixture-source",
      recordedAt: "2026-09-30T00:00:00Z", authority: "approved" };
    meta(db, "state_schema_origin", JSON.stringify(origin));
    expect(() => inspectCoGateLegacySource(db)).toThrow(/schema-origin/);
    receipt(db, 20, 19); completed(db, 19);
    const gap = JSON.stringify({ kind: "pre-contract-intermediate-checkpoint", originalSourceSchema: 19,
      observedSchema: 20, recordedAt: "2026-09-30T00:00:00Z", authority: "approved" });
    meta(db, "state_migration_provenance_gap", gap);
    expect(() => inspectCoGateLegacySource(db)).toThrow(/provenance-gap/);
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key='state_migration_provenance_gap'").get()).toEqual({ value: gap });
  }));
  test.each(["\"schema\":30,\"schema\":21", "\"schema\":21,\"schema\":21",
    "\"schema\":30,\"\\u0073chema\":21"])("rejects duplicate decoded origin members: %s", fields => withFixture(db => {
    expect(inspectCoGateLegacySource(db).authority).toBe("none");
    const key = "state_schema_origin";
    const raw = (db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string }).value
      .replace('"schema":21', fields);
    meta(db, key, raw); const before = db.serialize();
    expect(() => inspectCoGateLegacySource(db)).toThrow(/duplicate root members/);
    expect(db.serialize()).toEqual(before);
  }));
  test("rejects a conflicting duplicate retained receipt after its valid baseline passes", () => withFixture(db => {
    receipt(db, 20); completed(db, 20); expect(inspectCoGateLegacySource(db).appliedReceiptCount).toBe(1);
    const key = "state_migration:bridge-state-20-to-21";
    const raw = (db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as { value: string }).value
      .replace('"originalSourceSchema":20', '"originalSourceSchema":999,"originalSourceSchema":20');
    meta(db, key, raw); expect(() => inspectCoGateLegacySource(db)).toThrow(/duplicate root members/);
    expect(db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key)).toEqual({ value: raw });
  }));
  test("rejects duplicate gap evidence while preserving the valid original path", () => withFixture(db => {
    receipt(db, 20, 19); completed(db, 19);
    const raw = JSON.stringify({ kind: "pre-contract-intermediate-checkpoint", originalSourceSchema: 19,
      observedSchema: 20, recordedAt: "2026-09-30T00:00:00Z" });
    meta(db, "state_migration_provenance_gap", raw); expect(inspectCoGateLegacySource(db).historicalGapRetained).toBe(true);
    const changed = raw.replace('"observedSchema":20', '"observedSchema":30,"observedSchema":20');
    meta(db, "state_migration_provenance_gap", changed);
    expect(() => inspectCoGateLegacySource(db)).toThrow(/duplicate root members/);
  }));
  test("accepts escaped quotes and structural punctuation inside valid scalar strings", () => withFixture(db => {
    meta(db, "state_schema_origin", JSON.stringify({ kind: "fresh", schema: 21, productVersion: "0.4.1",
      buildId: 'source "schema":30}, ["schema"], backslash\\', recordedAt: "2026-09-30T00:00:00Z" }));
    expect(inspectCoGateLegacySource(db).authority).toBe("none");
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
