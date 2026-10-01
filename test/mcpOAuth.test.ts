import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpServer, type BridgeHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import { McpOAuthVerifier, mcpOAuthPrincipal } from "../src/mcpOAuth.js";
import type { CodexModelCatalogProvider } from "../src/modelCatalog.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import type { WebhookSender } from "../src/mcpWebhook.js";

const oauthEnv = {
  CODEX_MCP_BRIDGE_OAUTH_ISSUER: "https://id.fixture.example/tenant/",
  CODEX_MCP_BRIDGE_OAUTH_RESOURCE: "https://bridge.fixture.example/mcp",
  CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: "https://bridge.fixture.example/.well-known/oauth-protected-resource/mcp",
  CODEX_MCP_BRIDGE_OAUTH_JWKS_URI: "https://id.fixture.example/tenant/keys",
  CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT: "operator-issued-subject"
};
const sealingKey = randomBytes(32).toString("hex");
const webhookSecret = "whsec_" + randomBytes(32).toString("base64");
const meta = { "openai/session": "oauth-original-conversation", "openai/subject": "host-correlation-only" };
const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" };
const catalog: CodexModelCatalogProvider = { getCatalog: async () => ({ source: "codex-cli", cached: false,
  fetchedAt: new Date().toISOString(), fingerprint: "b".repeat(64), stale: false, validation: "valid",
  models: [{ id: selection.model, displayName: "Fixture", defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [], inputModalities: ["text"] }] }) };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let replacement: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKeys: Awaited<ReturnType<typeof exportJWK>>[];
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  replacement = await generateKeyPair("RS256");
  publicKeys = [{ ...await exportJWK(keys.publicKey), kid: "first", alg: "RS256" },
    { ...await exportJWK(replacement.publicKey), kid: "second", alg: "RS256" }];
});

async function accessToken(claims: Record<string, unknown> = {}, alternateKey = false, header: Record<string, unknown> = {}) {
  return new SignJWT({ iss: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_ISSUER,
    aud: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_RESOURCE, sub: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT,
    scope: "bridge", client_id: "chatgpt-client-one", exp: Math.floor(Date.now() / 1_000) + 3_600, jti: randomUUID(), ...claims
  }).setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: alternateKey ? "second" : "first", ...header })
    .sign(alternateKey ? replacement.privateKey : keys.privateKey);
}

class Upstream implements CodexUpstream {
  calls = 0;
  private held?: Promise<void>;
  hold() { let release!: () => void; this.held = new Promise<void>(r => { release = r; }); return release; }
  async listTools() { return { tools: [{ name: "codex" }] }; }
  async callTool(_name: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calls++;
    if (this.held) { const wait = this.held; this.held = undefined; await wait; }
    return { content: [{ type: "text", text: "Original OAuth fixture result." }],
      structuredContent: { threadId: args.threadId || randomUUID(), content: "Original OAuth fixture result." } };
  }
  async close() {}
}

type Fixture = Awaited<ReturnType<typeof start>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await close(f.server); await close(f.provider); f.state.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
async function close(server: Server) { await new Promise<void>(r => server.close(() => r())); }

