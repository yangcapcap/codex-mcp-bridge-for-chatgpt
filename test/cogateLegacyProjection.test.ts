import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { inspectCoGateLegacyProjection } from "../src/cogateLegacyProjection.js";
import { projectionFixture } from "./helpers/cogateProjectionFixtures.js";

function withFixture(action: (fixture: ReturnType<typeof projectionFixture>) => void) {
  const fixture = projectionFixture();
  try { action(fixture); } finally { fixture.close(); }
}

describe("read-only legacy target projection evidence", () => {
  test("matches all retained bytes, UNKNOWN, modes and 64-bit sequence values without issuing authority", () => {
    withFixture(({ target, ledger, conversionId }) => {
      const before = target.serialize();
      const result = inspectCoGateLegacyProjection(target, ledger, conversionId);
      expect(result.matchedTables).toEqual(ledger.tables);
      expect(result).toMatchObject({ sourceTableCount: 42, authority: "none",
        approvalVerification: "not-performed", ownerVerification: "not-performed",
        targetInitializationVerification: "not-performed" });
      expect(JSON.stringify(result)).not.toContain("opaque");
      expect(JSON.stringify(result)).not.toContain(Buffer.alloc(32,1).toString("base64url"));
      expect(target.serialize()).toEqual(before);
      expect(target.inTransaction).toBe(false);
      expect(target.pragma("query_only", { simple: true })).toBe(0);
    });
  });

  test.each([
    ["invalid UTF-8", "UPDATE bridge_meta SET value=CAST(x'810080' AS TEXT) WHERE key='opaque_bytes'", /table bridge_meta/],
    ["UNKNOWN normalization", "UPDATE jobs SET payload='{\"outcome\":\"PASS\"}'", /table jobs/],
    ["large integer rounding", "UPDATE scopes SET version=9007199254740992", /table scopes/],
    ["sequence loss", "UPDATE sqlite_sequence SET seq=9007199254740992", /sequence/],
    ["unproven session owner", "UPDATE sessions SET auth_boundary='invented-owner'", /unproven owner/],
    ["fabricated completion", `INSERT INTO job_completion_deliveries(job_id,scope_id,terminal_version,
      receipt,state,created_at,updated_at) VALUES('fixture-job','fixture-scope',1,
        '${"x".repeat(75)}','host-accepted',0,0)`, /fabricated delivery/],
    ["fabricated command", `INSERT INTO operational_command_receipts(command_id,operation,
      payload_sha256,result,worker_generation,committed_at) VALUES(
        '${"a".repeat(36)}','invented','${"a".repeat(64)}','{}','${"b".repeat(36)}',0)`, /fabricated delivery/],
    ["extra unbound job", `INSERT INTO jobs(job_id,scope_id,request_id,activity_id,status,backend_kind,
      cwd,sandbox,created_at,updated_at,job_version,last_progress_at,payload)
      SELECT 'extra-job',scope_id,'extra-request',activity_id,status,backend_kind,cwd,sandbox,
        created_at,updated_at,job_version,last_progress_at,payload FROM jobs`, /unbound rows/],
    ["logical identity", "UPDATE bridge_meta SET value='other-logical-id' WHERE key='state_database_id'", /logical database/],
    ["schema label", "UPDATE bridge_meta SET value='30' WHERE key='schema_version'", /logical database/],
    ["schema shape", "CREATE TABLE unbound_state(value TEXT)", /target schema/]
  ])("rejects %s without modifying state", (_, sql, message) => {
    withFixture(({ target, ledger, conversionId }) => {
      target.exec(sql as string);
      const before = target.serialize();
      expect(() => inspectCoGateLegacyProjection(target, ledger, conversionId)).toThrow(message as RegExp);
      expect(target.serialize()).toEqual(before);
      expect(target.inTransaction).toBe(false);
      expect(target.pragma("query_only", { simple: true })).toBe(0);
    });
  });

  test("rejects extra archive rows bound to another conversion", () => {
    withFixture(({target,ledger,conversionId}) => {
      target.prepare(`INSERT INTO cogate_lineage_conversions VALUES
        (?,'cogate-lineage-conversion/v1',?,'cogate-v2-workspace-hmac/schema21/v1',21,31,
          ?,?,?,?,?,?,?,'2026-10-01T00:00:00Z','{}')`)
        .run("other-conversion","other-logical-id",...Array(7).fill("a".repeat(64)));
      expect(() => inspectCoGateLegacyProjection(target,ledger,conversionId)).toThrow(/another conversion/);
    });
  });

  test.each(["UTF-16le","UTF-16be"])("preserves original SQLite %s text encoding", encoding => {
    const fixture = projectionFixture({ encoding });
    try { expect(inspectCoGateLegacyProjection(fixture.target,fixture.ledger,fixture.conversionId)
      .matchedTables).toEqual(fixture.ledger.tables); } finally { fixture.close(); }
  });

  test.each([
    { mode: "missing" as const }, { mode: "changed" as const }, { mode: "orphan" as const },
    { metadata: "missing" as const }, { metadata: "unexpected" as const }
  ])("rejects incomplete or conflicting archival evidence: %j", options => {
    const fixture = projectionFixture(options);
    try {
      const before = fixture.target.serialize();
      expect(() => inspectCoGateLegacyProjection(fixture.target,fixture.ledger,fixture.conversionId))
        .toThrow(/preserve table|orphan execution-mode|unexpected metadata/);
      expect(fixture.target.serialize()).toEqual(before);
    } finally { fixture.close(); }
  });

  test("accepts a private read-only file and rejects its writable handle before snapshot setup", () => {
    withFixture(({ target, ledger, conversionId }) => {
      const root = mkdtempSync(path.join(tmpdir(),"cogate-projection-")), file = path.join(root,"synthetic.sqlite");
      writeFileSync(file,target.serialize(),{mode:0o600}); const before = readFileSync(file);
      try {
        const writable = new Database(file);
        try {
          const pragma = vi.spyOn(writable,"pragma"), exec = vi.spyOn(writable,"exec");
          expect(() => inspectCoGateLegacyProjection(writable,ledger,conversionId)).toThrow(/idle read-only/);
          expect(pragma).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
        } finally { writable.close(); }
        const readonly = new Database(file,{readonly:true,fileMustExist:true});
        try { expect(inspectCoGateLegacyProjection(readonly,ledger,conversionId).matchedTables).toEqual(ledger.tables); }
        finally { readonly.close(); }
        expect(readFileSync(file)).toEqual(before);
      } finally { rmSync(root,{recursive:true}); }
    });
  });

  test("rejects mismatched conversion identity and tampered source evidence", () => {
    withFixture(({ target, ledger, conversionId }) => {
      expect(() => inspectCoGateLegacyProjection(target, ledger, "other-conversion")).toThrow(/typed content binding/);
      const tampered = structuredClone(ledger); tampered.tables[0]!.rowCount += 1;
      expect(() => inspectCoGateLegacyProjection(target, tampered, conversionId)).toThrow(/source ledger/);
      const { preservationSha256: _, ...evidence } = tampered;
      tampered.preservationSha256 = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
      expect(() => inspectCoGateLegacyProjection(target, tampered, conversionId)).toThrow(/typed content binding/);
    });
  });

  test("leaves a caller transaction and query-only setting unchanged", () => {
    withFixture(({ target, ledger, conversionId }) => {
      target.pragma("query_only = ON"); target.exec("BEGIN");
      expect(() => inspectCoGateLegacyProjection(target, ledger, conversionId)).toThrow(/idle read-only/);
      expect(target.inTransaction).toBe(true);
      expect(target.pragma("query_only", { simple: true })).toBe(1);
      target.exec("ROLLBACK");
      expect(inspectCoGateLegacyProjection(target, ledger, conversionId).authority).toBe("none");
      expect(target.pragma("query_only", { simple: true })).toBe(1);
    });
  });

  test.each([0,1])("restores query-only=%i after setup and rollback failures", initial => {
    for (const phase of ["enable-after","begin-before","begin-after","rollback-before","rollback-after"]) {
      withFixture(({ target, ledger, conversionId }) => {
        target.pragma(`query_only = ${initial ? "ON" : "OFF"}`);
        const before = target.serialize(), exec = target.exec.bind(target), pragma = target.pragma.bind(target);
        let injected = false;
        const execution = vi.spyOn(target,"exec").mockImplementation(sql => {
          if ((phase.startsWith("begin-") && sql === "BEGIN") ||
              (phase.startsWith("rollback-") && sql === "ROLLBACK")) {
            injected = true; if (phase.endsWith("after")) exec(sql); throw new Error(`injected-${phase}`);
          } return exec(sql);
        });
        const setting = vi.spyOn(target,"pragma").mockImplementation((sql,options) => {
          const result = pragma(sql,options);
          if (phase === "enable-after" && sql === "query_only = ON" && !injected) {
            injected = true; throw new Error(`injected-${phase}`);
          } return result;
        });
        try {
          expect(() => inspectCoGateLegacyProjection(target,ledger,conversionId)).toThrow(`injected-${phase}`);
          expect(injected).toBe(true); expect(pragma("query_only",{simple:true})).toBe(initial);
          expect(target.inTransaction).toBe(phase === "rollback-before");
          expect(target.serialize()).toEqual(before);
        } finally {
          execution.mockRestore(); setting.mockRestore(); if (target.inTransaction) exec("ROLLBACK");
        }
      });
    }
  });
});
