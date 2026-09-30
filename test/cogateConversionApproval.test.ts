import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, test } from "vitest";
import { coGateConversionApprovalSigningMessage, inspectCoGateConversionApproval,
  type CoGateConversionApprovalBindings, type CoGateConversionApprovalBody } from "../src/cogateConversionApproval.js";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashFields = ["sourceCandidateSha256", "targetCandidateSha256", "sourcePreservationSha256",
  "targetProjectionPlanSha256", "implementationSha256", "sealedBackupSha256", "workflowSha256",
  "controlSha256", "rollbackCandidateSha256", "maintenanceOwnerSha256"] as const;

// Generated test keys and arbitrary binding hashes are synthetic. This suite
// cannot establish the origin of real reviewer authority or grant maintenance.
function fixture() {
  const { publicKey,privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({format:"der",type:"spki"});
  const bindings = {
    conversionId:"e8867045-810a-46f6-b30f-af652802bb2d",
    logicalDatabaseId:"fe1caa9d-2aeb-4edb-a066-40b7a912a114",
    sourceProfile:"cogate-v2-workspace-hmac/schema21/v1", sourceSchema:21,targetSchema:31,
    ...Object.fromEntries(hashFields.map((field,index)=>[field,digest(Buffer.from(`synthetic-${index}`))]))
  } as CoGateConversionApprovalBindings;
  const body: CoGateConversionApprovalBody = {
    format:"cogate-lineage-conversion-approval-body/v1",conclusion:"approved",bindings,
    reviewer:{id:"synthetic-fixture-reviewer",role:"independent-reviewer",keyId:digest(der)},
    reviewedAt:"2026-09-30T23:00:00.000Z",expiresAt:"2026-10-01T01:00:00.000Z"
  };
  const envelope = {format:"cogate-lineage-conversion-approval/v1",body,
    signature:{algorithm:"Ed25519",value:sign(null,coGateConversionApprovalSigningMessage(body),privateKey).toString("base64")}};
  return {bindings,body,envelope,privateKey,authority:{publicKeySpkiDer:der,sha256:digest(der)},
    bytes:()=>Buffer.from(JSON.stringify(envelope)),
    resign:()=>{envelope.signature.value=sign(null,coGateConversionApprovalSigningMessage(body),privateKey).toString("base64");}};
}

describe("conversion signature comparison without external-origin or apply authority", () => {
  test("matches a domain-separated Ed25519 signature and exact caller bindings with explicit incomplete authority", () => {
    const f=fixture(); const before=f.bytes();
    const result=inspectCoGateConversionApproval(before,f.authority,f.bindings,NOW);
    expect(result).toMatchObject({authority:"none",signatureVerification:"matched-supplied-key",
      bindingVerification:"matched-supplied-expectations",externalAuthorityOriginVerification:"not-performed",
      liveOwnerVerification:"not-performed",sealedBackupVerification:"not-performed",candidateVerification:"not-performed"});
    expect(result.approvalSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.bytes()).toEqual(before); expect(JSON.stringify(result)).not.toContain("approved");
  });
  test.each(hashFields)("rejects changed expected %s despite a valid signature", field => {
    const f=fixture(),expected={...f.bindings,[field]:"b".repeat(64)};
    expect(()=>inspectCoGateConversionApproval(f.bytes(),f.authority,expected,NOW)).toThrow(/bindings/);
  });
  test.each(["conversionId","logicalDatabaseId"] as const)("rejects another %s",field=>{
    const f=fixture(),expected={...f.bindings,[field]:"04f67456-3fc7-487b-bb32-21e674d40d27"};
    expect(()=>inspectCoGateConversionApproval(f.bytes(),f.authority,expected,NOW)).toThrow(/bindings/);
  });
  test("rejects tampered signed bindings, wrong key and legacy signature domain",()=>{
    const f=fixture(); f.body.bindings.controlSha256="c".repeat(64);
    expect(()=>inspectCoGateConversionApproval(f.bytes(),f.authority,f.bindings,NOW)).toThrow(/signature mismatch/);
    f.resign();
    expect(()=>inspectCoGateConversionApproval(f.bytes(),fixture().authority,f.bindings,NOW)).toThrow(/key identity/);
    f.envelope.signature.value=sign(null,Buffer.from(JSON.stringify(f.body)),f.privateKey).toString("base64");
    expect(()=>inspectCoGateConversionApproval(f.bytes(),f.authority,f.bindings,NOW)).toThrow(/signature mismatch/);
  });
  test.each([
    {reviewedAt:"2026-10-01T00:00:00.001Z",expiresAt:"2026-10-01T01:00:00.000Z"},
    {reviewedAt:"2026-09-30T23:00:00.000Z",expiresAt:"2026-10-01T00:00:00.000Z"},
    {reviewedAt:"2026-09-29T23:00:00.000Z",expiresAt:"2026-10-01T01:00:00.000Z"},
    {reviewedAt:"2026-09-30T23:00:00Z",expiresAt:"2026-10-01T01:00:00.000Z"},
    {reviewedAt:"2026-02-30T23:00:00.000Z",expiresAt:"2026-10-01T01:00:00.000Z"}
  ])("rejects stale, future, oversized or noncanonical validity: %j", validity=>{
    const f=fixture(); Object.assign(f.body,validity); f.resign();
    expect(()=>inspectCoGateConversionApproval(f.bytes(),f.authority,f.bindings,NOW)).toThrow(/timestamp|validity/);
  });
  test.each(["conclusion","unknown-body-field","unknown-envelope-field","reviewer-role","reviewer-control","source-schema","target-schema","uppercase-hash"])(
    "rejects shape or policy conflicts: %s",kind=>{
      const f=fixture();
      if(kind==="conclusion") (f.body as unknown as Record<string,unknown>).conclusion="CHANGES_REQUIRED";
      if(kind==="unknown-body-field") Object.assign(f.body,{launchGranted:true});
      if(kind==="unknown-envelope-field") Object.assign(f.envelope,{launchGranted:true});
      if(kind==="reviewer-role") (f.body.reviewer as unknown as Record<string,unknown>).role="self-review";
      if(kind==="reviewer-control") f.body.reviewer.id="synthetic\0reviewer";
      if(kind==="source-schema") Object.assign(f.bindings,{sourceSchema:20});
      if(kind==="target-schema") Object.assign(f.bindings,{targetSchema:30});
      if(kind==="uppercase-hash") f.bindings.implementationSha256="A".repeat(64);
      f.resign(); expect(()=>inspectCoGateConversionApproval(f.bytes(),f.authority,f.bindings,NOW)).toThrow();
    }
  );
  test.each(["duplicate-root","escaped-duplicate-nested","invalid-utf8","surrogate","too-large","noncanonical-base64"])(
    "rejects raw receipt boundary corruption: %s",kind=>{
      const f=fixture(); let bytes=f.bytes();
      if(kind==="duplicate-root") bytes=Buffer.from(bytes.toString().replace('{"format":','{"format":"ignored","format":'));
      if(kind==="escaped-duplicate-nested") bytes=Buffer.from(bytes.toString().replace('"conclusion":"approved"','"conclusion":"approved","conclu\\u0073ion":"approved"'));
      if(kind==="invalid-utf8") bytes=Buffer.concat([bytes,Buffer.from([0x80])]);
      if(kind==="surrogate") bytes=Buffer.from(bytes.toString().replace('synthetic-fixture-reviewer','\\ud800'));
      if(kind==="too-large") bytes=Buffer.alloc(65537,0x20);
      if(kind==="noncanonical-base64") { f.envelope.signature.value+="\n"; bytes=f.bytes(); }
      expect(()=>inspectCoGateConversionApproval(bytes,f.authority,f.bindings,NOW)).toThrow();
    }
  );
  test("rejects non-Ed25519 keys, key fingerprint conflicts and appended DER",()=>{
    const f=fixture();
    const {publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
    const der=publicKey.export({format:"der",type:"spki"});
    for(const authority of [
      {publicKeySpkiDer:der,sha256:digest(der)},
      {...f.authority,sha256:"a".repeat(64)},
      {publicKeySpkiDer:Buffer.concat([f.authority.publicKeySpkiDer,Buffer.from([0])]),sha256:f.authority.sha256}
    ]) expect(()=>inspectCoGateConversionApproval(f.bytes(),authority,f.bindings,NOW)).toThrow();
  });
  test("canonical JSON field ordering retains the same signature and receipt digest",()=>{
    const f=fixture(),first=inspectCoGateConversionApproval(f.bytes(),f.authority,f.bindings,NOW);
    const reverse=(value:unknown):unknown=>value!==null&&typeof value==="object"&&!Array.isArray(value)?
      Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverse(item)])):value;
    const bytes=Buffer.from(JSON.stringify(reverse(f.envelope),null,2));
    expect(inspectCoGateConversionApproval(bytes,f.authority,f.bindings,NOW)).toEqual(first);
  });

  test.each(["zero-point","identity-point"])("rejects a weak %s before platform signature verification",kind=>{
    const f=fixture(),raw=Buffer.alloc(32); if(kind==="identity-point") raw[0]=1;
    const der=Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),raw]);
    const signature=Buffer.alloc(64); signature[0]=1;
    f.body.reviewer.keyId=digest(der); f.envelope.signature.value=signature.toString("base64");
    const key=createPublicKey({key:der,format:"der",type:"spki"});
    // Identity reproduces unconditional platform acceptance. The zero point
    // has order four and platform acceptance depends on the message hash.
    if(kind==="identity-point") expect(verify(null,coGateConversionApprovalSigningMessage(f.body),key,signature)).toBe(true);
    expect(()=>inspectCoGateConversionApproval(f.bytes(),{publicKeySpkiDer:der,sha256:digest(der)},f.bindings,NOW))
      .toThrow(/public key point order/);
  });

  test.each(["order-two","order-four-negative","mixed-order","noncanonical-y","noncanonical-zero-sign","off-curve"])(
    "rejects an invalid authority point: %s",kind=>{
      const f=fixture(); let raw:Buffer;
      if(kind==="order-two") raw=Buffer.from("ec"+"ff".repeat(30)+"7f","hex");
      else if(kind==="order-four-negative") { raw=Buffer.alloc(32);raw[31]=0x80; }
      else if(kind==="mixed-order") raw=Buffer.from(ed25519.Point.BASE.add(ed25519.Point.fromBytes(Buffer.alloc(32),false)).toBytes());
      else if(kind==="noncanonical-y") raw=Buffer.from("ed"+"ff".repeat(30)+"7f","hex");
      else if(kind==="noncanonical-zero-sign") { raw=Buffer.alloc(32);raw[0]=1;raw[31]=0x80; }
      else { raw=Buffer.alloc(32);raw[0]=2; }
      const der=Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),raw]);
      f.body.reviewer.keyId=digest(der); f.resign();
      expect(()=>inspectCoGateConversionApproval(f.bytes(),{publicKeySpkiDer:der,sha256:digest(der)},f.bindings,NOW))
        .toThrow(/public key point (order|encoding)/);
    }
  );
  test("accepts independently generated ordinary prime-order authority keys",()=>{
    for(let count=0;count<16;count++) {
      const f=fixture(); expect(inspectCoGateConversionApproval(f.bytes(),f.authority,f.bindings,NOW)
        .signatureVerification).toBe("matched-supplied-key");
    }
  });
});