async function start(options: { root?: string; sender?: WebhookSender; bearer?: boolean; localMetadata?: boolean } = {}) {
  const root = options.root || await mkdtemp(path.join(tmpdir(), "bridge-oauth-"));
  const state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
  let metadataPort = 0;
  if (options.localMetadata) {
    const reservation = createServer();
    await new Promise<void>(r => reservation.listen(0, "127.0.0.1", r));
    metadataPort = (reservation.address() as { port: number }).port;
    await close(reservation);
  }
  const config = loadConfig({ ...(options.bearer ? {} : oauthEnv),
    ...(options.localMetadata ? { CODEX_MCP_BRIDGE_PORT: String(metadataPort),
      CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: `http://127.0.0.1:${metadataPort}/.well-known/oauth-protected-resource/mcp` } : {}),
    CODEX_MCP_BRIDGE_TOKEN: sealingKey, CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1",
    CODEX_MCP_BRIDGE_ROOTS: root, CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite") });
  const settings = new UserSettingsStore(config, { stateStore: state });
  if (!options.root) {
    settings.update({ modelPolicy: { mode: "automatic", constraints: { allowDelegation: false },
      allowedSelections: { kind: "explicit", selections: [selection] } } }, settings.current.revision);
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Fixture", cwd: root } }], undefined, settings.current.registryRevision);
  }
  const upstream = new Upstream();
  const deliveries: any[] = [];
  let keyRequests = 0;
  let published = [publicKeys[0]];
  let providerUnavailable: false | "http" | "network" = false;
  const provider = createServer((req, res) => {
    keyRequests++;
    res.setHeader("content-type", "application/json");
    if (providerUnavailable === "network") { req.socket.destroy(); return; }
    if (providerUnavailable === "http") { res.statusCode = 503; res.end("private provider diagnostics"); return; }
    res.end(JSON.stringify({ keys: published }));
  });
  await new Promise<void>(r => provider.listen(0, "127.0.0.1", r));
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/keys`;
  const jwksFetch: typeof fetch = async (input, init) => {
    expect(String(input)).toBe(config.oauth!.jwksUri);
    return fetch(providerUrl, init);
  };
  const sender: WebhookSender = options.sender || (async (_url, body) => {
    const parsed = JSON.parse(body); deliveries.push(parsed);
    return { status: 200, body: JSON.stringify(parsed.type === "verification" ? { challenge: parsed.challenge } : {}) };
  });
  const server = createHttpServer(config, upstream, catalog, { stateStore: state, eventWebhookSender: sender, oauthJwksFetch: jwksFetch });
  await new Promise<void>(r => server.listen(metadataPort, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const f = { root, state, config, settings, upstream, server, provider, baseUrl, deliveries, jwksFetch,
    keyRequests: () => keyRequests, publish: (value: typeof published) => { published = value; },
    providerUnavailable: (value: typeof providerUnavailable) => { providerUnavailable = value; } };
  fixtures.push(f); return f;
}

async function rpc(f: Fixture, method: string, params: Record<string, unknown> = {}, token?: string, metadata = meta) {
  const response = await fetch(`${f.baseUrl}/mcp`, { method: "POST", headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", accept: "application/json",
    "mcp-protocol-version": "2026-07-28", "mcp-method": method,
    ...(method === "tools/call" && typeof params.name === "string" ? { "mcp-name": params.name } : {})
  }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params: { ...params, _meta: { ...metadata,
    "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "oauth-fixture", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {} } } }) });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

async function task(f: Fixture, token: string, extra: Record<string, unknown> = {}, metadata = meta) {
  const list = await rpc(f, "tools/list", {}, token);
  const properties = list.body.result.tools.find((t: any) => t.name === "codex_task").inputSchema.properties;
  const project = f.settings.current.projects[0];
  const result = await rpc(f, "tools/call", { name: "codex_task", arguments: {
    requestId: randomUUID(), taskContractVersion: properties.taskContractVersion.const,
    executionEnvelopeRef: properties.executionEnvelopeRef.const, prompt: "Read fixture A", selection,
    project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision }, ...extra
  } }, token, metadata);
  expect(result.body.error).toBeUndefined();
  expect(result.body.result?.isError).not.toBe(true);
  return result.body.result.structuredContent as any;
}
function subscribe(jobId: string) { return { name: "codex.job.terminal", arguments: { jobId },
  delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: webhookSecret } }; }
async function completed(f: Fixture, jobId: string, token: string) {
  await vi.waitFor(() => expect((f.state.listJobs().find((j: any) => j.jobId === jobId) as any)?.status).toBe("completed"));
  return (await rpc(f, "tools/call", { name: "codex_status", arguments: { query: { kind: "job", id: jobId } } }, token)).body.result.structuredContent;
}

describe("MCP OAuth configuration and HTTP discovery", () => {
  it("allows HTTP metadata only at the exact loopback Bridge binding and known metadata paths", () => {
    for (const [host, authority] of [["127.0.0.1", "127.0.0.1"], ["localhost", "localhost"], ["::1", "[::1]"]]) {
      for (const suffix of ["", "/mcp"]) {
        const url = `http://${authority}:8765/.well-known/oauth-protected-resource${suffix}`;
        expect(loadConfig({ ...oauthEnv, CODEX_MCP_BRIDGE_HOST: host,
          CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: url }).oauth?.resourceMetadataUrl).toBe(url);
      }
    }
    for (const url of [
      "http://127.0.0.1:8766/.well-known/oauth-protected-resource/mcp",
      "http://localhost:8765/.well-known/oauth-protected-resource/mcp",
      "http://127.0.0.2:8765/.well-known/oauth-protected-resource/mcp",
      "http://192.168.1.1:8765/.well-known/oauth-protected-resource/mcp",
      "http://public.example:8765/.well-known/oauth-protected-resource/mcp",
      "http://127.0.0.1:8765/mcp", "http://127.0.0.1:8765/api/settings",
      "http://127.0.0.1:8765/.well-known/oauth-protected-resource/%6dcp",
      "http://127.0.0.1:8765/.well-known/oauth-protected-resource/mcp?next=/mcp",
      "http://127.0.0.1:8765/.well-known/oauth-protected-resource/mcp#fragment",
      "http://user:secret@127.0.0.1:8765/.well-known/oauth-protected-resource/mcp",
      "http://127.0.0.1:8765/.well-known/oauth-protected-resource/mcp\n"
    ]) expect(() => loadConfig({ ...oauthEnv, CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: url })).toThrow("HTTPS");
    const local = "http://127.0.0.1:8765/.well-known/oauth-protected-resource/mcp";
    expect(() => loadConfig({ ...oauthEnv, CODEX_MCP_BRIDGE_HOST: "0.0.0.0",
      CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: local })).toThrow("HTTPS");
    for (const suffix of ["ISSUER", "RESOURCE", "JWKS_URI"]) {
      expect(() => loadConfig({ ...oauthEnv, [`CODEX_MCP_BRIDGE_OAUTH_${suffix}`]: local })).toThrow("HTTPS");
    }
  });

  it("advertises its local metadata source to the Tunnel while preserving authentication and Origin checks", async () => {
    const f = await start({ localMetadata: true });
    expect(f.config.oauth!.resourceMetadataUrl).toBe(`${f.baseUrl}/.well-known/oauth-protected-resource/mcp`);
    const response = await fetch(f.baseUrl + "/mcp");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${f.config.oauth!.resourceMetadataUrl}"`);
    const metadata = await fetch(f.config.oauth!.resourceMetadataUrl);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_RESOURCE,
      authorization_servers: [oauthEnv.CODEX_MCP_BRIDGE_OAUTH_ISSUER] });
    expect((await fetch(f.config.oauth!.resourceMetadataUrl, { headers: { origin: "https://foreign.example" } })).status).toBe(403);
    expect((await rpc(f, "events/list")).response.status).toBe(401);
    expect((await rpc(f, "events/list", {}, await accessToken({ sub: "another-operator" }))).response.status).toBe(401);
    expect((await rpc(f, "events/list", {}, await accessToken())).response.status).toBe(200);
    expect(f.state.listJobs()).toHaveLength(0); expect(f.upstream.calls).toBe(0);
  });

  it("requires the complete explicit profile and rejects No Auth rather than downgrading", () => {
    expect(loadConfig(oauthEnv).oauth?.issuer).toBe(oauthEnv.CODEX_MCP_BRIDGE_OAUTH_ISSUER);
    expect(() => loadConfig({ CODEX_MCP_BRIDGE_OAUTH_ISSUER: oauthEnv.CODEX_MCP_BRIDGE_OAUTH_ISSUER })).toThrow("OAUTH_OPERATOR_SUBJECT");
    expect(() => loadConfig({ ...oauthEnv, CODEX_MCP_BRIDGE_NO_AUTH: "1" })).toThrow("cannot be combined");
    expect(() => loadConfig({ ...oauthEnv, CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1" })).toThrow("32 bytes");
    expect(() => loadConfig({ ...oauthEnv, CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1", CODEX_MCP_BRIDGE_TOKEN: "weak" })).toThrow("32 bytes");
    for (const issuer of ["http://id.example", "https://user:secret@id.example", "https://id.example/#x", "https://id.example/?secret=x", "https://id.example/\n"]) {
      expect(() => loadConfig({ ...oauthEnv, CODEX_MCP_BRIDGE_OAUTH_ISSUER: issuer })).toThrow();
    }
  });

  it("rejects OAuth stdio before creating a database or starting children", () => {
    const result = spawnSync(process.execPath, ["scripts/start-codex-mcp-bridge.mjs", "--mode", "secure", "--transport", "stdio"], {
      cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, ...oauthEnv }, timeout: 10_000, encoding: "utf8"
    });
    expect(result.status).toBe(1); expect(result.stderr).toContain("OAuth requires HTTP transport");
    const direct = spawnSync(process.execPath, ["--import", "tsx", "src/stdio.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, ...oauthEnv }, timeout: 10_000, encoding: "utf8"
    });
    expect(direct.status).toBe(1); expect(direct.stderr).toContain("cannot be combined");
  });

  it("publishes resource metadata and both tool security declarations without granting execution", async () => {
    const f = await start();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await fetch(f.baseUrl + path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: f.config.oauth!.resource, authorization_servers: [f.config.oauth!.issuer], scopes_supported: ["bridge"] });
    }
    expect((await rpc(f, "server/discover")).body.result.capabilities.events).toEqual({});
    const list = await rpc(f, "tools/list");
    expect(list.body.result.tools).toHaveLength(17);
    for (const tool of list.body.result.tools) {
      expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["bridge"] }]);
      expect(tool._meta.securitySchemes).toEqual(tool.securitySchemes);
    }
    const login = await rpc(f, "tools/call", { name: "codex_task", arguments: {} });
    expect(login.body.result.isError).toBe(true);
    expect(login.body.result._meta["mcp/www_authenticate"][0]).toContain(f.config.oauth!.resourceMetadataUrl);
    expect(login.response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await rpc(f, "events/list")).response.status).toBe(401);
    expect((await rpc(f, "resources/read", { uri: "ui://codex/dashboard" })).response.status).toBe(401);
    expect(f.state.listJobs()).toHaveLength(0); expect(f.upstream.calls).toBe(0); expect(f.keyRequests()).toBe(0);
  });

  it("keeps Origin enforcement on public OAuth metadata", async () => {
    const f = await start();
    const response = await fetch(f.baseUrl + "/.well-known/oauth-protected-resource", { headers: { origin: "https://foreign.example" } });
    expect(response.status).toBe(403);
  });

  it("returns linking metadata through the actual current SDK client", async () => {
    const f = await start();
    const client = new Client({ name: "oauth-linking-fixture", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(f.baseUrl + "/mcp")));
      const tools = await client.listTools();
      expect(tools.tools.find(t => t.name === "codex_task")?._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["bridge"] }]);
      const result = await client.callTool({ name: "codex_task", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result._meta?.["mcp/www_authenticate"]).toEqual([expect.stringContaining(f.config.oauth!.resourceMetadataUrl)]);
    } finally { await client.close(); }
  });
});

