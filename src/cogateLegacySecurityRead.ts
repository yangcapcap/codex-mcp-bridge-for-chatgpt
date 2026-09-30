/** Read-only legacy HMAC validation, exact declaration bodies from CoGate source
 * 128932cd9099e167da4fb588cb8a340903342426. No rotation writer is carried. */
import { createHash } from "node:crypto";

import type Database from "better-sqlite3";


export const SCOPE_HMAC_PURPOSE = "scope" as const;

export const EXECUTION_POLICY_HMAC_PURPOSE = "execution-policy" as const;

export type SecurityHmacPurpose =
  | typeof SCOPE_HMAC_PURPOSE
  | typeof EXECUTION_POLICY_HMAC_PURPOSE;


export const SCOPE_SECRET_META_KEY = "scope_hmac_secret_v1";

export const EXECUTION_POLICY_SECRET_META_KEY = "execution_policy_hmac_secret_v1";

export const SECURITY_ROTATION_REQUIRED_META_KEY = "security_key_rotation_required_v1";

const LEGACY_META_TOMBSTONE_PREFIX = "versioned-keyring:retired-compromised:g1:";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;


export type SecurityHmacKey = {
  purpose: SecurityHmacPurpose;
  generation: number;
  status: "active" | "pending" | "retired";
  verificationMode: "sign-and-verify" | "scope-lookup-only" | "reject";
  secret: Buffer;
  fingerprint: string;
  rotationId?: string;
  createdAt: number;
  retiredAt?: number;
};


export type SecurityHmacKeyring = {
  active: SecurityHmacKey;
  retired: SecurityHmacKey[];
  pending?: SecurityHmacKey;
};


export type SecurityRotationReceipt = {
  kind: "security-key-rotation";
  rotationId: string;
  phase: "prepared" | "applied";
  source: { scopeGeneration: number; executionGeneration: number };
  target: { scopeGeneration: number; executionGeneration: number };
  fingerprints: {
    oldScope: string;
    newScope: string;
    oldExecution: string;
    newExecution: string;
  };
  affected: {
    scopes: number;
    aliases: number;
    activities: number;
    jobs: number;
    sessions: number;
    conversationLinks: number;
    scopeLookupEvidence: number;
    pendingProjectAuthorizations: number;
  };
  schemaIdentity: { before: string; after: string };
  migrationDigest: string;
  controlRevision: { before: number; after: number };
  buildId: string;
};


type KeyRow = {
  purpose: string;
  generation: number;
  status: string;
  verification_mode: string;
  key_material: string;
  fingerprint: string;
  rotation_id: string | null;
  created_at: number;
  retired_at: number | null;
};


type RotationPlanRow = {
  rotation_id: string;
  source_scope_generation: number;
  target_scope_generation: number;
  source_execution_generation: number;
  target_execution_generation: number;
  control_revision: number;
  before_schema_identity: string;
  before_data_identity: string;
  migration_digest: string;
  build_id: string;
  created_at: number;
};


export function loadSecurityHmacKeyring(
  database: Database.Database,
  purpose: SecurityHmacPurpose,
  options: { allowRotationRequired?: boolean; allowPendingRotation?: boolean } = {}
): SecurityHmacKeyring {
  const marker = readMeta(database, SECURITY_ROTATION_REQUIRED_META_KEY);
  if (marker !== "0" && marker !== "1") {
    throw rotationError("SECURITY_KEY_ROTATION_MARKER_INVALID");
  }
  if (!options.allowRotationRequired && marker === "1") {
    throw rotationError("SECURITY_KEY_ROTATION_REQUIRED");
  }
  const ring = loadValidatedSecurityKeyrings(database)[purpose];
  if (ring.pending && !options.allowPendingRotation) {
    throw rotationError("SECURITY_KEY_ROTATION_IN_PROGRESS");
  }
  return ring;
}


type SecurityKeyringsByPurpose = Record<SecurityHmacPurpose, SecurityHmacKeyring>;


