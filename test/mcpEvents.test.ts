import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Webhook } from "standardwebhooks";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { ScopeResolver } from "../src/scopeResolver.js";
import { JOB_TERMINAL_EVENT } from "../src/mcpEventStore.js";
import { mcpBearerPrincipal } from "../src/mcpEvents.js";
import { EventDestinationVault, publicAddress, signedHeaders, validateCallbackUrl, validateSigningSecret, type WebhookSender } from "../src/mcpWebhook.js";
import { FOLLOWUP_ID_PATTERN, issueApprovedFollowups, promptDigest } from "../src/taskFollowups.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import type { CodexModelCatalogProvider } from "../src/modelCatalog.js";

const token = randomBytes(32).toString("hex");
const secret = "whsec_" + randomBytes(32).toString("base64");
const meta = { "openai/session": "issue-213-original", "openai/subject": "test-account" };
const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const catalog: CodexModelCatalogProvider = {
  getCatalog: async () => ({ source: "codex-cli", fetchedAt: new Date().toISOString(), fingerprint: "a".repeat(64), cached: false,
    stale: false, validation: "valid", models: [{ id: selection.model, displayName: "Fixture", defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [], inputModalities: ["text"] }] })
};

class Upstream implements CodexUpstream {
  calls = 0;
  private held?: Promise<void>;
  hold(): () => void {
    let release!: () => void;
    this.held = new Promise<void>(resolve => { release = resolve; });
    return release;
  }
  async listTools() { return { tools: [{ name: "codex" }] }; }
  async callTool(_name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls += 1;
    if (this.held) { const held = this.held; this.held = undefined; await held; }
    return { structuredContent: { threadId: args.threadId || randomUUID(), content: "Reviewed fixture result." },
      content: [{ type: "text", text: "Reviewed fixture result." }] };
  }
  async close() {}
}

