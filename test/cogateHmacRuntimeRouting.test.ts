import type Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { assertCoGateUnifiedRuntimeAdmission } from "../src/cogateRuntimeAdmission.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { loadConfig } from "../src/config.js";
import { rotatedFixture } from "./helpers/cogateRotatedRoutingFixture.js";

const metadata = { "openai/organization": "org-private", "openai/subject": "subject-private", "openai/session": "session-private" };
const identity = { organization: "org-private", subject: "subject-private", session: "session-private" };
const config = () => loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1", CODEX_MCP_BRIDGE_ALLOW_WRITE: "1" });
const dbOf = (store: BridgeStateStore) => (store as unknown as { database: Database.Database }).database;
function seedSyntheticRotation(store: BridgeStateStore, options: Parameters<typeof rotatedFixture>[0] = {}) {
  const fixture = rotatedFixture(options); const db = dbOf(store);
  try {
    store.transaction(() => {
      for (const table of ["scopes", "security_key_rotation_plans", "security_hmac_keys",
        "security_key_rotation_events", "scope_rotation_lookup_evidence", "scope_aliases"]) {
        const rows = fixture.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        for (const row of rows.filter(row => table !== "security_key_rotation_events" || row.phase !== "applied")) {
          const fields = Object.keys(row);
          db.prepare(`INSERT INTO ${table}(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`).run(...Object.values(row));
        }
      }
      for (const row of fixture.db.prepare("SELECT * FROM security_key_rotation_events WHERE phase='applied'").all() as Record<string, unknown>[]) {
        const fields = Object.keys(row);
        db.prepare(`INSERT INTO security_key_rotation_events(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`).run(...Object.values(row));
      }
      for (const name of ["scope_hmac_secret_v1", "execution_policy_hmac_secret_v1", "security_key_rotation_required_v1"]) {
        store.setMeta(name, (fixture.db.prepare("SELECT value FROM bridge_meta WHERE key=?").get(name) as { value: string }).value);
      }
    });
    return { oldId: fixture.oldId, newId: fixture.newId };
  } finally { fixture.db.close(); }
}

