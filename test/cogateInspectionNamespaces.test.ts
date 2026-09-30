import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { inspectCoGateLegacySource, inspectCoGateLegacyPreservation } from "../src/cogateLegacySource.js";
import { inspectCoGateLegacyProjection } from "../src/cogateLegacyProjection.js";
import { projectionFixture } from "./helpers/cogateProjectionFixtures.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { prepareStateDatabaseOpen } from "../src/stateDatabaseLifecycle.js";

const addedObjects = [
  "CREATE TABLE sqliteXunretained(value TEXT); INSERT INTO sqliteXunretained VALUES('{\"outcome\":\"UNKNOWN\"}')",
  "CREATE VIEW sqliteXunretained AS SELECT * FROM jobs",
  "CREATE INDEX sqliteXunretained ON jobs(job_id)",
  "CREATE TRIGGER sqliteXunretained AFTER INSERT ON jobs BEGIN SELECT 1; END"
];

describe("fixed CoGate main-schema inspection namespace", () => {
  for (const kind of ["source", "preservation", "projection"] as const) {
    test.each(addedObjects)(`${kind} rejects a wildcard-lookalike user object: %s`, sql => {
      const f = projectionFixture(), db = kind === "projection" ? f.target : f.source;
      try {
        db.exec(sql); const before = db.serialize();
        const inspect = () => kind === "source" ? inspectCoGateLegacySource(db) :
          kind === "preservation" ? inspectCoGateLegacyPreservation(db) :
          inspectCoGateLegacyProjection(db,f.ledger,f.conversionId);
        expect(inspect).toThrow(/schema objects|target schema/);
        expect(db.serialize()).toEqual(before); expect(db.inTransaction).toBe(false);
        expect(db.pragma("query_only",{simple:true})).toBe(0);
      } finally { f.close(); }
    });

    test.each(["jobs","bridge_meta","scopes","security_hmac_keys"])(
      `${kind} rejects a caller TEMP shadow of %s without altering it`, table => {
        const f = projectionFixture(), db = kind === "projection" ? f.target : f.source;
        try {
          db.exec(`CREATE TEMP TABLE "${table}" AS SELECT * FROM main."${table}"`);
          if (table === "jobs") db.exec(`UPDATE main.jobs SET payload='{"outcome":"PASS"}'`);
          const before = db.serialize(), shadow = db.prepare(`SELECT * FROM temp."${table}"`).all();
          const inspect = () => kind === "source" ? inspectCoGateLegacySource(db) :
            kind === "preservation" ? inspectCoGateLegacyPreservation(db) :
            inspectCoGateLegacyProjection(db,f.ledger,f.conversionId);
          expect(inspect).toThrow(/TEMP objects/);
          expect(db.serialize()).toEqual(before);
          expect(db.prepare(`SELECT * FROM temp."${table}"`).all()).toEqual(shadow);
          expect(db.inTransaction).toBe(false); expect(db.pragma("query_only",{simple:true})).toBe(0);
        } finally { f.close(); }
      }
    );

    test(`${kind} rejects TEMP masking on a real read-only file`, () => {
      const f = projectionFixture(), source = kind === "projection" ? f.target : f.source;
      const root = mkdtempSync(path.join(tmpdir(),"cogate-main-only-")), file = path.join(root,"synthetic.sqlite");
      try {
        source.exec(`UPDATE main.jobs SET payload='{"outcome":"PASS"}'`);
        writeFileSync(file,source.serialize(),{mode:0o600}); const before = readFileSync(file);
        const db = new Database(file,{readonly:true,fileMustExist:true});
        try {
          db.exec(`CREATE TEMP TABLE jobs AS SELECT * FROM main.jobs;
            UPDATE temp.jobs SET payload='{"outcome":"UNKNOWN"}'`);
          const inspect = () => kind === "source" ? inspectCoGateLegacySource(db) :
            kind === "preservation" ? inspectCoGateLegacyPreservation(db) :
            inspectCoGateLegacyProjection(db,f.ledger,f.conversionId);
          expect(inspect).toThrow(/TEMP objects/); expect(db.inTransaction).toBe(false);
          expect(db.prepare("SELECT payload FROM main.jobs").get()).toEqual({payload:'{"outcome":"PASS"}'});
          expect(db.prepare("SELECT payload FROM temp.jobs").get()).toEqual({payload:'{"outcome":"UNKNOWN"}'});
        } finally { db.close(); }
        expect(readFileSync(file)).toEqual(before);
      } finally { f.close(); rmSync(root,{recursive:true}); }
    });
  }

  test("schema31 startup detects a hidden-lookalike trigger before owner or state writes", () => {
    const root = mkdtempSync(path.join(tmpdir(),"cogate-storage-main-")), file = path.join(root,"synthetic.sqlite");
    try {
      new BridgeStateStore({file}).close();
      const db = new Database(file);
      db.exec("CREATE TRIGGER sqliteXunretained AFTER INSERT ON workspaces BEGIN SELECT 1; END");
      db.pragma("journal_mode = DELETE"); db.close(); const before = readFileSync(file);
      expect(() => prepareStateDatabaseOpen(file)).toThrow(/storage objects conflict/);
      expect(readFileSync(file)).toEqual(before);
    } finally { rmSync(root,{recursive:true}); }
  });
});