type Fixture = Awaited<ReturnType<typeof start>>;
const fixtures: Array<{ root: string; state: BridgeStateStore; server: BridgeHttpServer; client: Client }> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.client.close();
    await new Promise<void>(resolve => f.server.close(() => resolve()));
    f.state.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function start(sender?: WebhookSender, noAuth = false, database?: { root: string; state: BridgeStateStore }, upstream = new Upstream()) {
  const root = database?.root || await mkdtemp(path.join(tmpdir(), "issue-213-"));
  const state = database?.state || new BridgeStateStore({ file: path.join(root, "state.sqlite") });
  const config = loadConfig({ CODEX_MCP_BRIDGE_TOKEN: token, CODEX_MCP_BRIDGE_NO_AUTH: noAuth ? "1" : "0",
    CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1", CODEX_MCP_BRIDGE_ROOTS: root,
    CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite") });
  const settings = new UserSettingsStore(config, { stateStore: state });
  if (!database) {
    settings.update({ modelPolicy: { mode: "automatic", constraints: { allowDelegation: false },
      allowedSelections: { kind: "explicit", selections: [selection] } } }, settings.current.revision);
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Fixture", cwd: root } }], undefined, settings.current.registryRevision);
  }
  const deliveries: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const send: WebhookSender = sender || (async (url, raw, headers) => {
    new Webhook(secret).verify(raw, headers);
    const body = JSON.parse(raw);
    deliveries.push({ url, body, headers });
    return { status: 200, body: JSON.stringify(body.type === "verification" ? { challenge: body.challenge } : {}) };
  });
  const server = createHttpServer(config, upstream, catalog, { stateStore: state, eventWebhookSender: send });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const client = new Client({ name: "issue-213", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const fixture = { root, state, config, settings, server, client, url, deliveries, upstream };
  fixtures.push(fixture);
  return fixture;
}

async function rpc(f: Fixture, method: string, params: Record<string, unknown> = {}, metadata = meta) {
  const response = await fetch(f.url, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json",
    "mcp-protocol-version": "2026-07-28", "mcp-method": method
  }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { ...params, _meta: { ...metadata,
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "issue-213", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  return response.json() as Promise<any>;
}

function subscription(jobId: string, replacements: Record<string, unknown> = {}) {
  return { name: JOB_TERMINAL_EVENT, arguments: { jobId },
    delivery: { mode: "webhook", url: "https://receiver.example.com/mcp-events/test", secret }, cursor: null, ...replacements };
}

async function task(f: Fixture, extra: Record<string, unknown> = {}, metadata = meta) {
  const descriptors = (await f.client.listTools()).tools;
  const properties = descriptors.find(tool => tool.name === "codex_task")!.inputSchema.properties as Record<string, { const?: string }>;
  const selector = f.settings.current.projects[0]!;
  const result = await f.client.callTool({ name: "codex_task", _meta: metadata, arguments: {
    requestId: randomUUID(), taskContractVersion: properties.taskContractVersion.const,
    executionEnvelopeRef: properties.executionEnvelopeRef.const, prompt: "Read fixture A", selection,
    project: { name: selector.name, projectRef: selector.projectRef, projectRevision: selector.projectRevision },
    ...extra
  } });
  if (!result.structuredContent) throw new Error(JSON.stringify(result));
  return result.structuredContent as any;
}

async function completed(f: Fixture, jobId: string) {
  await vi.waitFor(() => expect((f.state.listJobs().find((job: any) => job.jobId === jobId) as any)?.status).toBe("completed"));
  const result = await f.client.callTool({ name: "codex_status", _meta: meta, arguments: { query: { kind: "job", id: jobId } } });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as any;
}

describe("MCP Events exact-Job lifecycle", () => {
  it("subscribes before completion and commits result plus delivery intent atomically", async () => {
    const upstream = new Upstream();
    const release = upstream.hold();
    const f = await start(undefined, false, undefined, upstream);
    const a = await task(f);
    const sub = await rpc(f, "events/subscribe", subscription(a.jobId));
    expect(sub.error).toBeUndefined();
    expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.delivery).toBe("waiting");
    expect(f.deliveries.filter(item => item.body.eventId)).toHaveLength(0);
    release();
    await completed(f, a.jobId);
    await vi.waitFor(() => expect(f.deliveries.filter(item => item.body.eventId)).toHaveLength(1));
    expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.event?.data.state).toBe("completed");
    expect(upstream.calls).toBe(1);
  });

  it("rolls back a terminal result and its delivery intent together after a storage failure", async () => {
    const upstream = new Upstream(); const release = upstream.hold();
    const f = await start(undefined, false, undefined, upstream);
    const a = await task(f);
    const sub = await rpc(f, "events/subscribe", subscription(a.jobId));
    const before = f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any;
    const candidate = { ...before, status: "completed", updatedAt: Date.now(), version: before.version + 1,
      result: { content: [{ type: "text", text: "Original retained result" }] } };
    const save = f.state.setMeta.bind(f.state);
    const fault = vi.spyOn(f.state, "setMeta").mockImplementation((key, value) => {
      if (key.startsWith("mcp_events_v1/")) throw new Error("isolated storage fault");
      save(key, value);
    });
    expect(() => f.state.upsertJob(candidate)).toThrow("isolated storage fault");
    expect((f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any).status).toBe("running");
    expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.event).toBeUndefined();
    fault.mockRestore();
    f.state.upsertJob(candidate);
    expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.event?.data.state).toBe("completed");
    release(); await completed(f, a.jobId);
    expect(upstream.calls).toBe(1);
  });

  it("discovers the extension and late-subscribes to one durable exact result without leaking its content", async () => {
    const f = await start();
    const discover = await rpc(f, "server/discover");
    expect(discover.result.capabilities.events).toEqual({});
    const definitions = await rpc(f, "events/list");
    expect(definitions.error).toBeUndefined();
    expect(definitions.result.events[0].name).toBe(JOB_TERMINAL_EVENT);
    const a = await task(f);
    expect(a.jobId).toBeTruthy();
    await completed(f, a.jobId);
    const response = await rpc(f, "events/subscribe", subscription(a.jobId));
    expect(response.error).toBeUndefined();
    expect(response.result.id).toMatch(/^sub_/);
    expect(f.state.mcpEvents.get(a.jobId, response.result.id)?.event).toBeTruthy();
    await vi.waitFor(() => expect(f.deliveries.filter(item => item.body.eventId)).toHaveLength(1));
    const event = f.deliveries.find(item => item.body.eventId)!.body;
    expect(event.data.result).toEqual({ tool: "codex_status", query: { kind: "job", id: a.jobId } });
    expect(JSON.stringify(event)).not.toContain("Reviewed fixture result");
    expect(f.state.mcpEvents.get(a.jobId, response.result.id)?.delivery).toBe("acknowledged");
    expect(f.state.retentionProtection(a.jobId)).toContain("mcp-event-result-recovery");
    const encoded = JSON.stringify(f.state.listMeta("mcp_events_v1/", 256));
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("receiver.example.com");
    const repeat = await rpc(f, "events/subscribe", subscription(a.jobId));
    expect(repeat.result.id).toBe(response.result.id);
    expect(f.deliveries.filter(item => item.body.type === "verification")).toHaveLength(1);
    const stopParams = subscription(a.jobId) as any;
    delete stopParams.delivery.secret; delete stopParams.cursor;
    expect((await rpc(f, "events/unsubscribe", stopParams)).error).toBeUndefined();
    expect((await rpc(f, "events/unsubscribe", stopParams)).error).toBeUndefined();
    expect(f.state.mcpEvents.get(a.jobId, response.result.id)?.disabled).toBe("unsubscribed");
    expect((f.state.listJobs()[0] as any).status).toBe("completed");
  });

  it("rejects foreign conversations, unauthenticated No Auth metadata and failed callback challenges", async () => {
    const f = await start();
    const a = await task(f);
    await completed(f, a.jobId);
    const foreign = await rpc(f, "events/subscribe", subscription(a.jobId), { ...meta, "openai/session": "foreign" });
    expect(foreign.error.code).toBe(-32001);
    expect(f.deliveries).toHaveLength(0);
    const unauthenticated = await start(undefined, true);
    expect((await rpc(unauthenticated, "events/list")).error.code).toBe(-32001);
    const failed = await start(async () => ({ status: 200, body: JSON.stringify({ challenge: "wrong" }) }));
    const b = await task(failed); await completed(failed, b.jobId);
    const invalid = await rpc(failed, "events/subscribe", subscription(b.jobId));
    expect(invalid.error).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });
    expect(failed.state.mcpEvents.list()).toHaveLength(0);
  });

  it("does not reactivate a new subscription when unsubscribe races callback verification", async () => {
    let release!: () => void; let began!: () => void;
    const begin = new Promise<void>(resolve => { began = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await start(async (_url, raw) => {
      const body = JSON.parse(raw); began(); await gate;
      return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
    });
    const a = await task(f); await completed(f, a.jobId);
    const subscribe = rpc(f, "events/subscribe", subscription(a.jobId));
    await begin;
    const stop = subscription(a.jobId) as any; delete stop.delivery.secret; delete stop.cursor;
    expect((await rpc(f, "events/unsubscribe", stop)).error).toBeUndefined();
    release();
    expect((await subscribe).error.data.reason).toBe("subscription_changed");
    expect(f.state.mcpEvents.list()).toHaveLength(0);
  });

  it("refreshes a finite lifetime and signs with both verified keys during rotation", async () => {
    const next = "whsec_" + randomBytes(32).toString("base64");
    const sent: Array<{ body: any; headers: Record<string, string>; raw: string }> = [];
    const f = await start(async (_url, raw, headers) => {
      const body = JSON.parse(raw); sent.push({ body, headers, raw });
      return { status: 200, body: JSON.stringify(body.type === "verification" ? { challenge: body.challenge } : {}) };
    });
    const a = await task(f); await completed(f, a.jobId);
    const first = await rpc(f, "events/subscribe", subscription(a.jobId, { ttlMs: 10 }));
    const rotated = await rpc(f, "events/subscribe", subscription(a.jobId, {
      ttlMs: null, delivery: { mode: "webhook", url: "https://receiver.example.com/mcp-events/test", secret: next }
    }));
    expect(rotated.result.id).toBe(first.result.id);
    expect(Date.parse(rotated.result.refreshBefore)).toBeGreaterThan(Date.parse(first.result.refreshBefore));
    expect(rotated.result.refreshBefore).not.toBeNull();
    const record = f.state.mcpEvents.get(a.jobId, first.result.id)!;
    const vault = new EventDestinationVault(token);
    expect(vault.open(record.id, record.destination).previousSecret).toBe(secret);
    // Exercise the next delivery with the replacement secret; the identity and
    // event ID remain unchanged when a send response was lost.
    record.delivery = "pending"; record.nextAttemptAt = 0; f.state.mcpEvents.save(record);
    await rpc(f, "events/subscribe", subscription(a.jobId, { delivery: { mode: "webhook", url: "https://receiver.example.com/mcp-events/test", secret: next } }));
    await vi.waitFor(() => expect(sent.filter(item => item.body.eventId).some(item => item.headers["webhook-signature"].split(" ").length === 2)).toBe(true));
    const dual = sent.filter(item => item.body.eventId).find(item => item.headers["webhook-signature"].split(" ").length === 2)!;
    expect(new Webhook(secret).verify(dual.raw, dual.headers)).toBeTruthy();
    expect(new Webhook(next).verify(dual.raw, dual.headers)).toBeTruthy();
  });

  it("bounds exhausted attempts and denies refresh when project access is revoked", async () => {
    const f = await start(async (_url, raw) => {
      const body = JSON.parse(raw); return body.type === "verification"
        ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : { status: 503, body: "" };
    });
    const a = await task(f); await completed(f, a.jobId);
    const sub = await rpc(f, "events/subscribe", subscription(a.jobId));
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.attempts).toBe(1));
    const record = f.state.mcpEvents.get(a.jobId, sub.result.id)!;
    record.attempts = 8; record.nextAttemptAt = 0; f.state.mcpEvents.save(record);
    await rpc(f, "events/subscribe", subscription(a.jobId));
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.delivery).toBe("failed"));
    expect(f.upstream.calls).toBe(1);
    expect(f.state.retentionProtection(a.jobId)).toContain("mcp-event-result-recovery");
    vi.spyOn(f.state, "isEventProjectAvailable").mockReturnValue(false);
    expect((await rpc(f, "events/subscribe", subscription(a.jobId))).error.code).toBe(-32001);
    vi.restoreAllMocks();
  });

  it("revokes pending delivery when project access is withdrawn", async () => {
    const ids: string[] = [];
    const f = await start(async (_url, raw) => {
      const body = JSON.parse(raw);
      if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
      ids.push(body.eventId); return { status: 503, body: "" };
    });
    const a = await task(f); await completed(f, a.jobId);
    const sub = await rpc(f, "events/subscribe", subscription(a.jobId));
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.attempts).toBe(1));
    vi.spyOn(f.state, "isEventProjectAvailable").mockReturnValue(false);
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.disabled).toBe("revoked"), { timeout: 5_000 });
    expect(ids).toHaveLength(1); expect(f.upstream.calls).toBe(1);
    expect(f.state.retentionProtection(a.jobId)).toContain("mcp-event-result-recovery");
  });

  it("keeps pending delivery recoverable when an authorization state read temporarily fails", async () => {
    const f = await start();
    const a = await task(f); await completed(f, a.jobId);
    const lookup = f.state.isEventProjectAvailable.bind(f.state);
    let reads = 0;
    vi.spyOn(f.state, "isEventProjectAvailable").mockImplementation(projectId => {
      if (++reads === 3) throw new Error("isolated state read unavailable");
      return lookup(projectId);
    });
    const sub = await rpc(f, "events/subscribe", subscription(a.jobId));
    expect(sub.error).toBeUndefined();
    await vi.waitFor(() => expect(reads).toBe(3));
    const pending = f.state.mcpEvents.get(a.jobId, sub.result.id)!;
    expect(pending.disabled).toBeUndefined(); expect(pending.attempts).toBe(0);
    expect(f.deliveries.filter(item => item.body.eventId)).toHaveLength(0);
    expect((await rpc(f, "events/subscribe", subscription(a.jobId))).error).toBeUndefined();
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.delivery).toBe("acknowledged"));
    expect(f.deliveries.filter(item => item.body.eventId)).toHaveLength(1);
    expect(f.upstream.calls).toBe(1);
  });

  it("keeps one logical event across retries, expires delivery without cancelling work, and does not retry 410 or 413", async () => {
    for (const status of [410, 413, 500]) {
      const ids: string[] = [];
      const f = await start(async (_url, raw) => {
        const body = JSON.parse(raw);
        if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
        ids.push(body.eventId); return { status, body: "" };
      });
      const a = await task(f); await completed(f, a.jobId);
      const sub = await rpc(f, "events/subscribe", subscription(a.jobId, { ttlMs: 60_000 }));
      await vi.waitFor(() => expect(ids).toHaveLength(1));
      const record = f.state.mcpEvents.get(a.jobId, sub.result.id)!;
      expect(record.delivery).toBe(status === 500 ? "pending" : "failed");
      if (status === 500) {
        record.nextAttemptAt = 0; f.state.mcpEvents.save(record);
        await rpc(f, "events/subscribe", subscription(a.jobId));
        await vi.waitFor(() => expect(ids).toHaveLength(2));
        expect(ids[0]).toBe(ids[1]);
      }
      record.expiresAt = Date.now() - 1; f.state.mcpEvents.save(record);
      expect((f.state.listJobs()[0] as any).status).toBe("completed");
    }
  });

  it("recovers the persisted delivery after restart and keeps exact-result retrieval scope checks", async () => {
    const f = await start(async (_url, raw) => {
      const body = JSON.parse(raw);
      return body.type === "verification" ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : { status: 503, body: "" };
    });
    const a = await task(f); await completed(f, a.jobId);
    const sub = await rpc(f, "events/subscribe", subscription(a.jobId));
    await vi.waitFor(() => expect(f.state.mcpEvents.get(a.jobId, sub.result.id)?.attempts).toBe(1));
    const id = f.state.mcpEvents.get(a.jobId, sub.result.id)!.event!.eventId;
    await f.client.close(); await new Promise<void>(resolve => f.server.close(() => resolve())); f.state.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    const reopened = new BridgeStateStore({ file: path.join(f.root, "state.sqlite") });
    const pending = reopened.mcpEvents.get(a.jobId, sub.result.id)!;
    pending.nextAttemptAt = 0; reopened.mcpEvents.save(pending);
    const restarted = await start(undefined, false, { root: f.root, state: reopened });
    await vi.waitFor(() => expect(restarted.deliveries.find(item => item.body.eventId)?.body.eventId).toBe(id));
    expect(restarted.upstream.calls).toBe(0);
    const foreign = await restarted.client.callTool({ name: "codex_status", _meta: { ...meta, "openai/session": "foreign" },
      arguments: { query: { kind: "job", id: a.jobId } } });
    expect(foreign.isError).toBe(true);
  });
});

