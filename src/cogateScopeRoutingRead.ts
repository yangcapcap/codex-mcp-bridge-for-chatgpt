import { createHash, createHmac } from "node:crypto";
import { types as utilTypes } from "node:util";
import type Database from "better-sqlite3";
import { loadSecurityHmacKeyring, SCOPE_HMAC_PURPOSE } from "./cogateLegacySecurityRead.js";
import { assertWellFormedUnicode } from "./textIntegrity.js";

export type CoGateScopeIdentity = {
  organization: string | null;
  subject: string | null;
  session: string;
};

export type CoGateScopeRoutingInspection = {
  format: "cogate-scope-routing-inspection/v1";
  schema: 21 | 31;
  activeGeneration: number;
  activeScopeId: string;
  existingCanonicalScopeId?: string;
  matches: Array<{ scopeId: string; canonicalScopeId: string; generation: number;
    basis: "current-namespace" | "retirement-snapshot" }>;
  authority: "none";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCHEMAS = new Map<string, 21 | 31>([
  ["cdebf3d1c707a0458d41cf5341a79f332fde2caf4a21d0cf60ccabd3098fe362", 21],
  ["2ced184f0b7de991be944c28fdf5219f16863ae69d645e7092b75aadd377e79a", 31]
]);

/** State-owned read model for the future Workspace adapter. This does not
 * authenticate host metadata, bind an alias, create a scope, or admit execution.
 * It deliberately works before runtime activation, on an idle read-only copy.
 * Retirement evidence permits lookup only, never signing or dispatch. */
export function inspectCoGateScopeRouting(database: Database.Database,
  suppliedIdentity: CoGateScopeIdentity): CoGateScopeRoutingInspection {
  if ((!database.readonly && !database.memory) || database.inTransaction) {
    throw new Error("CoGate scope inspection requires an idle read-only connection.");
  }
  const identity = identityData(suppliedIdentity);
  const queryOnly = database.pragma("query_only", { simple: true });
  try {
    database.pragma("query_only = ON");
    database.exec("BEGIN");
    if (database.prepare("SELECT 1 FROM temp.sqlite_master LIMIT 1").get()) {
      throw new Error("CoGate scope inspection rejects caller TEMP objects.");
    }
    const objects = database.prepare(`SELECT type,name,tbl_name AS tableName,sql
      FROM main.sqlite_master WHERE sql IS NOT NULL AND substr(name,1,7) != 'sqlite_'
      ORDER BY type,name`).all();
    const schema = SCHEMAS.get(createHash("sha256").update(JSON.stringify(objects)).digest("hex"));
    const version = database.prepare("SELECT value FROM main.bridge_meta WHERE key='schema_version'")
      .get() as { value: string } | undefined;
    if (!schema || version?.value !== String(schema)) {
      throw new Error("CoGate scope inspection requires the fixed legacy21 or unified31 schema.");
    }
    const ring = loadSecurityHmacKeyring(database, SCOPE_HMAC_PURPOSE);
    const keys = [ring.active, ...ring.retired];
    const canonical = database.prepare("SELECT scope_id FROM main.scopes WHERE scope_id=?");
    const alias = database.prepare(`SELECT canonical_scope_id,key_generation
      FROM main.scope_aliases WHERE alias_scope_id=?`);
    const evidence = database.prepare(`SELECT canonical_scope_id FROM main.scope_rotation_lookup_evidence
      WHERE key_generation=? AND lookup_scope_id=?`);
    const matches: CoGateScopeRoutingInspection["matches"] = [];
    const activeScopeId = deriveScopeId(ring.active.secret, identity);
    for (const key of keys) {
      const scopeId = deriveScopeId(key.secret, identity);
      const scope = canonical.get(scopeId) as { scope_id: string } | undefined;
      const mapped = alias.get(scopeId) as { canonical_scope_id: string; key_generation: number } | undefined;
      if (scope && mapped) throw new Error("SECURITY_SCOPE_ALIAS_COLLISION");
      const current = scope?.scope_id ?? mapped?.canonical_scope_id;
      if (mapped && mapped.key_generation !== key.generation) {
        throw new Error("SECURITY_SCOPE_ALIAS_PROVENANCE_CONFLICT");
      }
      let resolved: string | undefined;
      if (key === ring.active) {
        resolved = current;
      } else {
        // Full keyring validation above has already validated the paired
        // rotation plan, applied event, receipt counts and immutable evidence.
        const historical = evidence.get(key.generation, scopeId) as { canonical_scope_id: string } | undefined;
        if (!historical) continue; // A later-created old-key UUID is not evidence.
        resolved = historical.canonical_scope_id;
        if (current && current !== resolved) throw new Error("SECURITY_SCOPE_LOOKUP_EVIDENCE_CONFLICT");
      }
      if (resolved !== undefined) {
        if (!UUID.test(resolved) || !canonical.get(resolved)) {
          throw new Error("SECURITY_SCOPE_LOOKUP_CANONICAL_MISSING");
        }
        matches.push({ scopeId, canonicalScopeId: resolved, generation: key.generation,
          basis: key === ring.active ? "current-namespace" : "retirement-snapshot" });
      }
    }
    const targets = new Set(matches.map(match => match.canonicalScopeId));
    if (targets.size > 1) throw new Error("SECURITY_SCOPE_ROUTING_CONFLICT");
    const existingCanonicalScopeId = matches[0]?.canonicalScopeId;
    return { format: "cogate-scope-routing-inspection/v1", schema,
      activeGeneration: ring.active.generation, activeScopeId, matches,
      ...(existingCanonicalScopeId ? { existingCanonicalScopeId } : {}), authority: "none" };
  } finally {
    try { if (database.inTransaction) database.exec("ROLLBACK"); }
    finally { database.pragma(`query_only = ${queryOnly ? "ON" : "OFF"}`); }
  }
}

function identityData(value: CoGateScopeIdentity): CoGateScopeIdentity {
  if (!value || typeof value !== "object") throw new Error("Invalid CoGate scope identity.");
  // Native detection is inert even for a revoked Proxy. Descriptor reflection
  // otherwise executes caller traps before a snapshot can protect its state.
  if (utilTypes.isProxy(value)) throw new Error("CoGate scope identity rejects Proxy inputs.");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== 3) throw new Error("Invalid CoGate scope identity fields.");
  const read = (name: keyof CoGateScopeIdentity): string | null => {
    const field = fields[name];
    if (!field || !("value" in field)) throw new Error("CoGate scope identity requires data fields.");
    const input: unknown = field.value;
    if (input === null && name !== "session") return null;
    assertWellFormedUnicode(input, `CoGate scope ${name}`);
    if (!input.length || input.length > 4096) throw new Error("CoGate scope identity must be bounded and nonempty.");
    return input;
  };
  return { organization: read("organization"), subject: read("subject"), session: read("session")! };
}

function deriveScopeId(secret: Buffer, identity: CoGateScopeIdentity): string {
  // Preserve the original v1 tuple and UUIDv8 derivation across all generations.
  const digest = createHmac("sha256", secret)
    .update("codex-mcp-bridge/conversation-scope/v1\0").update(JSON.stringify(identity)).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