function loadValidatedSecurityKeyrings(database: Database.Database): SecurityKeyringsByPurpose {
  const result = {} as SecurityKeyringsByPurpose;
  for (const purpose of [SCOPE_HMAC_PURPOSE, EXECUTION_POLICY_HMAC_PURPOSE] as const) {
    const rows = database.prepare(
      "SELECT * FROM security_hmac_keys WHERE purpose=? ORDER BY generation"
    ).all(purpose) as KeyRow[];
    if (!rows.length) throw rotationError("SECURITY_KEYRING_MISSING");
    const decoded = rows.map((row) => decodeKeyRow(row, purpose));
    if (decoded.some((key, index) => key.generation !== index + 1)) {
      throw rotationError("SECURITY_KEYRING_GENERATION_SEQUENCE_INVALID");
    }
    const active = decoded.filter((key) => key.status === "active");
    const pending = decoded.filter((key) => key.status === "pending");
    if (active.length !== 1 || pending.length > 1) {
      throw rotationError("SECURITY_KEYRING_ACTIVE_STATE_INVALID");
    }
    const activeKey = active[0]!;
    for (const key of decoded) {
      const expectedStatus = key.generation < activeKey.generation
        ? "retired"
        : key.generation === activeKey.generation
          ? "active"
          : key.generation === activeKey.generation + 1 && pending[0] === key
            ? "pending"
            : undefined;
      if (key.status !== expectedStatus) {
        throw rotationError("SECURITY_KEYRING_GENERATION_STATE_INVALID");
      }
      if (key.generation === 1 ? key.rotationId !== undefined : key.rotationId === undefined) {
        throw rotationError("SECURITY_KEYRING_ROTATION_PROVENANCE_INVALID");
      }
      if (key.status === "retired") {
        const expectedMode = purpose === SCOPE_HMAC_PURPOSE ? "scope-lookup-only" : "reject";
        if (
          key.verificationMode !== expectedMode ||
          key.retiredAt === undefined ||
          key.retiredAt < key.createdAt
        ) {
          throw rotationError("SECURITY_KEYRING_RETIRED_MODE_INVALID");
        }
      } else if (
        key.retiredAt !== undefined ||
        (key.status === "active" && key.verificationMode !== "sign-and-verify") ||
        (key.status === "pending" && key.verificationMode !== "reject")
      ) {
        throw rotationError("SECURITY_KEYRING_GENERATION_STATE_INVALID");
      }
    }
    const generationOne = decoded[0]!;
    assertLegacyMeta(database, purpose, generationOne);
    result[purpose] = {
      active: activeKey,
      retired: decoded.filter((key) => key.status === "retired"),
      ...(pending[0] ? { pending: pending[0] } : {})
    };
  }
  assertKeyringRotationProvenance(database, result);
  return result;
}