describe("pre-approved followup admission across GPT runs", () => {
  it("recovers issued references from an exact A read and its event after admission response loss", async () => {
    const upstream = new Upstream(); const release = upstream.hold();
    const f = await start(undefined, false, undefined, upstream);
    const requestId = randomUUID();
    const approvedFollowups = [{ prompt: "Read fixture B" }, { prompt: "Read fixture C" }];
    const admitted = await task(f, { requestId, approvedFollowups });
    const expected = admitted.approvedFollowups;
    const replay = await task(f, { requestId, approvedFollowups });
    expect(replay.jobId).toBe(admitted.jobId); expect(replay.approvedFollowups).toEqual(expected);
    expect(new Set(expected.map((step: any) => step.followupId)).size).toBe(2);
    const sub = await rpc(f, "events/subscribe", subscription(admitted.jobId));
    release();
    const status = await completed(f, admitted.jobId);
    expect(status.items.find((item: any) => item.id === admitted.jobId).approvedFollowups).toEqual(expected);
    await vi.waitFor(() => expect(f.state.mcpEvents.get(admitted.jobId, sub.result.id)?.delivery).toBe("acknowledged"));
    const event = f.deliveries.find(item => item.body.eventId)!.body;
    expect(event.data.availableFollowups).toEqual(expected.map(({ followupId }: any) => ({ followupId })));
    expect(JSON.stringify(event)).not.toContain("Read fixture B");
    expect(JSON.stringify(event)).not.toContain("stepId");
    await f.client.close(); await new Promise<void>(resolve => f.server.close(() => resolve())); f.state.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    const restarted = await start(undefined, false, { root: f.root, state: new BridgeStateStore({ file: path.join(f.root, "state.sqlite") }) });
    const recovered = await completed(restarted, admitted.jobId);
    const reference = recovered.items.find((item: any) => item.id === admitted.jobId).approvedFollowups[0];
    expect(reference).toEqual(expected[0]);
    const b = await task(restarted, { requestId: reference.requestId, project: undefined, selection: undefined,
      prompt: approvedFollowups[0].prompt, followup: { followupId: reference.followupId, reviewedVersion: recovered.items[0].versions.job } });
    expect(b.error).toBeNull(); expect(b.requestId).toBe(reference.requestId);
    await completed(restarted, b.jobId); expect(restarted.upstream.calls).toBe(1);
  });

  it("rejects caller-issued stage identifiers and rolls back an uncommitted issued reference", async () => {
    const f = await start();
    for (const override of [{ stepId: "caller-B" }, { followupId: "fup_" + "1".repeat(96) }]) {
      await expect(task(f, { approvedFollowups: [{ prompt: "Read fixture B", ...override }] })).rejects.toThrow();
    }
    expect(f.state.listJobs()).toHaveLength(0); expect(f.upstream.calls).toBe(0);
    const save = f.state.setMeta.bind(f.state);
    const fault = vi.spyOn(f.state, "setMeta").mockImplementation((key, value) => {
      if (key.startsWith("task_followup_v1/")) throw new Error("isolated approval receipt failure");
      save(key, value);
    });
    const requestId = randomUUID(); const approvedFollowups = [{ prompt: "Read fixture B" }];
    const failed = await task(f, { requestId, approvedFollowups });
    expect(failed.error).not.toBeNull();
    expect(f.state.listJobs()).toHaveLength(0); expect(f.state.listMeta("task_followup_v1/", 8)).toHaveLength(0);
    expect(f.upstream.calls).toBe(0);
    fault.mockRestore();
    const a = await task(f, { requestId, approvedFollowups });
    expect(a.error).toBeNull(); expect(a.approvedFollowups[0].followupId).toMatch(FOLLOWUP_ID_PATTERN);
    await completed(f, a.jobId); expect(f.upstream.calls).toBe(1);
  });

  it("keeps separately approved identical prompts distinct while deduplicating each issued reference", async () => {
    const f = await start();
    const a = await task(f, { approvedFollowups: [{ prompt: "Read fixture B" }, { prompt: "Read fixture B" }] });
    await completed(f, a.jobId);
    const parent = f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any;
    const results: string[] = [];
    for (const reference of a.approvedFollowups) {
      const input = { project: undefined, selection: undefined, requestId: reference.requestId, prompt: "Read fixture B",
        followup: { followupId: reference.followupId, reviewedVersion: parent.version } };
      const b = await task(f, input); expect(b.error).toBeNull();
      const retry = await task(f, { ...input, requestId: randomUUID() });
      expect(retry.jobId).toBe(b.jobId); results.push(b.jobId); await completed(f, b.jobId);
    }
    expect(new Set(results).size).toBe(2); expect(f.upstream.calls).toBe(3);
  });

  it("preserves a retained v1 approval's canonical request receipt during upgrade", async () => {
    const f = await start();
    const a = await task(f, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    await completed(f, a.jobId);
    const parent = f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any;
    const modern = f.state.taskFollowups.get(a.approvedFollowups[0].followupId)!;
    const legacyStep = { stepId: "legacy-B", promptSha256: promptDigest("Read fixture B") };
    const followupId = issueApprovedFollowups(a.jobId, [legacyStep])![0]!.followupId!;
    const bytes = createHash("sha1").update("codex-mcp-bridge/followup/v1\0" + JSON.stringify([parent.scopeId, a.jobId, legacyStep.stepId])).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 0x50; bytes[8] = (bytes[8]! & 63) | 0x80;
    const hex = bytes.toString("hex");
    const legacyRequestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    f.state.deleteMeta(`task_followup_v1/${a.jobId}/${modern.followupId.slice(36)}`);
    f.state.setMeta(`task_followup_v1/${a.jobId}/${createHash("sha256").update(legacyStep.stepId).digest("hex")}`,
      JSON.stringify({ ...modern, ...legacyStep, followupId: undefined, requestId: legacyRequestId }));
    f.state.upsertJob({ ...parent, approvedFollowups: [legacyStep] });
    await f.client.close(); await new Promise<void>(resolve => f.server.close(() => resolve())); f.state.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    const restarted = await start(undefined, false, { root: f.root, state: new BridgeStateStore({ file: path.join(f.root, "state.sqlite") }) });
    const status = await completed(restarted, a.jobId);
    const reference = status.items.find((item: any) => item.id === a.jobId).approvedFollowups[0];
    expect(reference).toEqual({ followupId, requestId: legacyRequestId, status: "approved-pending" });
    const input = { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId, reviewedVersion: parent.version } };
    const [b, retry] = await Promise.all([task(restarted, input), task(restarted, input)]);
    expect(b.error).toBeNull(); expect(b.requestId).toBe(legacyRequestId); expect(retry.jobId).toBe(b.jobId);
    await completed(restarted, b.jobId); expect(restarted.upstream.calls).toBe(1);
  });

  it("converges duplicate callers, response loss and restart to exactly one approved B", async () => {
    const f = await start();
    const a = await task(f, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    expect(a.jobId).toBeTruthy();
    const followupId = a.approvedFollowups[0].followupId;
    expect(followupId).toMatch(FOLLOWUP_ID_PATTERN);
    expect(a.approvedFollowups[0].status).toBe("approved-pending");
    const rejectedBeforeReview = await task(f, { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId, reviewedVersion: 1 } });
    expect(rejectedBeforeReview.error.code).toBe("FOLLOWUP_REVIEW_REQUIRED");
    const status = await completed(f, a.jobId);
    expect(status.items.find((item: any) => item.id === a.jobId).approvedFollowups).toEqual(a.approvedFollowups);
    const parent = f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any;
    expect(f.state.getJobCompletionDelivery(a.jobId)?.directResultOfferedAt).toBeTruthy();
    expect(JSON.stringify(f.state.listMeta("task_followup_v1/", 256))).not.toContain("Read fixture B");
    const input = { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId, reviewedVersion: parent.version } };
    const [b, duplicate] = await Promise.all([task(f, input), task(f, input)]);
    expect(b.error).toBeNull(); expect(duplicate.error).toBeNull();
    expect(b.jobId).toBe(duplicate.jobId);
    const replay = await task(f, input);
    expect(replay.jobId).toBe(b.jobId); expect(replay.requestId).toBe(b.requestId);
    expect(b.requestId).toBe(a.approvedFollowups[0].requestId);
    await completed(f, b.jobId);
    expect(f.upstream.calls).toBe(2);
    expect(f.state.taskFollowups.get(followupId)?.admittedJobId).toBe(b.jobId);
    const altered = await task(f, { ...input, prompt: "Unauthorized different task" });
    expect(altered.error.code).toBe("FOLLOWUP_NOT_APPROVED");
    expect(f.upstream.calls).toBe(2);
  });

  it("never admits unapproved B or authorizes a step from another conversation", async () => {
    const f = await start();
    const a = await task(f); await completed(f, a.jobId);
    const b = await task(f, { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId: "fup_" + "0".repeat(96), reviewedVersion: 2 } });
    expect(b.error.code).toBe("FOLLOWUP_NOT_APPROVED"); expect(f.upstream.calls).toBe(1);
  });

  it("rejects unrelated work occupying the approved step's canonical requestId", async () => {
    const f = await start();
    const a = await task(f, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    const followupId = a.approvedFollowups[0].followupId;
    await completed(f, a.jobId);
    const parent = f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any;
    const reserved = a.approvedFollowups[0].requestId;
    const other = await task(f, { requestId: reserved, prompt: "Unrelated approved work" });
    await completed(f, other.jobId);
    const b = await task(f, { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId, reviewedVersion: parent.version } });
    expect(b.error.code).toBe("FOLLOWUP_ADMISSION_CONFLICT");
    expect(f.state.taskFollowups.get(followupId)?.admittedJobId).toBeUndefined();
    expect(f.upstream.calls).toBe(2);
  });

  it("recovers one admitted B after a response is lost and the bridge restarts", async () => {
    const f = await start();
    const a = await task(f, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    const followupId = a.approvedFollowups[0].followupId;
    await completed(f, a.jobId);
    const parent = f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any;
    const input = { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId, reviewedVersion: parent.version } };
    const b = await task(f, input); await completed(f, b.jobId);
    await f.client.close(); await new Promise<void>(resolve => f.server.close(() => resolve())); f.state.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    const restarted = await start(undefined, false, { root: f.root, state: new BridgeStateStore({ file: path.join(f.root, "state.sqlite") }) });
    const recoveredA = await completed(restarted, a.jobId);
    const recoveredReference = recoveredA.items.find((item: any) => item.id === a.jobId).approvedFollowups[0];
    expect(recoveredReference).toMatchObject({ followupId, status: "admitted", requestId: b.requestId });
    const recovery = await task(restarted, input);
    expect(recovery.jobId).toBe(b.jobId); expect(recovery.requestId).toBe(b.requestId);
    expect(restarted.upstream.calls).toBe(0);
    const foreign = await task(restarted, input, { ...meta, "openai/session": "foreign" });
    expect(foreign.error.code).toBe("FOLLOWUP_NOT_APPROVED");
  });

  it("expires unconsumed approvals while preserving admission tombstones", async () => {
    const f = await start();
    const a = await task(f, { approvedFollowups: [{ prompt: "Read fixture B" }, { prompt: "Read fixture C" }] });
    const followupId = a.approvedFollowups[0].followupId;
    const unusedId = a.approvedFollowups[1].followupId;
    await completed(f, a.jobId);
    const parent = f.state.listJobs().find((job: any) => job.jobId === a.jobId) as any;
    const b = await task(f, { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId, reviewedVersion: parent.version } });
    expect(b.error).toBeNull();
    await completed(f, b.jobId);
    expect(f.state.taskFollowups.maintain(Date.now() + 8 * 86_400_000)).toBe(1);
    expect(f.state.taskFollowups.get(followupId)?.admittedJobId).toBe(b.jobId);
    expect(f.state.taskFollowups.get(unusedId)).toBeUndefined();
    const status = await completed(f, a.jobId);
    expect(status.items.find((item: any) => item.id === a.jobId).approvedFollowups[1]).toEqual({ followupId: unusedId,
      requestId: a.approvedFollowups[1].requestId, status: "expired" });
  });
});

