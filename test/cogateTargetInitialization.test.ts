import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { inspectCoGateLegacyProjection, inspectCoGateTargetInitialization } from "../src/cogateLegacyProjection.js";
import { projectionFixture } from "./helpers/cogateProjectionFixtures.js";

const settings = JSON.stringify({ modelDescriptionOverrides: {
  "model-a": "verbatim\u0000UNKNOWN é", "model-b": "", "model-c": null, "model-d": 1,
  "😀": "retained\ntext" }, other: { outcome: "UNKNOWN" } });
function fixture(encoding = "UTF-8", payload: string | undefined = settings) {
  return projectionFixture({ initialized: true, encoding, settings: payload });
}
function withFixture(action: (value: ReturnType<typeof fixture>) => void) {
  const value = fixture(); try { action(value); } finally { value.close(); }
}
describe("same-snapshot target initialization content inspection", () => {
  test.each(["UTF-8", "UTF-16le", "UTF-16be"])("matches derived rows and converted provenance in %s", encoding => {
    const value = fixture(encoding);
    try {
      const before = value.target.serialize();
      const result = inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId);
      expect(result).toMatchObject({ authority:"none", approvalVerification:"not-performed",
        ownerVerification:"not-performed", targetInitializationVerification:"matched-content",
        sourceTableCount:42, modelDescriptionVersions:{rowCount:2} });
      expect(result.matchedTables).toEqual(value.ledger.tables);
      expect(JSON.stringify(result)).not.toContain("verbatim");
      expect(JSON.stringify(result)).not.toContain("other");
      expect(value.target.serialize()).toEqual(before);
      expect(value.target.inTransaction).toBe(false);
      expect(value.target.pragma("query_only",{simple:true})).toBe(0);
    } finally { value.close(); }
  });
  test("accepts absent or empty overrides without inventing catalog history", () => {
    for (const payload of [undefined,"{}",'{"modelDescriptionOverrides":null}', '{"modelDescriptionOverrides":{}}']) {
      const value = projectionFixture({ initialized:true,settings:payload });
      try { expect(inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId)
        .modelDescriptionVersions.rowCount).toBe(0); } finally { value.close(); }
    }
  });
  test.each([
    ["history loss", "DELETE FROM model_description_versions", /history/],
    ["invented timestamp", "UPDATE model_description_versions SET created_at=0", /history/],
    ["invented version", "UPDATE model_description_versions SET version=2", /history/],
    ["normalized text", "UPDATE model_description_versions SET description='PASS'", /history/],
    ["extra model", "INSERT INTO model_description_versions VALUES('invented',1,'text',NULL)", /history/],
    ["fresh origin", "UPDATE bridge_meta SET value='{\"kind\":\"fresh\"}' WHERE key='state_schema_origin'", /active provenance/],
    ["duplicate origin", "UPDATE bridge_meta SET value=value||' ' WHERE key='state_schema_origin'", /active provenance/],
    ["wrong marker", "UPDATE bridge_meta SET value='other' WHERE key='cogate_lineage_conversion_v1'", /active provenance/],
    ["catalog version", "UPDATE bridge_meta SET value='2' WHERE key='state_migration_catalog_version'", /active provenance/],
    ["missing storage", "DELETE FROM bridge_meta WHERE key='schema_v31_cogate_storage'", /active provenance/],
    ["created origin", "INSERT INTO bridge_meta VALUES('schema_v31_created_at','invented')", /active provenance/],
    ["service evidence", "INSERT INTO bridge_meta VALUES('state_service_opened_after_migration','0')", /active provenance/],
    ["fake upstream receipt", "INSERT INTO bridge_meta VALUES('state_migration:fake','{}')", /active provenance/],
    ["retained UNKNOWN", "UPDATE jobs SET payload='{\"outcome\":\"PASS\"}'", /table jobs/]
  ])("rejects %s and leaves target bytes/settings unchanged", (_,sql,error) => withFixture(value => {
    value.target.exec(sql as string); const before=value.target.serialize();
    expect(() => inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId)).toThrow(error as RegExp);
    expect(value.target.serialize()).toEqual(before);
    expect(value.target.inTransaction).toBe(false);
    expect(value.target.pragma("query_only",{simple:true})).toBe(0);
  }));
  test.each(['[]','{"modelDescriptionOverrides":[]}',
    '{"modelDescriptionOverrides":{},"modelDescriptionOverrides":null}',
    '{"modelDescriptionOverrides":{},"modelDescriptionOverri\\u0064es":{}}',
    '{"modelDescriptionOverrides":{"model-a":"","model-a":null}}',
    '{"modelDescriptionOverrides":{"model-a":"\\ud800"}}'
  ])("rejects ambiguous settings retained as-is: %s", payload => {
    const value=fixture("UTF-8",payload);
    try {
      expect(inspectCoGateLegacyProjection(value.target,value.ledger,value.conversionId).authority).toBe("none");
      expect(() => inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId)).toThrow();
    } finally { value.close(); }
  });
  test("old projection evidence does not imply initialized provenance or model history", () => {
    const value=projectionFixture();
    try {
      expect(inspectCoGateLegacyProjection(value.target,value.ledger,value.conversionId).targetInitializationVerification)
        .toBe("not-performed");
      expect(() => inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId)).toThrow(/receipt/);
    } finally { value.close(); }
  });
  test("rejects TEMP objects and keeps a caller transaction intact", () => withFixture(value => {
    value.target.exec("CREATE TEMP TABLE bridge_meta(key,value)");
    expect(() => inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId)).toThrow(/TEMP/);
    value.target.exec("DROP TABLE temp.bridge_meta; BEGIN");
    expect(() => inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId)).toThrow(/idle read-only/);
    expect(value.target.inTransaction).toBe(true); value.target.exec("ROLLBACK");
  }));
  test("checks retained and derived content in one transaction before rollback", () => withFixture(value => {
    const exec=vi.spyOn(value.target,"exec"); const prepare=value.target.prepare.bind(value.target);
    const spy=vi.spyOn(value.target,"prepare").mockImplementation(sql => {
      expect(value.target.inTransaction).toBe(true); return prepare(sql);
    });
    try { inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId); }
    finally { spy.mockRestore(); }
    expect(exec.mock.calls.map(call=>call[0])).toEqual(["BEGIN","ROLLBACK"]);
  }));
  test("uses a caller-owned read-only file without altering its database", () => withFixture(value => {
    const root=mkdtempSync(path.join(tmpdir(),"cogate-init-")), file=path.join(root,"fixture.sqlite");
    writeFileSync(file,value.target.serialize(),{mode:0o600}); const before=readFileSync(file);
    const db=new Database(file,{readonly:true,fileMustExist:true});
    try {
      expect(inspectCoGateTargetInitialization(db,value.ledger,value.conversionId).authority).toBe("none");
      expect(readFileSync(file)).toEqual(before);
    }
    finally { db.close(); rmSync(root,{recursive:true}); }
    expect(value.target.serialize()).toEqual(before);
  }));
});