function assertKeyringRotationProvenance(
  database: Database.Database,
  rings: SecurityKeyringsByPurpose
): void {
  const plans = database.prepare(
    "SELECT * FROM security_key_rotation_plans ORDER BY created_at,rotation_id"
  ).all() as RotationPlanRow[];
  const planById = new Map(plans.map((plan) => [plan.rotation_id, plan]));
  const eventRows = database.prepare(`SELECT rotation_id,phase,COUNT(*) AS count
    FROM security_key_rotation_events
    WHERE phase IN ('prepared','applying','applied')
    GROUP BY rotation_id,phase`).all() as Array<{
      rotation_id: string;
      phase: "prepared" | "applying" | "applied";
      count: number;
    }>;
  const lifecycleEvents = database.prepare(`SELECT rotation_id,phase,sequence,created_at
    FROM security_key_rotation_events
    WHERE phase IN ('prepared','applying','applied')
    ORDER BY sequence`).all() as Array<{
      rotation_id: string;
      phase: "prepared" | "applying" | "applied";
      sequence: number;
      created_at: number;
    }>;
  const eventCount = (
    rotationId: string,
    phase: "prepared" | "applying" | "applied"
  ) =>
    Number(eventRows.find((row) => row.rotation_id === rotationId && row.phase === phase)?.count ?? 0);
  const eventSequence = (
    rotationId: string,
    phase: "prepared" | "applying" | "applied"
  ) => lifecycleEvents.find((row) => row.rotation_id === rotationId && row.phase === phase)?.sequence;
  const eventCreatedAt = (
    rotationId: string,
    phase: "prepared" | "applying" | "applied"
  ) => lifecycleEvents.find((row) => row.rotation_id === rotationId && row.phase === phase)?.created_at;
  const requirePlan = (rotationId: string): RotationPlanRow => {
    const plan = planById.get(rotationId);
    if (!plan || eventCount(rotationId, "prepared") !== 1) {
      throw rotationError("SECURITY_KEYRING_ROTATION_PROVENANCE_INVALID");
    }
    return plan;
  };
  const keys = (purpose: SecurityHmacPurpose) => [
    ...rings[purpose].retired,
    rings[purpose].active,
    ...(rings[purpose].pending ? [rings[purpose].pending!] : [])
  ];
  const keyAt = (purpose: SecurityHmacPurpose, generation: number) =>
    keys(purpose).find((key) => key.generation === generation);

  for (const event of eventRows) {
    if (!planById.has(event.rotation_id) || event.count !== 1) {
      throw rotationError("SECURITY_KEYRING_ROTATION_EVIDENCE_INVALID");
    }
  }
  for (const plan of plans) {
    const preparedSequence = eventSequence(plan.rotation_id, "prepared");
    const applyingSequence = eventSequence(plan.rotation_id, "applying");
    const appliedSequence = eventSequence(plan.rotation_id, "applied");
    const preparedAt = eventCreatedAt(plan.rotation_id, "prepared");
    const applyingAt = eventCreatedAt(plan.rotation_id, "applying");
    const appliedAt = eventCreatedAt(plan.rotation_id, "applied");
    if (
      !UUID_PATTERN.test(plan.rotation_id) ||
      !isPositiveInteger(plan.source_scope_generation) ||
      !isPositiveInteger(plan.target_scope_generation) ||
      !isPositiveInteger(plan.source_execution_generation) ||
      !isPositiveInteger(plan.target_execution_generation) ||
      plan.target_scope_generation <= plan.source_scope_generation ||
      plan.target_execution_generation <= plan.source_execution_generation ||
      !isPositiveInteger(plan.control_revision) ||
      !DIGEST_PATTERN.test(plan.before_schema_identity) ||
      !DIGEST_PATTERN.test(plan.before_data_identity) ||
      !DIGEST_PATTERN.test(plan.migration_digest) ||
      !isSafeBuildId(plan.build_id) ||
      !isNonnegativeInteger(plan.created_at) ||
      eventCount(plan.rotation_id, "prepared") !== 1 ||
      eventCount(plan.rotation_id, "applying") > 1 ||
      eventCount(plan.rotation_id, "applied") > 1 ||
      preparedSequence === undefined ||
      !isNonnegativeInteger(preparedAt) ||
      preparedAt < plan.created_at ||
      (applyingSequence !== undefined && applyingSequence <= preparedSequence) ||
      (applyingSequence !== undefined && (
        !isNonnegativeInteger(applyingAt) || applyingAt < preparedAt
      )) ||
      (appliedSequence !== undefined && (
        applyingSequence === undefined ||
        applyingSequence >= appliedSequence ||
        !isNonnegativeInteger(appliedAt) ||
        !isNonnegativeInteger(applyingAt) ||
        appliedAt < applyingAt
      ))
    ) throw rotationError("SECURITY_KEYRING_ROTATION_EVIDENCE_INVALID");

    const sourceScope = keyAt(SCOPE_HMAC_PURPOSE, plan.source_scope_generation);
    const sourceExecution = keyAt(EXECUTION_POLICY_HMAC_PURPOSE, plan.source_execution_generation);
    const targetScope = keyAt(SCOPE_HMAC_PURPOSE, plan.target_scope_generation);
    const targetExecution = keyAt(EXECUTION_POLICY_HMAC_PURPOSE, plan.target_execution_generation);
    if (
      !sourceScope || !sourceExecution || !targetScope || !targetExecution ||
      targetScope.rotationId !== plan.rotation_id ||
      targetExecution.rotationId !== plan.rotation_id
    ) throw rotationError("SECURITY_KEYRING_ROTATION_PROVENANCE_INVALID");
    const preparedReceipt = storedReceipt(database, plan.rotation_id, "prepared");
    if (
      !preparedReceipt ||
      !receiptMatchesPlan(
        preparedReceipt,
        plan,
        sourceScope,
        sourceExecution,
        targetScope,
        targetExecution
      ) ||
      preparedReceipt.controlRevision.after !== plan.control_revision
    ) throw rotationError("SECURITY_KEYRING_ROTATION_EVIDENCE_INVALID");
    if (eventCount(plan.rotation_id, "applied") === 1) {
      const appliedReceipt = storedReceipt(database, plan.rotation_id, "applied");
      if (
        !appliedReceipt ||
        !receiptMatchesPlan(
          appliedReceipt,
          plan,
          sourceScope,
          sourceExecution,
          targetScope,
          targetExecution
        ) ||
        !sameReceiptCounts(preparedReceipt, appliedReceipt) ||
        appliedReceipt.controlRevision.after !== plan.control_revision + 1 ||
        sourceScope.status !== "retired" ||
        sourceExecution.status !== "retired" ||
        targetScope.status === "pending" ||
        targetExecution.status === "pending"
      ) throw rotationError("SECURITY_KEYRING_ROTATION_PROVENANCE_INVALID");
    } else if (
      sourceScope !== rings[SCOPE_HMAC_PURPOSE].active ||
      sourceExecution !== rings[EXECUTION_POLICY_HMAC_PURPOSE].active ||
      targetScope !== rings[SCOPE_HMAC_PURPOSE].pending ||
      targetExecution !== rings[EXECUTION_POLICY_HMAC_PURPOSE].pending
    ) {
      throw rotationError("SECURITY_KEYRING_ROTATION_PROVENANCE_INVALID");
    }
  }
  const lookupEvidence = database.prepare(`SELECT key_generation,lookup_scope_id,
      canonical_scope_id,rotation_id,created_at
    FROM scope_rotation_lookup_evidence
    ORDER BY key_generation,lookup_scope_id`).all() as Array<{
      key_generation: number;
      lookup_scope_id: string;
      canonical_scope_id: string;
      rotation_id: string;
      created_at: number;
    }>;
  for (const row of lookupEvidence) {
    const plan = planById.get(row.rotation_id);
    if (
      !plan ||
      !isPositiveInteger(row.key_generation) ||
      normalizeUuid(row.lookup_scope_id, "scope lookup evidence id") !== row.lookup_scope_id ||
      normalizeUuid(row.canonical_scope_id, "scope lookup canonical id") !== row.canonical_scope_id ||
      !isNonnegativeInteger(row.created_at) ||
      plan.source_scope_generation !== row.key_generation ||
      eventCount(plan.rotation_id, "applied") !== 1 ||
      row.created_at !== eventCreatedAt(plan.rotation_id, "applied")
    ) throw rotationError("SECURITY_SCOPE_LOOKUP_EVIDENCE_INVALID");
  }

  for (const plan of plans) {
    const evidenceCount = Number((database.prepare(`SELECT COUNT(*) AS count
      FROM scope_rotation_lookup_evidence
      WHERE rotation_id=? AND key_generation=?`).get(
        plan.rotation_id,
        plan.source_scope_generation
      ) as { count: number }).count);
    const applied = storedReceipt(database, plan.rotation_id, "applied");
    if (
      (applied && evidenceCount !== applied.affected.scopeLookupEvidence) ||
      (!applied && evidenceCount !== 0)
    ) throw rotationError("SECURITY_SCOPE_LOOKUP_EVIDENCE_INVALID");
  }

  const aliases = database.prepare(`SELECT alias_scope_id,canonical_scope_id,
      key_generation,rotation_id,created_at
    FROM scope_aliases ORDER BY alias_scope_id`).all() as Array<{
      alias_scope_id: string;
      canonical_scope_id: string;
      key_generation: number;
      rotation_id: string;
      created_at: number;
    }>;
  for (const alias of aliases) {
    const plan = planById.get(alias.rotation_id);
    const key = keyAt(SCOPE_HMAC_PURPOSE, alias.key_generation);
    if (
      normalizeUuid(alias.alias_scope_id, "scope alias id") !== alias.alias_scope_id ||
      normalizeUuid(alias.canonical_scope_id, "scope alias canonical id") !== alias.canonical_scope_id ||
      !isPositiveInteger(alias.key_generation) ||
      alias.key_generation < 2 ||
      !isNonnegativeInteger(alias.created_at) ||
      !plan ||
      plan.target_scope_generation !== alias.key_generation ||
      eventCount(alias.rotation_id, "applied") !== 1 ||
      !key ||
      key.rotationId !== alias.rotation_id ||
      !database.prepare("SELECT 1 FROM scopes WHERE scope_id=?").get(alias.canonical_scope_id) ||
      database.prepare("SELECT 1 FROM scopes WHERE scope_id=?").get(alias.alias_scope_id) ||
      database.prepare("SELECT 1 FROM scope_aliases WHERE alias_scope_id=?").get(
        alias.canonical_scope_id
      )
    ) throw rotationError("SECURITY_SCOPE_ALIAS_PROVENANCE_INVALID");
  }

  for (const purpose of [SCOPE_HMAC_PURPOSE, EXECUTION_POLICY_HMAC_PURPOSE] as const) {
    for (const key of keys(purpose)) {
      if (key.generation > 1) {
        const plan = requirePlan(key.rotationId!);
        const target = purpose === SCOPE_HMAC_PURPOSE
          ? plan.target_scope_generation
          : plan.target_execution_generation;
        const applied = eventCount(plan.rotation_id, "applied");
        if (
          target !== key.generation ||
          applied !== (key.status === "pending" ? 0 : 1)
        ) {
          throw rotationError("SECURITY_KEYRING_ROTATION_PROVENANCE_INVALID");
        }
      }
      const retirementPlans = plans.filter((plan) => {
        const source = purpose === SCOPE_HMAC_PURPOSE
          ? plan.source_scope_generation
          : plan.source_execution_generation;
        return source === key.generation && eventCount(plan.rotation_id, "applied") === 1;
      });
      if (
        (key.status === "retired" && retirementPlans.length !== 1) ||
        (key.status !== "retired" && retirementPlans.length !== 0)
      ) {
        throw rotationError("SECURITY_KEYRING_RETIREMENT_PROVENANCE_INVALID");
      }
    }
  }

  const scopeActive = rings[SCOPE_HMAC_PURPOSE].active;
  const executionActive = rings[EXECUTION_POLICY_HMAC_PURPOSE].active;
  if (scopeActive.rotationId !== executionActive.rotationId) {
    throw rotationError("SECURITY_KEYRING_ACTIVE_PAIR_INVALID");
  }
  if (scopeActive.rotationId) {
    const plan = requirePlan(scopeActive.rotationId);
    if (
      eventCount(plan.rotation_id, "applied") !== 1 ||
      plan.target_scope_generation !== scopeActive.generation ||
      plan.target_execution_generation !== executionActive.generation
    ) throw rotationError("SECURITY_KEYRING_ACTIVE_PAIR_INVALID");
  } else if (scopeActive.generation !== 1 || executionActive.generation !== 1) {
    throw rotationError("SECURITY_KEYRING_ACTIVE_PAIR_INVALID");
  }

  const scopePending = rings[SCOPE_HMAC_PURPOSE].pending;
  const executionPending = rings[EXECUTION_POLICY_HMAC_PURPOSE].pending;
  if (Boolean(scopePending) !== Boolean(executionPending)) {
    throw rotationError("SECURITY_KEYRING_PENDING_PAIR_INVALID");
  }
  if (scopePending && executionPending) {
    if (!scopePending.rotationId || scopePending.rotationId !== executionPending.rotationId) {
      throw rotationError("SECURITY_KEYRING_PENDING_PAIR_INVALID");
    }
    const plan = requirePlan(scopePending.rotationId);
    if (
      eventCount(plan.rotation_id, "applied") !== 0 ||
      plan.source_scope_generation !== scopeActive.generation ||
      plan.source_execution_generation !== executionActive.generation ||
      plan.target_scope_generation !== scopePending.generation ||
      plan.target_execution_generation !== executionPending.generation
    ) throw rotationError("SECURITY_KEYRING_PENDING_PAIR_INVALID");
  }
}


