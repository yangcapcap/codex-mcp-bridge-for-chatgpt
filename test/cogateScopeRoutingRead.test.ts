import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { inspectCoGateScopeRouting, type CoGateScopeIdentity } from "../src/cogateScopeRoutingRead.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { securityKeyFingerprint, type SecurityHmacPurpose } from "../src/cogateLegacySecurityRead.js";
import { legacyFixture, legacyMeta, projectionFixture } from "./helpers/cogateProjectionFixtures.js";

const identity: CoGateScopeIdentity = { organization: "org-private", subject: "subject-private", session: "session-private" };
function scope(secret: Buffer, value = identity): string {
  return new ScopeResolver({ secret }).require({ ...(value.organization === null ? {} : { "openai/organization": value.organization }),
    ...(value.subject === null ? {} : { "openai/subject": value.subject }), "openai/session": value.session }, undefined, "fixture").scopeId;
}
function addScope(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO scopes VALUES(?,1,0,0)").run(id);
}

// Synthetic, isolated state only. No runtime rotation implementation or authority
// is imported. These arbitrary fixture digests do not approve a real transition.
function rotatedFixture(options: { historical?: boolean; alias?: boolean; pending?: boolean } = {}) {
  const db = legacyFixture(); const rotationId = randomUUID(); const digest = "a".repeat(64);
  const oldId = scope(Buffer.alloc(32, 1)); const newId = scope(Buffer.alloc(32, 3));
  const historical = options.historical ?? true;
  if (historical) addScope(db, oldId);
  db.prepare("INSERT INTO security_key_rotation_plans VALUES(?,1,2,1,2,1,?,?,?,'fixture',1)")
    .run(rotationId, digest, digest, digest);
  const fingerprints: Record<string, string> = {};
  for (const [index, purpose] of (["scope", "execution-policy"] as const).entries()) {
    const oldKey = Buffer.alloc(32, index + 1); const newKey = Buffer.alloc(32, index + 3);
    const field = purpose === "scope" ? "Scope" : "Execution";
    fingerprints[`old${field}`] = securityKeyFingerprint(purpose, oldKey);
    fingerprints[`new${field}`] = securityKeyFingerprint(purpose, newKey);
    db.prepare("INSERT INTO security_hmac_keys VALUES(?,2,'pending','reject',?,?,?,1,NULL)")
      .run(purpose, newKey.toString("base64url"), fingerprints[`new${field}`], rotationId);
  }
  const receipt = { kind: "security-key-rotation", rotationId, phase: "prepared",
    source: { scopeGeneration: 1, executionGeneration: 1 }, target: { scopeGeneration: 2, executionGeneration: 2 },
    fingerprints, affected: { scopes: historical ? 1 : 0, aliases: 0, activities: 0, jobs: 0, sessions: 0,
      conversationLinks: 0, scopeLookupEvidence: historical ? 1 : 0, pendingProjectAuthorizations: 0 },
    schemaIdentity: { before: digest, after: digest }, migrationDigest: digest,
    controlRevision: { before: 1, after: 1 }, buildId: "fixture" };
  const event = (phase: string, payload: object, now: number) => db.prepare(`INSERT INTO security_key_rotation_events
    (rotation_id,attempt_id,phase,reason_code,payload,created_at) VALUES(?,?,?,NULL,?,?)`)
    .run(rotationId, randomUUID(), phase, JSON.stringify(payload), now);
  event("prepared", receipt, 1);
  if (!options.pending) {
    event("applying", {}, 2);
    if (historical) db.prepare("INSERT INTO scope_rotation_lookup_evidence VALUES(1,?,?,?,3)")
      .run(oldId, oldId, rotationId);
    for (const purpose of ["scope", "execution-policy"] as SecurityHmacPurpose[]) {
      db.prepare("UPDATE security_hmac_keys SET status='retired',verification_mode=?,retired_at=3 WHERE purpose=? AND generation=1")
        .run(purpose === "scope" ? "scope-lookup-only" : "reject", purpose);
      db.prepare("UPDATE security_hmac_keys SET status='active',verification_mode='sign-and-verify' WHERE purpose=? AND generation=2").run(purpose);
      legacyMeta(db, `${purpose === "scope" ? "scope" : "execution_policy"}_hmac_secret_v1`,
        `versioned-keyring:retired-compromised:g1:${fingerprints[purpose === "scope" ? "oldScope" : "oldExecution"]}`);
    }
    event("applied", { ...receipt, phase: "applied", controlRevision: { before: 1, after: 2 } }, 3);
    if (options.alias) db.prepare("INSERT INTO scope_aliases VALUES(?,?,2,?,4)").run(newId, oldId, rotationId);
  }
  return { db, oldId, newId, rotationId };
}

