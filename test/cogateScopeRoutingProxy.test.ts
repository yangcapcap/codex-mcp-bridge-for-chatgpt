import { expect, test } from "vitest";
import { inspectCoGateScopeRouting } from "../src/cogateScopeRoutingRead.js";
import { legacyFixture } from "./helpers/cogateProjectionFixtures.js";

test("rejects Proxy identity before reflection can invoke user callbacks", () => {
  const db = legacyFixture(); const before = db.serialize(); let calls = 0;
  const proxy = new Proxy({ organization: null, subject: null, session: "fixture" }, {
    ownKeys(target) {
      calls++; db.prepare("INSERT INTO bridge_meta VALUES('proxy-write','UNKNOWN')").run();
      return Reflect.ownKeys(target);
    }
  });
  try {
    expect(() => inspectCoGateScopeRouting(db, proxy)).toThrow(/Proxy/);
    expect(calls).toBe(0); expect(db.serialize()).toEqual(before);
    expect(db.inTransaction).toBe(false); expect(db.pragma("query_only", { simple: true })).toBe(0);
  } finally { db.close(); }
});
test("rejects revoked proxies without invoking reflection", () => {
  const db = legacyFixture(); const { proxy, revoke } = Proxy.revocable({ organization: null, subject: null, session: "fixture" }, {});
  revoke(); try { expect(() => inspectCoGateScopeRouting(db, proxy)).toThrow(/Proxy/); }
  finally { db.close(); }
});