function receiptMatchesPlan(
  receipt: SecurityRotationReceipt,
  plan: RotationPlanRow,
  sourceScope: SecurityHmacKey,
  sourceExecution: SecurityHmacKey,
  targetScope: SecurityHmacKey,
  targetExecution: SecurityHmacKey
): boolean {
  return receipt.rotationId === plan.rotation_id &&
    receipt.source.scopeGeneration === plan.source_scope_generation &&
    receipt.source.executionGeneration === plan.source_execution_generation &&
    receipt.target.scopeGeneration === plan.target_scope_generation &&
    receipt.target.executionGeneration === plan.target_execution_generation &&
    receipt.fingerprints.oldScope === sourceScope.fingerprint &&
    receipt.fingerprints.oldExecution === sourceExecution.fingerprint &&
    receipt.fingerprints.newScope === targetScope.fingerprint &&
    receipt.fingerprints.newExecution === targetExecution.fingerprint &&
    receipt.schemaIdentity.before === plan.before_schema_identity &&
    receipt.schemaIdentity.after === plan.before_schema_identity &&
    receipt.migrationDigest === plan.migration_digest &&
    receipt.controlRevision.before === plan.control_revision &&
    receipt.buildId === plan.build_id;
}


function sameReceiptCounts(
  left: SecurityRotationReceipt,
  right: SecurityRotationReceipt
): boolean {
  return (Object.keys(left.affected) as Array<keyof SecurityRotationReceipt["affected"]>)
    .every((name) => left.affected[name] === right.affected[name]);
}