describe("callback security", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.1.1", "192.168.1.1", "192.0.2.1", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:8.8.8.8", "2001:db8::1"])("blocks non-public address %s", address => {
    expect(publicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("permits public address %s", address => expect(publicAddress(address)).toBe(true));
  it.each(["http://receiver.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://receiver.example.com:444/path", "https://user:pass@receiver.example.com", "https://receiver.example.com/#fragment"])("rejects callback %s", url => expect(() => validateCallbackUrl(url)).toThrow());
  it("validates signing keys and exact-body Standard Webhooks signatures, including rotation", () => {
    validateSigningSecret(secret);
    expect(() => validateSigningSecret("whsec_aA==")).toThrow();
    const next = "whsec_" + randomBytes(32).toString("base64");
    const raw = JSON.stringify({ eventId: "evt_test", data: { jobId: randomUUID() } });
    const headers = signedHeaders("evt_test", "sub_test", raw, [secret, next]);
    expect(new Webhook(secret).verify(raw, headers)).toBeTruthy();
    expect(new Webhook(next).verify(raw, headers)).toBeTruthy();
    expect(() => new Webhook(next).verify(raw + " ", headers)).toThrow();
  });
  it("seals destinations against DB-only dumps, swapped records and token rotation", () => {
    const vault = new EventDestinationVault(token);
    const encrypted = vault.seal("sub_one", { url: "https://receiver.example.com/private", secret });
    expect(vault.open("sub_one", encrypted).secret).toBe(secret);
    expect(() => vault.open("sub_two", encrypted)).toThrow();
    expect(() => new EventDestinationVault("another-token").open("sub_one", encrypted)).toThrow();
  });
});
