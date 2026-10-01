import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ScopeResolver } from "../../src/scopeResolver.js";
import { securityKeyFingerprint, type SecurityHmacPurpose } from "../../src/cogateLegacySecurityRead.js";
import { legacyFixture, legacyMeta } from "./cogateProjectionFixtures.js";
const identity = { organization: "org-private", subject: "subject-private", session: "session-private" };
function scope(secret: Buffer): string {
  return new ScopeResolver({ secret }).require({ "openai/organization": identity.organization,
    "openai/subject": identity.subject, "openai/session": identity.session }, undefined, "fixture").scopeId;
}
function addScope(db: Database.Database, id: string): void { db.prepare("INSERT INTO scopes VALUES(?,1,0,0)").run(id); }
// Synthetic memory state only. No runtime rotation, conversion or review grant.
export function rotatedFixture(options: { historical?: boolean; alias?: boolean; pending?: boolean } = {}) {
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
