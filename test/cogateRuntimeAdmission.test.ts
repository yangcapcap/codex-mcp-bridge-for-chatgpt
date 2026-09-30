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
import { createSchema18Fixture } from "./helpers/stateSchemaFixtures.js";

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
  test.each([
    '{"kind":"lineage-conversion","kind":"fresh"}',
    '{"k\\u0069nd":"lineage-conversion","kind":"fresh"}',
    '{"format":"cogate-unified-origin/v1","format":"ordinary"}',
    '{"for\\u006dat":"cogate-unified-origin/v1","format":"ordinary"}'
  ])("ambiguous decoded conversion-origin fields reject both current startup paths: %s", origin => {
    const root=mkdtempSync(path.join(tmpdir(),"cogate-ambiguous-origin-")),file=path.join(root,"candidate.sqlite");
    try {
      new BridgeStateStore({file}).close();const db=new Database(file);
      db.prepare("UPDATE bridge_meta SET value=? WHERE key='state_schema_origin'").run(origin);
      db.pragma("journal_mode = DELETE");db.close();
      const before=readFileSync(file),names=readdirSync(root);
      for (const readOnly of [true,false]) {
        let store:BridgeStateStore|undefined;
        try {expect(()=>{store=new BridgeStateStore({file,readOnly});}).toThrow(/ACTIVATION_UNAVAILABLE/);}
        finally {store?.close();}
      }
      expect(()=>prepareStateDatabaseOpen(file)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect(readFileSync(file)).toEqual(before);expect(readdirSync(root)).toEqual(names);
    } finally {rmSync(root,{recursive:true});}
  });
  test.each([
    ['state_schema_origin','{"kind":"lineage-conversion"}'],
    ['state_schema_origin','{"format":"cogate-unified-origin/v1"}'],
    ['state_schema_origin','{"kind":"lineage-conversion","kind":"fresh"}'],
    ['cogate_lineage_conversion_v1','UNKNOWN']
  ])("conversion evidence blocks schema30 automatic upgrade before any new sidecar: %s", (key,value) => {
    const root=mkdtempSync(path.join(tmpdir(),"cogate-old-origin-")),file=path.join(root,"candidate.sqlite");
    try {
      createSchema18Fixture(file);
      expect(()=>new BridgeStateStore({file,onMigrationProgress(progress) {
        if(progress.targetSchema===30) throw Error("fixture-stop30");
      }})).toThrow("fixture-stop30");
      const db=new Database(file);db.prepare("INSERT OR REPLACE INTO bridge_meta VALUES(?,?)").run(key,value);
      db.pragma("journal_mode = DELETE");db.close();
      const before=readFileSync(file),names=readdirSync(root);
      let store:BridgeStateStore|undefined;
      try {expect(()=>{store=new BridgeStateStore({file});}).toThrow(/ACTIVATION_UNAVAILABLE/);}
      finally {store?.close();}
      expect(()=>prepareStateDatabaseOpen(file)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect(readFileSync(file)).toEqual(before);expect(readdirSync(root)).toEqual(names);
    } finally {rmSync(root,{recursive:true});}
  });
  test.each([
    '{"kind":"fresh","extra":{"kind":"a","k\\u0069nd":"b"}}',
    '{"kind":"fresh","extra":['+' '.repeat(64*1024)+']}',
    '{"kind":"fresh","extra":"\\ud800"}'
  ])("ambiguous or unbounded retained origin remains closed without normalization", origin => {
    const db=new Database(":memory:");
    try {
      db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA);db.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      db.prepare("INSERT INTO bridge_meta VALUES('state_schema_origin',?)").run(origin);
      expect(()=>assertCoGateUnifiedRuntimeAdmission(db)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect(db.prepare("SELECT value FROM bridge_meta").get()).toEqual({value:origin});
      expect(db.inTransaction).toBe(false);
    } finally {db.close();}
  });
  test.each(["80","eda080","c0af","ff"])("raw invalid UTF8 origin rejects both runtime paths without byte repair: %s", invalid => {
    const root=mkdtempSync(path.join(tmpdir(),"cogate-origin-bytes-")),file=path.join(root,"candidate.sqlite");
    try {
      new BridgeStateStore({file}).close();const db=new Database(file);
      const bytes=Buffer.concat([Buffer.from('{"kind":"fresh","extra":"'),Buffer.from(invalid,"hex"),Buffer.from('"}')]);
      db.prepare("UPDATE bridge_meta SET value=CAST(? AS TEXT) WHERE key='state_schema_origin'").run(bytes);
      db.pragma("journal_mode = DELETE");db.close();
      const before=readFileSync(file),names=readdirSync(root);
      for(const readOnly of [true,false]) {
        let store:BridgeStateStore|undefined;
        try {expect(()=>{store=new BridgeStateStore({file,readOnly});}).toThrow(/ACTIVATION_UNAVAILABLE/);}
        finally {store?.close();}
      }
      expect(()=>prepareStateDatabaseOpen(file)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect(readFileSync(file)).toEqual(before);expect(readdirSync(root)).toEqual(names);
    } finally {rmSync(root,{recursive:true});}
  });
  test.each(["UTF-8","UTF-16le","UTF-16be"])("valid ordinary origin accepts its actual SQLite encoding %s", encoding => {
    const db=new Database(":memory:");
    try {
      db.pragma(`encoding='${encoding}'`);db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA);
      db.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      const origin='{"kind":"fresh","extra":"日🌱"}';
      db.prepare("INSERT INTO bridge_meta VALUES('state_schema_origin',?)").run(origin);
      expect(()=>assertCoGateUnifiedRuntimeAdmission(db)).not.toThrow();
      expect(db.prepare("SELECT value FROM bridge_meta").get()).toEqual({value:origin});
    } finally {db.close();}
  });
  test.each([["UTF-16le","00d8"],["UTF-16be","d800"]])("invalid stored %s surrogate stays closed", (encoding,invalid) => {
    const db=new Database(":memory:");
    try {
      db.pragma(`encoding='${encoding}'`);db.exec(V31_COGATE_UNIFIED_MIGRATION_SCHEMA);
      db.exec("CREATE TABLE bridge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      const prefix=Buffer.from('{"kind":"fresh","extra":"',"utf16le"),suffix=Buffer.from('"}',"utf16le");
      if(encoding==="UTF-16be") {prefix.swap16();suffix.swap16();}
      const bytes=Buffer.concat([prefix,Buffer.from(invalid,"hex"),suffix]);
      db.prepare("INSERT INTO bridge_meta VALUES('state_schema_origin',CAST(? AS TEXT))").run(bytes);
      expect(()=>assertCoGateUnifiedRuntimeAdmission(db)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect((db.prepare("SELECT CAST(value AS BLOB) AS bytes FROM bridge_meta").get() as {bytes:Buffer}).bytes).toEqual(bytes);
    } finally {db.close();}
  });
  test.each(["duplicate","noncanonical-collation"])("ambiguous metadata %s blocks actual startup before lease or WAL changes", shape => {
    const root=mkdtempSync(path.join(tmpdir(),"cogate-origin-records-")),file=path.join(root,"candidate.sqlite");
    try {
      new BridgeStateStore({file}).close();const db=new Database(file);
      db.exec(`ALTER TABLE bridge_meta RENAME TO saved_meta;
        CREATE TABLE bridge_meta(key TEXT ${shape==="duplicate" ? "" : "COLLATE NOCASE PRIMARY KEY"},value TEXT NOT NULL) STRICT;
        INSERT INTO bridge_meta SELECT * FROM saved_meta;DROP TABLE saved_meta;`);
      if(shape==="duplicate") db.prepare("INSERT INTO bridge_meta VALUES('state_schema_origin',?)").run('{"kind":"lineage-conversion"}');
      else db.prepare("UPDATE bridge_meta SET key='STATE_SCHEMA_ORIGIN',value=? WHERE key='state_schema_origin'")
        .run('{"kind":"lineage-conversion"}');
      db.pragma("journal_mode = DELETE");db.close();
      const before=readFileSync(file),names=readdirSync(root);
      for(const readOnly of [true,false]) {
        let store:BridgeStateStore|undefined;
        try {expect(()=>{store=new BridgeStateStore({file,readOnly});}).toThrow(/ACTIVATION_UNAVAILABLE/);}
        finally {store?.close();}
      }
      expect(()=>prepareStateDatabaseOpen(file)).toThrow(/ACTIVATION_UNAVAILABLE/);
      expect(readFileSync(file)).toEqual(before);expect(readdirSync(root)).toEqual(names);
    } finally {rmSync(root,{recursive:true});}
  });
});
