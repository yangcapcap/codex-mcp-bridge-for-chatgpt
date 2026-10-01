import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { McpEventsController } from "../src/mcpEvents.js";
import { ScopeResolver, isMissingConversationScopeError } from "../src/scopeResolver.js";

afterEach(() => { vi.useRealTimers(); });

function controller(scopes: unknown): any {
  vi.useFakeTimers();
  return new McpEventsController(loadConfig({ CODEX_MCP_BRIDGE_NO_AUTH: "1" }),
    { subscribeChanges: () => () => {} } as any, scopes as ScopeResolver);
}

test("Events distinguishes genuine missing metadata from invalid metadata", () => {
  const c = controller(new ScopeResolver({ secret: new Uint8Array(32).fill(1) }));
  expect(() => c.requireOwnedScope({ mcpReq: {} }, "Events")).toThrow(expect.objectContaining({
    code: -32001, data: { reason: "missing_conversation_scope" }
  }));
  expect(() => c.requireOwnedScope({ mcpReq: { _meta: { "openai/session": 7 } } }, "Events")).toThrow(expect.objectContaining({
    code: -32001, data: { reason: "invalid_conversation_scope" }
  }));
});

test("missing-scope classification does not inspect a forged error", () => {
  let reads = 0;
  const raw = new Proxy({}, { get() { reads++; throw new Error("untrusted"); },
    getPrototypeOf() { reads++; throw new Error("untrusted"); } });
  expect(isMissingConversationScopeError(raw)).toBe(false);
  const c = controller({ require() { throw raw; } });
  expect(() => c.requireOwnedScope({ mcpReq: {} }, "Events")).toThrow(expect.objectContaining({
    code: -32001, data: { reason: "invalid_conversation_scope" }
  }));
  expect(reads).toBe(0);
  expect(c.retainedErrors.get("call-error:require")).toBe(raw);
});

test("scope delegate pin preserves uncertainty and prevents diagnostic normalization", () => {
  const raw = { original: "scope-failure" };
  let c: any;
  c = controller({ require() { c.pinNonforcingShutdown(); throw raw; } });
  expect(() => c.requireOwnedScope({ mcpReq: {} }, "Events")).toThrow("MCP_EVENTS_NONFORCING_PINNED");
  expect(c.retainedErrors.get("call-error:require")).toBe(raw);
  expect(c.observeNonforcingExit().outcome).toBe("uncertain");
});

test("a scope result accessor that pins prevents continuation and retains its result", () => {
  let reads = 0;
  let c: any;
  const scope = { get scopeId() { reads++; c.pinNonforcingShutdown(); return "scope"; } };
  c = controller({ require() { return scope; } });
  expect(() => c.requireOwnedScope({ mcpReq: {} }, "Events")).toThrow("MCP_EVENTS_NONFORCING_PINNED");
  expect(reads).toBe(1);
  expect(c.retainedErrors.get("conversation-scope")).toBe(scope);
  expect(c.observeNonforcingExit().outcome).toBe("uncertain");
});

test("an already pinned Events owner never delegates scope resolution", () => {
  const require = vi.fn();
  const c = controller({ require });
  c.pinNonforcingShutdown();
  expect(() => c.requireOwnedScope({ mcpReq: {} }, "Events")).toThrow("MCP_EVENTS_NONFORCING_PINNED");
  expect(require).not.toHaveBeenCalled();
});
