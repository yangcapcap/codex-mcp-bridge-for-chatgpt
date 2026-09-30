import { createHash, createPublicKey, verify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeUtf8Strict, parseJsonUtf8Strict } from "./textIntegrity.js";

const SOURCE_PROFILE = "cogate-v2-workspace-hmac/schema21/v1";
const DOMAIN = "cogate-lineage-conversion-approval/v1\0";
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[45][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_APPROVAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DIGEST_FIELDS = [
  "sourceCandidateSha256", "targetCandidateSha256", "sourcePreservationSha256",
  "targetProjectionPlanSha256", "implementationSha256", "sealedBackupSha256",
  "workflowSha256", "controlSha256", "rollbackCandidateSha256", "maintenanceOwnerSha256"
] as const;

/** These are caller-supplied expected bindings, not measurements or grants. */
export type CoGateConversionApprovalBindings = {
  conversionId: string;
  logicalDatabaseId: string;
  sourceProfile: typeof SOURCE_PROFILE;
  sourceSchema: 21;
  targetSchema: 31;
} & Record<typeof DIGEST_FIELDS[number], string>;

export type CoGateConversionApprovalBody = {
  format: "cogate-lineage-conversion-approval-body/v1";
  conclusion: "approved";
  bindings: CoGateConversionApprovalBindings;
  reviewer: { id: string; role: "independent-reviewer"; keyId: string };
  reviewedAt: string;
  expiresAt: string;
};

export type CoGateConversionApprovalInspection = {
  format: "cogate-lineage-conversion-approval-inspection/v1";
  approvalSha256: string;
  suppliedKeySha256: string;
  conversionId: string;
  logicalDatabaseId: string;
  signatureVerification: "matched-supplied-key";
  bindingVerification: "matched-supplied-expectations";
  authority: "none";
  externalAuthorityOriginVerification: "not-performed";
  liveOwnerVerification: "not-performed";
  sealedBackupVerification: "not-performed";
  candidateVerification: "not-performed";
};

/** The signature domain is separate from every legacy Bootstrap ceremony. */
export function coGateConversionApprovalSigningMessage(body: CoGateConversionApprovalBody): Buffer {
  return Buffer.from(DOMAIN + canonical(body), "utf8");
}

/**
 * Read-only cryptographic comparison, with no file I/O or execution capability.
 * The caller must separately authenticate where its public key and expected
 * bindings came from. Matching a supplied key is not external reviewer authority,
 * exclusive live maintenance ownership, backup sealing or permission to apply.
 */
export function inspectCoGateConversionApproval(
  receiptBytes: Uint8Array,
  suppliedAuthority: { publicKeySpkiDer: Uint8Array; sha256: string },
  expected: CoGateConversionApprovalBindings,
  nowMs = Date.now()
): CoGateConversionApprovalInspection {
  if (!(receiptBytes instanceof Uint8Array) || receiptBytes.byteLength === 0 ||
      receiptBytes.byteLength > 64 * 1024 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("CoGate conversion approval input or clock is invalid.");
  }
  assertBindings(expected);
  const expectedCanonical = canonical(expected);
  const bytes = Buffer.from(receiptBytes);
  const envelope = parseJsonUtf8Strict<unknown>(bytes, "CoGate conversion approval");
  assertUniqueMembers(decodeUtf8Strict(bytes, "CoGate conversion approval"));
  assertKeys(envelope, ["format", "body", "signature"]);
  if (envelope.format !== "cogate-lineage-conversion-approval/v1") fail("format");
  const body = envelope.body;
  assertKeys(body, ["format", "conclusion", "bindings", "reviewer", "reviewedAt", "expiresAt"]);
  if (body.format !== "cogate-lineage-conversion-approval-body/v1" || body.conclusion !== "approved") fail("conclusion");
  assertBindings(body.bindings);
  if (canonical(body.bindings) !== expectedCanonical) fail("bindings");
  assertKeys(body.reviewer, ["id", "role", "keyId"]);
  if (typeof body.reviewer.id !== "string" || body.reviewer.id.length === 0 ||
      body.reviewer.id.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(body.reviewer.id) ||
      body.reviewer.role !== "independent-reviewer" || !isDigest(body.reviewer.keyId)) fail("reviewer");
  const reviewedAt = exactTimestamp(body.reviewedAt), expiresAt = exactTimestamp(body.expiresAt);
  if (reviewedAt > nowMs || expiresAt <= nowMs || expiresAt <= reviewedAt ||
      expiresAt - reviewedAt > MAX_APPROVAL_LIFETIME_MS) fail("validity");
  assertKeys(envelope.signature, ["algorithm", "value"]);
  if (envelope.signature.algorithm !== "Ed25519" || typeof envelope.signature.value !== "string") fail("signature");
  const signature = Buffer.from(envelope.signature.value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== envelope.signature.value) fail("signature encoding");
  if (!suppliedAuthority || !(suppliedAuthority.publicKeySpkiDer instanceof Uint8Array) ||
      suppliedAuthority.publicKeySpkiDer.byteLength !== 44 || !isDigest(suppliedAuthority.sha256)) fail("supplied key");
  const keyBytes = Buffer.from(suppliedAuthority.publicKeySpkiDer);
  const key = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519" ||
      !keyBytes.equals(key.export({ format: "der", type: "spki" }))) fail("key type or encoding");
  // DER validates the wrapper, not the Ed25519 point. Reject identity, torsion,
  // mixed-order and noncanonical points before delegating signature verification
  // to OpenSSL. Point validation only handles public input; no private scalar.
  const rawPublicKey = keyBytes.subarray(12);
  let point: ReturnType<typeof ed25519.Point.fromBytes>;
  try { point = ed25519.Point.fromBytes(rawPublicKey, false); }
  catch { fail("public key point encoding"); }
  if (!Buffer.from(point.toBytes()).equals(rawPublicKey) ||
      point.equals(ed25519.Point.ZERO) || point.isSmallOrder() || !point.isTorsionFree()) {
    fail("public key point order");
  }
  const keySha256 = digest(keyBytes);
  if (keySha256 !== suppliedAuthority.sha256 || body.reviewer.keyId !== keySha256) fail("key identity");
  if (!verify(null, coGateConversionApprovalSigningMessage(body as CoGateConversionApprovalBody), key, signature)) fail("signature mismatch");
  return {
    format: "cogate-lineage-conversion-approval-inspection/v1",
    approvalSha256: digest(Buffer.from(canonical(envelope), "utf8")), suppliedKeySha256: keySha256,
    conversionId: body.bindings.conversionId, logicalDatabaseId: body.bindings.logicalDatabaseId,
    signatureVerification: "matched-supplied-key", bindingVerification: "matched-supplied-expectations",
    authority: "none", externalAuthorityOriginVerification: "not-performed",
    liveOwnerVerification: "not-performed", sealedBackupVerification: "not-performed", candidateVerification: "not-performed"
  };
}