describe("verified access tokens and exact owned Events", () => {
  it.each([
    ["issuer", { iss: "https://foreign.example" }], ["issuer slash", { iss: "https://id.fixture.example/tenant" }],
    ["audience", { aud: "https://another-resource.example" }], ["subject", { sub: "foreign-user" }],
    ["scope", { scope: "openid profile" }], ["missing expiry", { exp: undefined }], ["missing subject", { sub: undefined }],
    ["missing scope", { scope: undefined }], ["scope array", { scope: ["bridge"] }], ["expired", { exp: 1 }],
    ["not yet valid", { nbf: 9_000_000_000 }], ["ID token", { token_use: "id" }]
  ])("rejects %s without callback or admission", async (_name, claims) => {
    const f = await start(); const token = await accessToken(claims);
    const rejected = await rpc(f, "events/list", {}, token);
    expect(rejected.response.status).toBe(401);
    expect(rejected.response.headers.get("www-authenticate")).toContain(f.config.oauth!.resourceMetadataUrl);
    const task = await rpc(f, "tools/call", { name: "codex_task", arguments: {} }, token);
    expect(task.body.result.isError).toBe(true);
    expect(JSON.stringify(task.body)).not.toContain(token);
    expect(f.upstream.calls).toBe(0); expect(f.deliveries).toHaveLength(0);
  });

  it("rejects bad signatures, unknown keys, opaque tokens, oversize tokens and the installation sealing key", async () => {
    const f = await start();
    const valid = await accessToken();
    const pieces = valid.split('.'); pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
    const hmac = await new SignJWT({ iss: f.config.oauth!.issuer, aud: f.config.oauth!.resource, sub: f.config.oauth!.operatorSubject,
      scope: "bridge", exp: Math.floor(Date.now() / 1_000) + 60 }).setProtectedHeader({ alg: "HS256", kid: "first" }).sign(Buffer.from(sealingKey));
    for (const token of [pieces.join('.'), hmac, await accessToken({}, true), "opaque-access-token", "x".repeat(20_000), sealingKey]) {
      expect((await rpc(f, "events/list", {}, token)).response.status).toBe(token.length > 16_384 ? 431 : 401);
    }
    expect(f.upstream.calls).toBe(0);
  });

  it("keeps one user principal across token and client-ID renewal, A/B admission, callback and restart", async () => {
    const f = await start(); const first = await accessToken(); const renewed = await accessToken({ client_id: "chatgpt-client-two" });
    const a = await task(f, first, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    const sub = await rpc(f, "events/subscribe", subscribe(a.jobId), first);
    expect(sub.body.error).toBeUndefined();
    const resub = await rpc(f, "events/subscribe", subscribe(a.jobId), renewed);
    expect(resub.body.result.id).toBe(sub.body.result.id);
    expect(f.state.mcpEvents.get(a.jobId, sub.body.result.id)?.principal).toBe(mcpOAuthPrincipal(f.config.oauth!));
    const status = await completed(f, a.jobId, renewed);
    await vi.waitFor(() => expect(f.deliveries.some(d => d.eventId)).toBe(true));
    expect(f.deliveries.find(d => d.eventId).data.availableFollowups).toEqual([{ followupId: a.approvedFollowups[0].followupId }]);
    const params = { project: undefined, selection: undefined, prompt: "Read fixture B",
      followup: { followupId: a.approvedFollowups[0].followupId, reviewedVersion: status.items[0].versions.job } };
    const [b1, b2] = await Promise.all([task(f, first, params), task(f, renewed, params)]);
    expect(b1.jobId).toBe(b2.jobId); await completed(f, b1.jobId, renewed); expect(f.upstream.calls).toBe(2);
    const contents = JSON.stringify(f.state.listJobs());
    expect(contents).not.toContain(first); expect(contents).not.toContain(renewed); expect(contents).not.toContain(sealingKey);
    await close(f.server); await close(f.provider); f.state.close(); fixtures.splice(fixtures.indexOf(f), 1);
    const restarted = await start({ root: f.root });
    const recovered = await task(restarted, await accessToken(), params);
    expect(recovered.jobId).toBe(b1.jobId); expect(restarted.upstream.calls).toBe(0);
  });

  it("rejects an unapproved followup and the same reference in another conversation", async () => {
    const f = await start(); const token = await accessToken();
    const a = await task(f, token, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    const status = await completed(f, a.jobId, token);
    const props = (await rpc(f, "tools/list", {}, token)).body.result.tools.find((t: any) => t.name === "codex_task").inputSchema.properties;
    const args = { requestId: randomUUID(), taskContractVersion: props.taskContractVersion.const, executionEnvelopeRef: props.executionEnvelopeRef.const,
      prompt: "Read fixture B", followup: { followupId: a.approvedFollowups[0].followupId, reviewedVersion: status.items[0].versions.job } };
    const foreign = await rpc(f, "tools/call", { name: "codex_task", arguments: args }, token, { ...meta, "openai/session": "foreign-conversation" });
    expect(JSON.stringify(foreign.body)).toContain("FOLLOWUP_NOT_APPROVED");
    const undeclared = await rpc(f, "tools/call", { name: "codex_task", arguments: { ...args, followup: { ...args.followup,
      followupId: "fup_" + "1".repeat(96) } } }, token);
    expect(JSON.stringify(undeclared.body)).toContain("FOLLOWUP_NOT_APPROVED"); expect(f.upstream.calls).toBe(1);
  });

  it("caps grants at token expiry and rejects expiry during callback verification", async () => {
    const f = await start(); const token = await accessToken({ exp: Math.floor(Date.now() / 1_000) + 60 });
    const a = await task(f, token);
    const sub = await rpc(f, "events/subscribe", { ...subscribe(a.jobId), ttlMs: 24 * 3_600_000 }, token);
    const record = f.state.mcpEvents.get(a.jobId, sub.body.result.id)!;
    expect(record.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    await completed(f, a.jobId, token);
    await rpc(f, "events/unsubscribe", { ...subscribe(a.jobId), delivery: { mode: "webhook", url: "https://receiver.example.com/events" } }, token);

    const expiry = Math.floor(Date.now() / 1_000) + 60;
    const delayed = await start({ sender: async (_url, body) => {
      const request = JSON.parse(body);
      vi.spyOn(Date, "now").mockReturnValue((expiry + 1) * 1_000);
      return { status: 200, body: JSON.stringify({ challenge: request.challenge }) };
    } });
    const a2 = await task(delayed, await accessToken());
    const failed = await rpc(delayed, "events/subscribe", subscribe(a2.jobId), await accessToken({ exp: expiry }));
    expect(failed.body.error.code).toBe(-32001); expect(delayed.state.mcpEvents.list()).toHaveLength(0);
  });

  it("does not transfer existing bearer Jobs or approvals to the OAuth operator", async () => {
    const old = await start({ bearer: true });
    const a = await task(old, sealingKey, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    const status = await completed(old, a.jobId, sealingKey);
    await close(old.server); await close(old.provider); old.state.close(); fixtures.splice(fixtures.indexOf(old), 1);
    const oauth = await start({ root: old.root }); const token = await accessToken();
    const subscribeAttempt = await rpc(oauth, "events/subscribe", subscribe(a.jobId), token);
    expect(subscribeAttempt.body.error.code).toBe(-32001); expect(oauth.deliveries).toHaveLength(0);
    const args = { requestId: randomUUID(), prompt: "Read fixture B",
      followup: { followupId: a.approvedFollowups[0].followupId, reviewedVersion: status.items[0].versions.job } };
    const list = (await rpc(oauth, "tools/list", {}, token)).body.result.tools;
    const properties = list.find((t: any) => t.name === "codex_task").inputSchema.properties;
    const b = await rpc(oauth, "tools/call", { name: "codex_task", arguments: { ...args,
      taskContractVersion: properties.taskContractVersion.const, executionEnvelopeRef: properties.executionEnvelopeRef.const } }, token);
    expect(JSON.stringify(b.body)).toContain("FOLLOWUP_NOT_APPROVED"); expect(oauth.upstream.calls).toBe(0);
  });

  it("stops expired delivery grants without cancelling or repeating the original Job", async () => {
    const f = await start(); const release = f.upstream.hold();
    const expiry = Math.floor(Date.now() / 1_000) + 60;
    const token = await accessToken({ exp: expiry });
    const a = await task(f, token);
    const sub = await rpc(f, "events/subscribe", subscribe(a.jobId), token);
    expect(sub.body.result.id).toBeTruthy();
    vi.spyOn(Date, "now").mockReturnValue((expiry + 1) * 1_000);
    release(); await completed(f, a.jobId, await accessToken());
    expect(f.deliveries.filter(d => d.eventId)).toHaveLength(0); expect(f.upstream.calls).toBe(1);
    const renewed = await rpc(f, "events/subscribe", subscribe(a.jobId), await accessToken());
    expect(renewed.body.result.id).toBe(sub.body.result.id);
    await vi.waitFor(() => expect(f.deliveries.filter(d => d.eventId)).toHaveLength(1));
    expect(f.upstream.calls).toBe(1);
  });

  it("handles JWKS signing-key rotation without trusting token-selected key URLs", async () => {
    const f = await start(); const verifier = new McpOAuthVerifier(f.config.oauth!, f.jwksFetch);
    const first = await verifier.authenticate(`Bearer ${await accessToken()}`);
    f.publish([publicKeys[1]]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const second = await verifier.authenticate(`Bearer ${await accessToken({}, true, { jku: "http://127.0.0.1/private", x5u: "https://attacker.example/key" })}`);
    expect(first.status).toBe("authenticated"); expect(second.status).toBe("authenticated");
    if (first.status !== "authenticated" || second.status !== "authenticated") throw new Error("Expected verified tokens.");
    expect(first.authInfo.extra?.bridgeMcpPrincipal).toBe(second.authInfo.extra?.bridgeMcpPrincipal);
    expect(f.keyRequests()).toBe(2);
  });

  it.each(["http", "network"] as const)("distinguishes a JWKS %s outage from invalid tokens and recovers without relinking or changing Jobs", async mode => {
    const f = await start(); const token = await accessToken();
    const a = await task(f, token, { approvedFollowups: [{ prompt: "Read fixture B" }] });
    await completed(f, a.jobId, token);
    const jobs = f.state.listJobs();
    const receipts = f.state.listMeta("task_followup_v1/", 256);
    expect(receipts).toHaveLength(1);
    const fetched = f.keyRequests();
    f.providerUnavailable(mode);
    expect((await rpc(f, "events/list", {}, token)).response.status).toBe(200);
    expect(f.keyRequests()).toBe(fetched); // Fresh cached keys still verify locally.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
    for (const [method, params] of [["events/list", {}], ["tools/call", {
      name: "codex_status", arguments: { query: { kind: "job", id: a.jobId } }
    }]] as const) {
      const unavailable = await rpc(f, method, params, token);
      expect(unavailable.response.status).toBe(503);
      expect(unavailable.response.headers.get("retry-after")).toBe("5");
      expect(unavailable.response.headers.get("www-authenticate")).toBeNull();
      expect(unavailable.body).toEqual({ error: "authentication_unavailable", retryable: true });
      expect(JSON.stringify(unavailable.body)).not.toMatch(/invalid_token|mcp\/www_authenticate|private provider diagnostics/);
      expect(JSON.stringify(unavailable.body)).not.toContain(token);
    }
    expect(f.state.listJobs()).toEqual(jobs);
    expect(f.state.listMeta("task_followup_v1/", 256)).toEqual(receipts);
    expect(f.upstream.calls).toBe(1);
    f.providerUnavailable(false);
    const recovered = await rpc(f, "tools/call", { name: "codex_status", arguments: { query: { kind: "job", id: a.jobId } } }, token);
    expect(recovered.response.status).toBe(200); expect(recovered.body.result.isError).not.toBe(true);
    expect(recovered.body.result.structuredContent.items[0].approvedFollowups).toEqual(a.approvedFollowups);
    const expired = await rpc(f, "events/list", {}, await accessToken({ exp: 1 }));
    expect(expired.response.status).toBe(401);
    expect(expired.response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(f.upstream.calls).toBe(1);
  });

  it("fails closed for redirected, oversized or unavailable JWKS", async () => {
    const f = await start(); const token = await accessToken();
    for (const body of [new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
      new Response("x".repeat(129 * 1_024)), new Response("offline", { status: 503 }),
      new Response("not JSON"), new Response(JSON.stringify({ keys: "malformed" }))]) {
      const fetcher: typeof fetch = async (_url, options) => { expect(options?.redirect).toBe("manual"); return body; };
      expect(await new McpOAuthVerifier(f.config.oauth!, fetcher).authenticate(`Bearer ${token}`)).toEqual({ status: "unavailable" });
    }
    const timeout: typeof fetch = async () => { throw new DOMException("private timeout diagnostic", "TimeoutError"); };
    expect(await new McpOAuthVerifier(f.config.oauth!, timeout).authenticate(`Bearer ${token}`)).toEqual({ status: "unavailable" });
  });
});