describe("CoGate state-owned scope routing read model", () => {
  test("preserves original host tuple derivation without returning identifiers or secrets", () => {
    const db = legacyFixture(); try {
      const before = db.serialize(); const result = inspectCoGateScopeRouting(db, identity);
      expect(result).toEqual({ format: "cogate-scope-routing-inspection/v1", schema: 21,
        activeGeneration: 1, activeScopeId: scope(Buffer.alloc(32, 1)), matches: [], authority: "none" });
      for (const secret of [identity.session, identity.subject!, identity.organization!, Buffer.alloc(32, 1).toString("base64url")])
        expect(JSON.stringify(result)).not.toContain(secret);
      expect(db.serialize()).toEqual(before); expect(db.inTransaction).toBe(false);
      expect(db.pragma("query_only", { simple: true })).toBe(0);
    } finally { db.close(); }
  });
  test("reads an existing current canonical namespace without creating one", () => {
    const db = legacyFixture(); try {
      const id = scope(Buffer.alloc(32, 1)); addScope(db, id); const before = db.serialize();
      expect(inspectCoGateScopeRouting(db, identity)).toMatchObject({ existingCanonicalScopeId: id,
        matches: [{ generation: 1, basis: "current-namespace" }] });
      expect(db.serialize()).toEqual(before);
    } finally { db.close(); }
  });
  test("preserves null host tuple fields and does not normalize Unicode or whitespace", () => {
    const db = legacyFixture(); try {
      for (const session of ["café", "cafe\u0301", " spaced ", "汉字\0identity"]) {
        const input = { organization: null, subject: null, session };
        expect(inspectCoGateScopeRouting(db, input).activeScopeId).toBe(scope(Buffer.alloc(32, 1), input));
      }
      expect(inspectCoGateScopeRouting(db, { ...identity, session: "café" }).activeScopeId)
        .not.toBe(inspectCoGateScopeRouting(db, { ...identity, session: "cafe\u0301" }).activeScopeId);
    } finally { db.close(); }
  });
  test.each([false, true])("routes retired lookup evidence with current alias=%s", alias => {
    const { db, oldId, newId } = rotatedFixture({ alias }); try {
      const before = db.serialize(); const result = inspectCoGateScopeRouting(db, identity);
      expect(result).toMatchObject({ activeGeneration: 2, activeScopeId: newId, existingCanonicalScopeId: oldId, authority: "none" });
      expect(result.matches.some(match => match.generation === 1 && match.basis === "retirement-snapshot")).toBe(true);
      expect(result.matches).toHaveLength(alias ? 2 : 1); expect(db.serialize()).toEqual(before);
    } finally { db.close(); }
  });
  test("ignores a UUID created after its derivation key retired", () => {
    const { db, oldId, newId } = rotatedFixture({ historical: false }); try {
      addScope(db, oldId); const result = inspectCoGateScopeRouting(db, identity);
      expect(result.activeScopeId).toBe(newId); expect(result.matches).toEqual([]);
      expect(result).not.toHaveProperty("existingCanonicalScopeId");
    } finally { db.close(); }
  });
  test("rejects divergent canonical scopes instead of preferring the current generation", () => {
    const { db, newId } = rotatedFixture(); try {
      addScope(db, newId); expect(() => inspectCoGateScopeRouting(db, identity)).toThrow("SECURITY_SCOPE_ROUTING_CONFLICT");
    } finally { db.close(); }
  });
  test("rejects a dangling historical canonical scope", () => {
    const { db, oldId } = rotatedFixture(); try {
      db.prepare("DELETE FROM scopes WHERE scope_id=?").run(oldId);
      expect(() => inspectCoGateScopeRouting(db, identity)).toThrow("SECURITY_SCOPE_LOOKUP_CANONICAL_MISSING");
    } finally { db.close(); }
  });
  test("rejects pending rotation and does not expose pending key derivations", () => {
    const { db } = rotatedFixture({ pending: true }); try {
      expect(() => inspectCoGateScopeRouting(db, identity)).toThrow("SECURITY_KEY_ROTATION_IN_PROGRESS");
    } finally { db.close(); }
  });
  test("rejects rotation-required state", () => {
    const db = legacyFixture(); try {
      legacyMeta(db, "security_key_rotation_required_v1", "1");
      expect(() => inspectCoGateScopeRouting(db, identity)).toThrow("SECURITY_KEY_ROTATION_REQUIRED");
    } finally { db.close(); }
  });
  test("reads the unified storage copy without granting runtime activation", () => {
    const fixture = projectionFixture({ initialized: true }); const { target } = fixture; try {
      expect(inspectCoGateScopeRouting(target, identity)).toMatchObject({ schema: 31, activeGeneration: 1, authority: "none" });
    } finally { fixture.close(); }
  });
  test.each(["schema", "temp", "version"])('rejects %s drift', kind => {
    const db = legacyFixture(); try {
      if (kind === "schema") db.exec("CREATE TABLE arbitrary(value)");
      if (kind === "temp") db.exec("CREATE TEMP TABLE scopes(scope_id)");
      if (kind === "version") legacyMeta(db, "schema_version", "31");
      expect(() => inspectCoGateScopeRouting(db, identity)).toThrow(/fixed legacy21|TEMP/);
      expect(db.inTransaction).toBe(false); expect(db.pragma("query_only", { simple: true })).toBe(0);
    } finally { db.close(); }
  });
  test("rejects caller-owned transactions before changing their state", () => {
    const db = legacyFixture(); try {
      db.exec("BEGIN"); expect(() => inspectCoGateScopeRouting(db, identity)).toThrow("idle read-only");
      expect(db.inTransaction).toBe(true); expect(db.pragma("query_only", { simple: true })).toBe(0);
    } finally { db.close(); }
  });
  test("rejects writable files but permits an idle readonly file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "scope-read-")); const file = path.join(dir, "state.sqlite");
    const writable = legacyFixture(file); try {
      const pragma = vi.spyOn(writable, "pragma");
      expect(() => inspectCoGateScopeRouting(writable, identity)).toThrow("idle read-only"); expect(pragma).not.toHaveBeenCalled();
    } finally { writable.close(); }
    const readonly = new Database(file, { readonly: true, fileMustExist: true }); try {
      expect(inspectCoGateScopeRouting(readonly, identity)).toMatchObject({ schema: 21, authority: "none" });
    } finally { readonly.close(); rmSync(dir, { recursive: true }); }
  });
  test.each([0, 1])("restores query-only=%s after a keyring failure", initial => {
    const db = legacyFixture(); try {
      legacyMeta(db, "scope_hmac_secret_v1", "bad"); db.pragma(`query_only=${initial}`);
      expect(() => inspectCoGateScopeRouting(db, identity)).toThrow();
      expect(db.pragma("query_only", { simple: true })).toBe(initial); expect(db.inTransaction).toBe(false);
    } finally { db.close(); }
  });
  test.each(["enable-after", "begin-before", "begin-after", "rollback-before", "rollback-after"])("surfaces %s snapshot failures without returning a route", phase => {
    const db = legacyFixture(); const pragma = db.pragma.bind(db); const exec = db.exec.bind(db);
    const before = db.serialize(); let injected = false;
    const execution = vi.spyOn(db, "exec").mockImplementation(sql => {
      if ((phase.startsWith("begin-") && sql === "BEGIN") || (phase.startsWith("rollback-") && sql === "ROLLBACK")) {
        injected = true; if (phase.endsWith("after")) exec(sql); throw new Error(`injected-${phase}`);
      }
      return exec(sql);
    });
    const setting = vi.spyOn(db, "pragma").mockImplementation((sql, options) => {
      const result = pragma(sql, options);
      if (phase === "enable-after" && sql === "query_only = ON" && !injected) { injected = true; throw new Error(`injected-${phase}`); }
      return result;
    });
    try {
      expect(() => inspectCoGateScopeRouting(db, identity)).toThrow(`injected-${phase}`);
      expect(injected).toBe(true); expect(pragma("query_only", { simple: true })).toBe(0);
      expect(db.inTransaction).toBe(phase === "rollback-before"); expect(db.serialize()).toEqual(before);
    } finally {
      execution.mockRestore(); setting.mockRestore(); if (db.inTransaction) exec("ROLLBACK"); db.close();
    }
  });
  test("requires the paired execution-policy keyring even for scope lookup", () => {
    const db = legacyFixture(); try {
      legacyMeta(db, "execution_policy_hmac_secret_v1", "invalid-key");
      expect(() => inspectCoGateScopeRouting(db, identity)).toThrow();
    } finally { db.close(); }
  });
  test.each(["surrogate", "empty", "long", "getter", "extra", "missing"])('rejects %s identity without metadata getters', kind => {
    const db = legacyFixture(); let getterCalls = 0; const bad = { ...identity };
    if (kind === "surrogate") bad.session = "\ud800";
    if (kind === "empty") bad.session = "";
    if (kind === "long") bad.session = "s".repeat(4097);
    if (kind === "getter") Object.defineProperty(bad, "session", { get() { getterCalls++; return "bad"; } });
    if (kind === "extra") Object.assign(bad, { unexpected: true });
    if (kind === "missing") Reflect.deleteProperty(bad, "subject");
    try { expect(() => inspectCoGateScopeRouting(db, bad)).toThrow(); expect(getterCalls).toBe(0); }
    finally { db.close(); }
  });
});