export function securityKeyFingerprint(purpose: SecurityHmacPurpose, secret: Uint8Array): string {
  return createHash("sha256")
    .update("codex-mcp-bridge/security-hmac-key-fingerprint/v1\0")
    .update(purpose)
    .update("\0")
    .update(secret)
    .digest("hex");
}


function appliedReceipt(database: Database.Database, rotationId: string): SecurityRotationReceipt | undefined {
  return storedReceipt(database, rotationId, "applied");
}


function storedReceipt(
  database: Database.Database,
  rotationId: string,
  phase: "prepared" | "applied"
): SecurityRotationReceipt | undefined {
  const row = database.prepare(`SELECT payload FROM security_key_rotation_events
    WHERE rotation_id=? AND phase=?`).get(rotationId, phase) as { payload: string } | undefined;
  if (!row) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.payload) as unknown; }
  catch { throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID"); }
  if (!parsed || typeof parsed !== "object") {
    throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  }
  const value = parsed as Record<string, unknown>;
  const source = receiptPair(value.source);
  const target = receiptPair(value.target);
  const fingerprints = receiptDigests(value.fingerprints, [
    "oldScope", "newScope", "oldExecution", "newExecution"
  ]);
  const affected = receiptCounts(value.affected, [
    "scopes", "aliases", "activities", "jobs", "sessions",
    "conversationLinks", "scopeLookupEvidence", "pendingProjectAuthorizations"
  ]);
  const schemaIdentity = receiptDigests(value.schemaIdentity, ["before", "after"]);
  const controlRevision = receiptRevisions(value.controlRevision);
  if (
    value.kind !== "security-key-rotation" ||
    value.rotationId !== rotationId ||
    value.phase !== phase ||
    !DIGEST_PATTERN.test(String(value.migrationDigest ?? "")) ||
    !isSafeBuildId(value.buildId)
  ) throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  return {
    kind: "security-key-rotation",
    rotationId,
    phase,
    source,
    target,
    fingerprints: fingerprints as SecurityRotationReceipt["fingerprints"],
    affected: affected as SecurityRotationReceipt["affected"],
    schemaIdentity: schemaIdentity as SecurityRotationReceipt["schemaIdentity"],
    migrationDigest: String(value.migrationDigest),
    controlRevision,
    buildId: String(value.buildId)
  };
}