describe("HMAC routing in the current single state owner", () => {
  test("preserves ordinary upstream generation-one metadata and opaque scope derivation", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      store.setMeta("scope_hmac_secret_v1", Buffer.alloc(32, 1).toString("base64url"));
      store.setMeta("execution_policy_hmac_secret_v1", Buffer.alloc(32, 2).toString("base64url"));
      const resolver = new ScopeResolver({ stateStore: store });
      expect(resolver.resolve(metadata)).toEqual(new ScopeResolver({ secret: Buffer.alloc(32, 1) }).resolve(metadata));
      const settings = new UserSettingsStore(config(), { stateStore: store });
      expect(settings.executionPolicyKeyGeneration).toBe(1);
      expect(store.activeSecurityHmacKey("execution-policy")).toEqual({ generation: 1, secret: Buffer.alloc(32, 2) });
      expect(store.conversationScopeRouting(identity)).toBeUndefined();
      expect(dbOf(store).prepare("SELECT COUNT(*) AS n FROM security_hmac_keys").get()).toEqual({ n: 0 });
    } finally { store.close(); }
  });
  test("routes an existing resolver through the newly observed active generation and retained namespace", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const resolver = new ScopeResolver({ stateStore: store });
      const original = resolver.resolve(metadata);
      const { oldId } = seedSyntheticRotation(store);
      const before = dbOf(store).serialize();
      expect(resolver.resolve(metadata)).toMatchObject({ scopeId: oldId, keyVersion: 2 });
      expect(resolver.keyVersion).toBe(2); expect(original?.scopeId).not.toBe(oldId);
      expect(store.conversationScopeRouting(identity)).toMatchObject({ authority: "none", schema: 31, activeGeneration: 2 });
      expect(dbOf(store).serialize()).toEqual(before);
    } finally { store.close(); }
  });
  test("does not route a post-retirement old-key UUID without its immutable snapshot", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const { oldId, newId } = seedSyntheticRotation(store, { historical: false });
      dbOf(store).prepare("INSERT INTO scopes VALUES(?,1,0,0)").run(oldId);
      expect(new ScopeResolver({ stateStore: store }).resolve(metadata)).toMatchObject({ scopeId: newId, keyVersion: 2 });
    } finally { store.close(); }
  });
  test("maps an explicit compatibility alias without granting authority or rewriting evidence", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const { oldId, newId } = seedSyntheticRotation(store, { alias: true }); const before = dbOf(store).serialize();
      const resolver = new ScopeResolver({ stateStore: store });
      expect(resolver.resolve(undefined, newId.toUpperCase())).toMatchObject({ scopeId: oldId, keyVersion: 2, source: "explicit-compatibility" });
      expect(dbOf(store).serialize()).toEqual(before);
    } finally { store.close(); }
  });
  test("refreshes policy and envelope references on the same settings instance after rotation", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const settings = new UserSettingsStore(config(), { stateStore: store });
      const old = [settings.executionPolicyRef(), settings.taskExecutionEnvelopeRef()];
      seedSyntheticRotation(store); const before = dbOf(store).serialize();
      const next = [settings.executionPolicyRef(), settings.taskExecutionEnvelopeRef()];
      expect(settings.executionPolicyKeyGeneration).toBe(2);
      expect(next[0]).not.toBe(old[0]); expect(next[1]).not.toBe(old[1]);
      expect(new UserSettingsStore(config(), { stateStore: store }).taskExecutionEnvelopeRef()).toBe(next[1]);
      expect(dbOf(store).serialize()).toEqual(before);
    } finally { store.close(); }
  });
  test.each(["required", "pending", "missing-pair", "bad-fingerprint", "schema-drift"])("rejects %s state instead of using cached secrets", problem => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const resolver = new ScopeResolver({ stateStore: store });
      const settings = new UserSettingsStore(config(), { stateStore: store });
      seedSyntheticRotation(store, { pending: problem === "pending" });
      if (problem === "required") store.setMeta("security_key_rotation_required_v1", "1");
      if (problem === "missing-pair") {
        dbOf(store).exec("DROP TRIGGER security_hmac_keys_no_delete; DELETE FROM security_hmac_keys WHERE purpose='execution-policy'");
      }
      if (problem === "bad-fingerprint") {
        // Strict table insert rejects malformed text; change its canonical legacy
        // tombstone instead, keeping a complete ring and all original triggers.
        store.setMeta("execution_policy_hmac_secret_v1", "versioned-keyring:retired-compromised:g1:" + "f".repeat(64));
      }
      if (problem === "schema-drift") dbOf(store).exec("CREATE TABLE foreign_actor(value)");
      const before = dbOf(store).serialize();
      expect(() => resolver.resolve(metadata)).toThrow();
      expect(() => resolver.resolve(undefined, "11111111-1111-4111-8111-111111111111")).toThrow();
      expect(() => settings.executionPolicyRef()).toThrow();
      expect(() => settings.taskExecutionEnvelopeRef()).toThrow();
      expect(dbOf(store).serialize()).toEqual(before);
    } finally { store.close(); }
  });
  test("does not generate fresh keys for an incomplete marker-only keyring", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      store.setMeta("security_key_rotation_required_v1", "0"); const before = dbOf(store).serialize();
      expect(() => new ScopeResolver({ stateStore: store })).toThrow("SECURITY_KEYRING_MISSING");
      expect(() => new UserSettingsStore(config(), { stateStore: store })).toThrow("SECURITY_KEYRING_MISSING");
      expect(dbOf(store).serialize()).toEqual(before);
    } finally { store.close(); }
  });
  test("rejects persisted-key overrides", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try { expect(() => new ScopeResolver({ stateStore: store, secret: Buffer.alloc(32, 9) })).toThrow("cannot override"); }
    finally { store.close(); }
  });
  test("does not expose overwriteable read-snapshot or schema helpers", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      seedSyntheticRotation(store);
      const shadow = vi.fn(() => { throw new Error("caller helper invoked"); });
      const object = store as unknown as Record<string, unknown>;
      for (const name of ["hasVersionedSecurityHmacState", "assertHmacStateSchema", "withSecurityReadSnapshot"]) object[name] = shadow;
      expect(store.activeSecurityHmacKey("execution-policy").generation).toBe(2);
      expect(store.conversationScopeRouting(identity)?.activeGeneration).toBe(2);
      expect(shadow).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
  test("rechecks a changed baseline key rather than keeping the constructor key", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      const resolver = new ScopeResolver({ stateStore: store });
      store.setMeta("scope_hmac_secret_v1", Buffer.alloc(32, 7).toString("base64url"));
      expect(resolver.resolve(metadata)).toEqual(new ScopeResolver({ secret: Buffer.alloc(32, 7) }).resolve(metadata));
    } finally { store.close(); }
  });
  test("keeps admission unavailable for nonempty CoGate state", () => {
    const store = new BridgeStateStore({ file: ":memory:" });
    try {
      seedSyntheticRotation(store);
      // The internal read integration is not an activation bypass.
      expect(() => assertCoGateUnifiedRuntimeAdmission(dbOf(store))).toThrow("COGATE_STATE_ACTIVATION_UNAVAILABLE");
    } finally { store.close(); }
  });
});
