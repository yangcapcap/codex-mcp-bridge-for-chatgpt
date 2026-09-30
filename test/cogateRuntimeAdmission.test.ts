import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { BridgeStateStore } from "../src/stateStore.js";
import { prepareStateDatabaseOpen } from "../src/stateDatabaseLifecycle.js";
import { inspectCoGateTargetInitialization } from "../src/cogateLegacyProjection.js";
import { projectionFixture } from "./helpers/cogateProjectionFixtures.js";
import { assertCoGateUnifiedRuntimeAdmission } from "../src/cogateRuntimeAdmission.js";
import { V31_COGATE_UNIFIED_MIGRATION_SCHEMA } from "../src/cogateUnifiedSchema.js";

describe("runtime activation remains closed until unified CoGate actors and authority are implemented", () => {
  test.each([false,true])("content initialization proof does not grant runtime readOnly=%s admission", readOnly => {
    const value=projectionFixture({initialized:true});
    const root=mkdtempSync(path.join(tmpdir(),"cogate-admission-")), file=path.join(root,"candidate.sqlite");
    let store:BridgeStateStore|undefined;
    try {
      expect(inspectCoGateTargetInitialization(value.target,value.ledger,value.conversionId)
        .targetInitializationVerification).toBe("matched-content");
      writeFileSync(file,value.target.serialize(),{mode:0o600});const before=readFileSync(file);
      expect(()=>{store=new BridgeStateStore({file,readOnly});}).toThrow(/COGATE_STATE_ACTIVATION_UNAVAILABLE/);
      expect(readFileSync(file)).toEqual(before);expect(readdirSync(root)).toEqual(["candidate.sqlite"]);
    } finally {store?.close();value.close();rmSync(root,{recursive:true});}
  });
  test("blocks the read-only preflight before maintenance lock/status/backup writes", () => {
    const value=projectionFixture({initialized:true});
    const root=mkdtempSync(path.join(tmpdir(),"cogate-preflight-")), file=path.join(root,"candidate.sqlite");
    let lease:ReturnType<typeof prepareStateDatabaseOpen>;
    try {
      writeFileSync(file,value.target.serialize(),{mode:0o600});const before=readFileSync(file);
      expect(()=>{lease=prepareStateDatabaseOpen(file);}).toThrow(/COGATE_STATE_ACTIVATION_UNAVAILABLE/);
      expect(readFileSync(file)).toEqual(before);expect(readdirSync(root)).toEqual(["candidate.sqlite"]);
    } finally {lease?.complete();value.close();rmSync(root,{recursive:true});}
  });
  test("ordinary fresh upstream schema31 remains usable with its disabled empty extension", () => {
    const root=mkdtempSync(path.join(tmpdir(),"cogate-ordinary-")), file=path.join(root,"ordinary.sqlite");
    try {
      new BridgeStateStore({file}).close();new BridgeStateStore({file,readOnly:true}).close();
      new BridgeStateStore({file}).close();
    } finally {rmSync(root,{recursive:true});}
  });
  test.each([
    "UPDATE workspace_control SET mode='enabled'",
    "UPDATE workspace_control SET revision=2",
    "UPDATE workspace_control SET maintenance=1",
    "DELETE FROM workspace_control",
    "INSERT INTO bridge_meta VALUES('cogate_lineage_conversion_v1','UNKNOWN')",
    "UPDATE bridge_meta SET value='{\"kind\":\"lineage-conversion\"}' WHERE key='state_schema_origin'",
    `INSERT INTO security_hmac_keys VALUES('scope',1,'active','sign-and-verify',
      '${"a".repeat(43)}','${"a".repeat(64)}',NULL,0,NULL)`
  ])("rejects unimplemented state activation through either runtime open path: %s", sql => {
    const root=mkdtempSync(path.join(tmpdir(),"cogate-evidence-")),file=path.join(root,"ordinary.sqlite");
    try {
      new BridgeStateStore({file}).close();const db=new Database(file);
      try {db.exec(sql);} finally {db.close();}
      const before=readFileSync(file),names=readdirSync(root);
      for (const readOnly of [true,false]) {
        let store:BridgeStateStore|undefined;
        try {expect(()=>{store=new BridgeStateStore({file,readOnly});}).toThrow(/COGATE_STATE_ACTIVATION_UNAVAILABLE/);}
        finally {store?.close();}
      }
      expect(readFileSync(file)).toEqual(before);
      // SQLite may create coordination sidecars even for a read-only WAL open.
      // No runtime lease, backup/status file or WAL data frame is permitted.
      for (const name of readdirSync(root).filter(name => !names.includes(name))) {
        expect(["ordinary.sqlite-wal","ordinary.sqlite-shm"]).toContain(name);
        expect(statSync(path.join(root,name)).size).toBe(name.endsWith("-wal") ? 0 : 32768);
      }
    } finally {rmSync(root,{recursive:true});}
  });
  test("an owned inspection snapshot ends on both success and rejection", () => {
    const value=projectionFixture({initialized:true});
    try {
      expect(value.target.inTransaction).toBe(false);
      expect(()=>assertCoGateUnifiedRuntimeAdmission(value.target)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect(value.target.inTransaction).toBe(false);
      const db=new Database(":memory:");
      try {
        db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA);
        db.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
        assertCoGateUnifiedRuntimeAdmission(db);expect(db.inTransaction).toBe(false);
      } finally {db.close();}
    } finally {value.close();}
  });
  test("a caller-owned transaction and pending evidence remain intact on rejection", () => {
    const value=projectionFixture({initialized:true});
    try {
      value.target.exec("BEGIN");
      value.target.prepare("INSERT INTO bridge_meta VALUES('pending_evidence','UNKNOWN')").run();
      expect(()=>assertCoGateUnifiedRuntimeAdmission(value.target)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect(value.target.inTransaction).toBe(true);
      expect(value.target.prepare("SELECT value FROM bridge_meta WHERE key='pending_evidence'").get()).toEqual({value:"UNKNOWN"});
      value.target.exec("ROLLBACK");
      expect(value.target.prepare("SELECT 1 FROM bridge_meta WHERE key='pending_evidence'").get()).toBeUndefined();
    } finally {value.close();}
  });
});