function requirePlan(database: Database.Database, rotationId: string): RotationPlanRow {
  const row = database.prepare(
    "SELECT * FROM security_key_rotation_plans WHERE rotation_id=?"
  ).get(rotationId) as RotationPlanRow | undefined;
  if (!row) throw rotationError("SECURITY_KEY_ROTATION_PLAN_NOT_FOUND");
  return row;
}


function receiptPair(value: unknown): SecurityRotationReceipt["source"] {
  if (!value || typeof value !== "object") {
    throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  }
  const pair = value as Record<string, unknown>;
  if (!isPositiveInteger(pair.scopeGeneration) || !isPositiveInteger(pair.executionGeneration)) {
    throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  }
  return {
    scopeGeneration: pair.scopeGeneration,
    executionGeneration: pair.executionGeneration
  };
}


function receiptDigests(value: unknown, names: readonly string[]): Record<string, string> {
  if (!value || typeof value !== "object") {
    throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const name of names) {
    if (typeof source[name] !== "string" || !DIGEST_PATTERN.test(source[name])) {
      throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
    }
    result[name] = source[name];
  }
  return result;
}


function receiptCounts(value: unknown, names: readonly string[]): Record<string, number> {
  if (!value || typeof value !== "object") {
    throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  }
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const name of names) {
    if (!isNonnegativeInteger(source[name])) {
      throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
    }
    result[name] = source[name];
  }
  return result;
}