function assertBindings(value: unknown): asserts value is CoGateConversionApprovalBindings {
  assertKeys(value, ["conversionId", "logicalDatabaseId", "sourceProfile", "sourceSchema", "targetSchema", ...DIGEST_FIELDS]);
  if (typeof value.conversionId !== "string" || !UUID.test(value.conversionId) ||
      typeof value.logicalDatabaseId !== "string" || !UUID.test(value.logicalDatabaseId) ||
      value.sourceProfile !== SOURCE_PROFILE || value.sourceSchema !== 21 || value.targetSchema !== 31 ||
      !DIGEST_FIELDS.every(field => isDigest(value[field]))) fail("binding shape");
}

function assertKeys(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) fail("object fields");
}
function exactTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) fail("timestamp");
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail("timestamp");
  return time;
}
function isDigest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function fail(field: string): never { throw new Error(`CoGate conversion approval conflicts with ${field}.`); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Grammar and Unicode were already checked. Inspect every raw object before
 * last-member-wins decoding can erase contradictory signed fields. Iterative
 * scanning keeps bounded but deeply nested hostile input off the call stack. */
function assertUniqueMembers(raw: string): void {
  const stack: Array<{ kind: "object" | "array"; expectsKey: boolean; keys: Set<string> }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === '"') {
      let end = index + 1;
      while (end < raw.length && raw[end] !== '"') end += raw[end] === "\\" ? 2 : 1;
      const current = stack.at(-1);
      if (current?.kind === "object" && current.expectsKey) {
        const key = JSON.parse(raw.slice(index,end+1)) as string;
        if (current.keys.has(key)) fail("duplicate object member");
        current.keys.add(key); current.expectsKey = false;
      }
      index = end;
    } else if (token === "{" || token === "[") {
      stack.push({kind:token === "{" ? "object" : "array",expectsKey:token === "{",keys:new Set()});
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && stack.at(-1)?.kind === "object") stack.at(-1)!.expectsKey = true;
  }
}