function receiptRevisions(value: unknown): SecurityRotationReceipt["controlRevision"] {
  if (!value || typeof value !== "object") {
    throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  }
  const revisions = value as Record<string, unknown>;
  if (!isPositiveInteger(revisions.before) || !isPositiveInteger(revisions.after)) {
    throw rotationError("SECURITY_KEY_ROTATION_RECEIPT_INVALID");
  }
  return { before: revisions.before, after: revisions.after };
}


function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}


function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}


function isSafeBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]{1,512}$/.test(value);
}


function decodeKeyRow(row: KeyRow, purpose: SecurityHmacPurpose): SecurityHmacKey {
  if (
    row.purpose !== purpose ||
    !Number.isSafeInteger(row.generation) || row.generation < 1 ||
    !["active", "pending", "retired"].includes(row.status) ||
    !["sign-and-verify", "scope-lookup-only", "reject"].includes(row.verification_mode) ||
    !DIGEST_PATTERN.test(row.fingerprint) ||
    !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
    !(row.retired_at === null || Number.isSafeInteger(row.retired_at)) ||
    !(row.rotation_id === null || UUID_PATTERN.test(row.rotation_id))
  ) throw rotationError("SECURITY_KEYRING_METADATA_INVALID");
  const secret = decodeSecret(row.key_material, `${purpose} generation ${row.generation}`);
  if (securityKeyFingerprint(purpose, secret) !== row.fingerprint) {
    throw rotationError("SECURITY_KEYRING_FINGERPRINT_MISMATCH");
  }
  return {
    purpose,
    generation: row.generation,
    status: row.status as SecurityHmacKey["status"],
    verificationMode: row.verification_mode as SecurityHmacKey["verificationMode"],
    secret,
    fingerprint: row.fingerprint,
    ...(row.rotation_id ? { rotationId: row.rotation_id } : {}),
    createdAt: row.created_at,
    ...(row.retired_at === null ? {} : { retiredAt: row.retired_at })
  };
}


function assertLegacyMeta(
  database: Database.Database,
  purpose: SecurityHmacPurpose,
  generationOne: SecurityHmacKey
): void {
  const value = readMeta(database, legacyMetaKey(purpose));
  if (value === undefined) throw rotationError("SECURITY_KEY_LEGACY_META_MISSING");
  const tombstone = LEGACY_META_TOMBSTONE_PREFIX + generationOne.fingerprint;
  if (generationOne.status === "retired") {
    if (value !== tombstone) throw rotationError("SECURITY_KEY_LEGACY_TOMBSTONE_INVALID");
    return;
  }
  if (generationOne.status !== "active" || value === tombstone) {
    throw rotationError("SECURITY_KEY_LEGACY_META_STATE_INVALID");
  }
  const secret = decodeSecret(value, `${purpose} legacy key`);
  if (!secret.equals(generationOne.secret)) {
    throw rotationError("SECURITY_KEY_LEGACY_IMPORT_CONFLICT");
  }
}


function decodeSecret(encoded: string, label: string): Buffer {
  let decoded: Buffer;
  try { decoded = Buffer.from(encoded, "base64url"); }
  catch { throw rotationError("SECURITY_KEY_ENCODING_INVALID"); }
  if (decoded.length !== 32 || decoded.toString("base64url") !== encoded) {
    throw rotationError("SECURITY_KEY_ENCODING_INVALID", label);
  }
  return decoded;
}


function legacyMetaKey(purpose: SecurityHmacPurpose): string {
  return purpose === SCOPE_HMAC_PURPOSE
    ? SCOPE_SECRET_META_KEY
    : EXECUTION_POLICY_SECRET_META_KEY;
}


function readMeta(database: Database.Database, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM bridge_meta WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}


function normalizeUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw rotationError("SECURITY_KEY_ROTATION_UUID_INVALID", label);
  return normalized;
}


function rotationError(code: string, _detail?: string): Error {
  return new Error(code);
}
