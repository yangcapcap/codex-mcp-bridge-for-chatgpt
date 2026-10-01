import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as nodeRequest, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateKeyPair, exportJWK, exportPKCS8, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpenAiMcpAuthorization, openAiMcpOperatorSubject, openAiOperatorIdentityHash,
  OPENAI_LOCAL_SIGN_IN_SCOPES, type OpenAiMcpAuthorizationConfig } from "../src/openaiMcpAuthorization.js";
import { McpOAuthVerifier, mcpOAuthPrincipal } from "../src/mcpOAuth.js";
import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/server.js";
import { BridgeStateStore } from "../src/stateStore.js";
import { UserSettingsStore } from "../src/userSettings.js";
import type { CodexUpstream, ToolResult } from "../src/upstream.js";
import type { CodexModelCatalogProvider } from "../src/modelCatalog.js";

const issuer = "https://login.fixture.example";
const resource = "https://bridge.fixture.example/mcp";
const operator = "verified-openai-operator";
const openaiClientId = "issued-openai-client-fixture";
const client = { id: "registered-chatgpt-fixture", secret: randomBytes(32).toString("hex"), redirectUri: "https://chatgpt.fixture.example/oauth/callback/exact" };
let openaiKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let signingKeyPkcs8: string;
let jwk: Record<string, unknown>;
beforeAll(async () => {
  openaiKeys = await generateKeyPair("RS256", { extractable: true });
  otherKeys = await generateKeyPair("RS256", { extractable: true });
  signingKeyPkcs8 = await exportPKCS8((await generateKeyPair("EdDSA", { extractable: true })).privateKey);
  jwk = { ...await exportJWK(openaiKeys.publicKey), kid: "openai-fixture", alg: "RS256" };
});
function config(): OpenAiMcpAuthorizationConfig {
  return { issuer, resource, openaiClientId, hostId: `urn:uuid:${randomUUID()}`,
    operatorIdentityHash: openAiOperatorIdentityHash(openaiClientId, operator), connectorClient: { ...client }, signingKeyPkcs8 };
}
function verifier() { return randomBytes(32).toString("base64url"); }
function challenge(value: string) { return createHash("sha256").update(value).digest("base64url"); }
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())); }
type Fixture = Awaited<ReturnType<typeof start>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.service.close(); await close(f.provider); } });

async function start(changes: Partial<OpenAiMcpAuthorizationConfig> = {}) {
  let time = Date.now(), tokenRequests = 0, keyRequests = 0;
  let claims: Record<string, unknown> = {}, badSignature = false, unavailable: string | undefined, expected: URL | undefined;
  let lastIdToken = "", held: Promise<void> | undefined;
  const selected = { ...config(), ...changes };
  const provider = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === unavailable) { res.writeHead(503).end(JSON.stringify({ private: "provider internal diagnostics" })); return; }
    if (req.url === "/discovery") { res.end(JSON.stringify({ issuer: "https://auth.openai.com",
      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize", token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
      jwks_uri: "https://auth.openai.com/.well-known/jwks.json", code_challenge_methods_supported: ["S256"] })); return; }
    if (req.url === "/jwks") { keyRequests++; res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === "/token") {
      tokenRequests++;
      let body = ""; for await (const chunk of req) body += chunk.toString();
      const params = new URLSearchParams(body);
      expect(params.get("client_id")).toBe(selected.openaiClientId);
      expect(params.get("resource")).toBe("https://api.openai.com/v1");
      expect(params.get("redirect_uri")).toBe(expected?.searchParams.get("redirect_uri"));
      expect(challenge(params.get("code_verifier")!)).toBe(expected?.searchParams.get("code_challenge"));
      if (held) await held;
      lastIdToken = await new SignJWT({ iss: "https://auth.openai.com", aud: selected.openaiClientId, sub: operator,
        iat: Math.floor(time / 1_000), exp: Math.floor(time / 1_000) + 3_600, nonce: expected?.searchParams.get("nonce"), ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "openai-fixture" }).sign(badSignature ? otherKeys.privateKey : openaiKeys.privateKey);
      res.end(JSON.stringify({ id_token: lastIdToken, access_token: "private-openai-api-token", refresh_token: "private-openai-refresh-token",
        scope: OPENAI_LOCAL_SIGN_IN_SCOPES.join(" ") })); return;
    }
    res.writeHead(404).end();
  });
  const providerBase = await listen(provider);
  const routes: Record<string, string> = { "https://auth.openai.com/.well-known/openid-configuration": "/discovery",
    "https://auth.openai.com/api/accounts/oauth/token": "/token", "https://auth.openai.com/.well-known/jwks.json": "/jwks" };
  const fetchOpenAi: typeof fetch = async (input, init) => {
    expect(routes[String(input)]).toBeDefined(); expect(init?.redirect).toBe("error");
    return fetch(providerBase + routes[String(input)], init);
  };
  try {
    const service = await createOpenAiMcpAuthorization(selected, { fetchOpenAi, now: () => time });
    const addresses = await service.listen();
    const f = { service, provider, addresses, selected, expectAuthorization: (url: URL) => { expected = url; },
      claims: (value: Record<string, unknown>) => { claims = value; }, badSignature: () => { badSignature = true; },
      unavailable: (path: string) => { unavailable = path; }, advance: (ms: number) => { time += ms; },
      holdToken: () => { let release!: () => void; held = new Promise<void>(r => { release = r; }); return release; },
      tokenRequests: () => tokenRequests, keyRequests: () => keyRequests, lastIdToken: () => lastIdToken };
    fixtures.push(f); return f;
  } catch (error) { await close(provider); throw error; }
}
async function requestUrl(url: string, init: RequestInit = {}) {
  // Node fetch ignores a custom Host. Exercise the real HTTP handler under its
  // HTTPS issuer hostname without weakening production Host checks or publishing it.
  return new Promise<Response>((resolve, reject) => {
    const req = nodeRequest(url, { method: init.method || "GET", headers: Object.fromEntries(new Headers(init.headers)),
      signal: init.signal || undefined }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(init.body ? String(init.body) : undefined);
  });
}
async function publicRequest(f: Fixture, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set("host", new URL(f.selected.issuer).host);
  return requestUrl(f.addresses.authorizationBase + path, { ...init, headers });
}
async function post(f: Fixture, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return publicRequest(f, path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields) });
}
function outer(f: Fixture, proof: string, changes: Record<string, string> = {}) {
  return new URLSearchParams({ response_type: "code", client_id: f.selected.connectorClient.id, redirect_uri: f.selected.connectorClient.redirectUri,
    resource: f.selected.resource, scope: "bridge", state: "outer-chatgpt-state", code_challenge_method: "S256", code_challenge: challenge(proof), ...changes });
}
async function begin(f: Fixture, changes: Record<string, string> = {}) {
  const proof = verifier();
  const response = await publicRequest(f, "/oauth/authorize?" + outer(f, proof, changes));
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const html = await response.text(), startUrl = /href="([^"]+)"/u.exec(html)![1].replaceAll("&amp;", "&");
  const local = await fetch(startUrl, { redirect: "manual" });
  expect(local.status).toBe(303);
  const authorization = new URL(local.headers.get("location")!);
  f.expectAuthorization(authorization);
  return { proof, cookie, localCookie: local.headers.get("set-cookie")!.split(";")[0], authorization,
    transaction: new URL(startUrl).searchParams.get("transaction")! };
}
type Login = Awaited<ReturnType<typeof begin>>;
async function returnIdentity(f: Fixture, login: Login, changes: Record<string, string> = {}, cookie = login.localCookie) {
  const url = new URL(f.addresses.callbackUri);
  url.search = new URLSearchParams({ state: login.authorization.searchParams.get("state")!, code: "openai-issued-code",
    client_id: f.selected.openaiClientId, ...changes }).toString();
  return fetch(url, { redirect: "manual", headers: { cookie } });
}
async function verified(f: Fixture) {
  const login = await begin(f), callback = await returnIdentity(f, login);
  expect(callback.status).toBe(303);
  expect(new URL(callback.headers.get("location")!).searchParams.has("code")).toBe(false);
  const consent = await publicRequest(f, "/oauth/consent?transaction=" + login.transaction, { headers: { cookie: login.cookie } });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  return { ...login, consent: /name="consent" value="([^"]+)"/u.exec(html)![1] };
}
async function approve(f: Fixture, login: Awaited<ReturnType<typeof verified>>, decision = "allow") {
  return post(f, "/oauth/consent", { transaction: login.transaction, consent: login.consent, decision }, { cookie: login.cookie, origin: f.selected.issuer });
}
async function authorized(f: Fixture) {
  const login = await verified(f), response = await approve(f, login);
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.origin + url.pathname).toBe(f.selected.connectorClient.redirectUri);
  expect(url.searchParams.get("state")).toBe("outer-chatgpt-state"); expect(url.searchParams.get("iss")).toBe(f.selected.issuer);
  return { ...login, code: url.searchParams.get("code")! };
}
async function exchange(f: Fixture, login: Awaited<ReturnType<typeof authorized>>, changes: Record<string, string> = {}) {
  return post(f, "/oauth/token", { grant_type: "authorization_code", client_id: f.selected.connectorClient.id,
    client_secret: f.selected.connectorClient.secret, redirect_uri: f.selected.connectorClient.redirectUri,
    resource: f.selected.resource, code: login.code, code_verifier: login.proof, ...changes });
}
async function refresh(f: Fixture, token: string, changes: Record<string, string> = {}) {
  return post(f, "/oauth/token", { grant_type: "refresh_token", client_id: f.selected.connectorClient.id,
    client_secret: f.selected.connectorClient.secret, resource: f.selected.resource, refresh_token: token, ...changes });
}
function bridgeVerifier(f: Fixture) {
  const oauth = { issuer: f.selected.issuer, resource: f.selected.resource, jwksUri: f.selected.issuer + "/oauth/jwks",
    resourceMetadataUrl: f.selected.resource + "/.well-known/oauth-protected-resource", operatorSubject: openAiMcpOperatorSubject(f.selected.operatorIdentityHash) };
  const keyFetch: typeof fetch = async (input, init) => {
    expect(String(input)).toBe(oauth.jwksUri); return publicRequest(f, "/oauth/jwks", init);
  };
  return { oauth, verifier: new McpOAuthVerifier(oauth, keyFetch) };
}

describe("isolated OpenAI / Bridge authorization", () => {
  it("publishes only bounded auth metadata and public keys and listens on loopback", async () => {
    const f = await start();
    const metadata = await publicRequest(f, "/.well-known/oauth-authorization-server");
    expect(await metadata.json()).toMatchObject({ issuer, code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"], scopes_supported: ["bridge"], authorization_response_iss_parameter_supported: true });
    const keys = await (await publicRequest(f, "/oauth/jwks")).text();
    expect(keys).not.toContain('"d"'); expect(keys).not.toContain("PRIVATE KEY"); expect(keys).not.toContain(client.secret);
    expect((await publicRequest(f, "/mcp")).status).toBe(404);
    expect((f.service.publicServer.address() as any).address).toBe("127.0.0.1");
    expect((f.service.callbackServer.address() as any).address).toBe("127.0.0.1");
    expect((await fetch(f.addresses.authorizationBase + "/oauth/jwks")).status).toBe(400);
  });

  it.each([
    ["client", { client_id: "unregistered" }], ["callback", { redirect_uri: "https://evil.fixture.example/callback" }],
    ["resource", { resource: "https://api.openai.com/v1" }], ["scope", { scope: "bridge admin" }],
    ["PKCE downgrade", { code_challenge_method: "plain" }], ["challenge", { code_challenge: "bad" }]
  ])("rejects wrong outer %s before redirecting or contacting OpenAI", async (_name, changes) => {
    const f = await start();
    const response = await publicRequest(f, "/oauth/authorize?" + outer(f, verifier(), changes as Record<string, string>));
    expect(response.status).toBe(400); expect(response.headers.has("location")).toBe(false);
    expect(f.tokenRequests()).toBe(0); expect(f.service.diagnostics().pendingTransactions).toBe(0);
  });

  it("rejects duplicate parameters, hostile callback Host and browser-bound inner state", async () => {
    const f = await start();
    expect((await publicRequest(f, "/oauth/authorize?" + outer(f, verifier()) + "&client_id=duplicate")).status).toBe(400);
    const login = await begin(f);
    expect((await returnIdentity(f, login, { state: "outer-chatgpt-state" })).status).toBe(403);
    expect((await returnIdentity(f, login, {}, "")).status).toBe(403);
    const hostile = await requestUrl(f.addresses.callbackUri, { headers: { host: "evil.fixture.example" } });
    expect(hostile.status).toBe(400); expect(f.tokenRequests()).toBe(0);
    expect((await returnIdentity(f, login)).status).toBe(303);
    expect((await returnIdentity(f, login)).status).toBe(403); expect(f.tokenRequests()).toBe(1);
  });

  it.each([
    ["account", { sub: "another-operator" }], ["issuer", { iss: "https://evil.fixture.example" }],
    ["audience", { aud: "dynamic_agent_client" }], ["nonce", { nonce: "outer-chatgpt-state" }],
    ["expiry", { exp: 1 }], ["authorized party", { azp: "another-client" }]
  ])("rejects a wrong OpenAI %s without connector authority or leaked diagnostics", async (_name, claims) => {
    const f = await start(); f.claims(claims);
    const response = await returnIdentity(f, await begin(f));
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "access_denied" });
    expect(f.service.diagnostics()).toMatchObject({ verifiedLogins: 0, pendingTransactions: 0, pendingCodes: 0 });
  });

  it("rejects invalid signatures separately from a JWKS outage", async () => {
    const bad = await start(); bad.badSignature();
    expect((await returnIdentity(bad, await begin(bad))).status).toBe(403);
    const down = await start(); down.unavailable("/jwks");
    const unavailable = await returnIdentity(down, await begin(down));
    expect(unavailable.status).toBe(503); expect(unavailable.headers.get("retry-after")).toBe("5");
    expect(await unavailable.json()).toEqual({ error: "authentication_unavailable", retryable: true });
    expect(down.service.diagnostics().pendingCodes).toBe(0);
  });

  it("requires separate browser-bound consent after verified login and preserves denial", async () => {
    const f = await start(), login = await verified(f);
    expect(f.service.diagnostics()).toMatchObject({ verifiedLogins: 1, pendingCodes: 0, modelRequests: 0, rawOpenAiCredentialsRetained: false });
    const fields = { transaction: login.transaction, consent: login.consent, decision: "allow" };
    for (const headers of [{ cookie: login.cookie, origin: "https://evil.fixture.example" }, { cookie: "", origin: issuer }]) {
      expect((await post(f, "/oauth/consent", fields, headers)).status).toBe(403);
    }
    expect((await post(f, "/oauth/consent", { ...fields, consent: "forged" }, { cookie: login.cookie, origin: issuer })).status).toBe(403);
    const denied = await approve(f, login, "deny"), location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied"); expect(location.searchParams.get("state")).toBe("outer-chatgpt-state");
    expect(location.searchParams.has("code")).toBe(false); expect(f.service.diagnostics().pendingCodes).toBe(0);
  });

  it("preserves the consent form Origin without allowing opaque, absent or foreign origins", async () => {
    const f = await start(), login = await verified(f);
    const consent = await publicRequest(f, "/oauth/consent?transaction=" + login.transaction, { headers: { cookie: login.cookie } });
    expect(consent.headers.get("referrer-policy")).toBe("same-origin");
    expect(consent.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(consent.headers.get("cache-control")).toBe("no-store");
    const fields = { transaction: login.transaction, consent: login.consent, decision: "allow" };
    for (const headers of [{ cookie: login.cookie }, { cookie: login.cookie, origin: "null" },
      { cookie: login.cookie, origin: "https://foreign.fixture.example" }, { cookie: "", origin: issuer }]) {
      expect((await post(f, "/oauth/consent", fields, headers)).status).toBe(403);
    }
    expect((await post(f, "/oauth/consent", { ...fields, consent: "forged" }, { cookie: login.cookie, origin: issuer })).status).toBe(403);
    expect(f.service.diagnostics().pendingCodes).toBe(0);
    const accepted = await approve(f, login);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("referrer-policy")).toBe("no-referrer");
    expect(new URL(accepted.headers.get("location")!).searchParams.has("code")).toBe(true);
    expect((await approve(f, login)).status).toBe(403);
    expect(f.service.diagnostics().pendingCodes).toBe(1);
    expect((await publicRequest(f, "/oauth/jwks")).headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("binds code exchange to client, exact callback, resource and outer PKCE, consuming it once", async () => {
    const f = await start(), login = await authorized(f);
    for (const changes of [{ client_secret: "wrong" }, { redirect_uri: "https://evil.fixture.example" },
      { resource: "https://api.openai.com/v1" }, { code_verifier: verifier() }]) {
      const response = await exchange(f, login, changes); expect(response.status).not.toBe(200);
    }
    const exchanges = await Promise.all([exchange(f, login), exchange(f, login)]);
    expect(exchanges.map(r => r.status).sort()).toEqual([200, 400]);
    const tokens = await exchanges.find(r => r.status === 200)!.json();
    expect(tokens).toMatchObject({ scope: "bridge", token_type: "Bearer", expires_in: 900 });
    expect(JSON.stringify(tokens)).not.toContain("private-openai"); expect(tokens.id_token).toBeUndefined();
    const { verifier: bridge, oauth } = bridgeVerifier(f);
    const accepted = await bridge.authenticate("Bearer " + tokens.access_token);
    expect(accepted).toMatchObject({ status: "authenticated", authInfo: { extra: { bridgeMcpPrincipal: mcpOAuthPrincipal(oauth) } } });
    expect(await bridge.authenticate("Bearer " + f.lastIdToken())).toEqual({ status: "invalid" });
    expect(f.service.diagnostics().codeExchanges).toBe(1);
  });

  it("expires both pending browser transactions and issued authorization codes", async () => {
    const expiredLogin = await start(), login = await begin(expiredLogin); expiredLogin.advance(10 * 60_000 + 1);
    expect((await returnIdentity(expiredLogin, login)).status).toBe(403); expect(expiredLogin.tokenRequests()).toBe(0);
    const expiredCode = await start(), approval = await authorized(expiredCode); expiredCode.advance(60_001);
    expect((await exchange(expiredCode, approval)).status).toBe(400); expect(expiredCode.service.diagnostics().codeExchanges).toBe(0);
  });

  it("rejects expiry during awaited OpenAI verification and prevents callback replay", async () => {
    const f = await start(), login = await begin(f), release = f.holdToken();
    const pending = returnIdentity(f, login);
    await vi.waitFor(() => expect(f.tokenRequests()).toBe(1));
    expect((await returnIdentity(f, login)).status).toBe(403);
    f.advance(10 * 60_000 + 1); release();
    expect((await pending).status).toBe(403); expect(f.service.diagnostics().pendingCodes).toBe(0);
  });

  it("rotates refresh tokens with a stable principal and revokes their family on replay", async () => {
    const f = await start(), tokens = await (await exchange(f, await authorized(f))).json(), { verifier: bridge } = bridgeVerifier(f);
    const first = await bridge.authenticate("Bearer " + tokens.access_token);
    const refreshed = await refresh(f, tokens.refresh_token); expect(refreshed.status).toBe(200);
    const next = await refreshed.json(); expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const second = await bridge.authenticate("Bearer " + next.access_token);
    if (first.status !== "authenticated" || second.status !== "authenticated") throw new Error("Bridge token did not verify");
    expect(second.authInfo.extra).toEqual(first.authInfo.extra);
    expect((await refresh(f, tokens.refresh_token)).status).toBe(400);
    expect((await refresh(f, next.refresh_token)).status).toBe(400);
  });

  it("rejects refresh widening and enforces explicit revocation and absolute grant expiry", async () => {
    const f = await start(), tokens = await (await exchange(f, await authorized(f))).json();
    expect((await refresh(f, tokens.refresh_token, { scope: "bridge admin" })).status).toBe(400);
    expect((await refresh(f, tokens.refresh_token, { resource: "https://api.openai.com/v1" })).status).toBe(400);
    expect((await post(f, "/oauth/revoke", { client_id: client.id, client_secret: client.secret, token: tokens.refresh_token })).status).toBe(200);
    expect((await refresh(f, tokens.refresh_token)).status).toBe(400);
    const ttl = await start(), before = await (await exchange(ttl, await authorized(ttl))).json();
    ttl.advance(8 * 60 * 60_000 + 1); expect((await refresh(ttl, before.refresh_token)).status).toBe(400);
  });

  it("preserves the signed principal across restart but requires a new login for lost refresh grants", async () => {
    const f = await start(), tokens = await (await exchange(f, await authorized(f))).json();
    await f.service.close();
    const restarted = await start(f.selected), { verifier: bridge } = bridgeVerifier(restarted);
    expect((await bridge.authenticate("Bearer " + tokens.access_token)).status).toBe("authenticated");
    expect((await refresh(restarted, tokens.refresh_token)).status).toBe(400);
    const next = await (await exchange(restarted, await authorized(restarted))).json();
    const one = await bridge.authenticate("Bearer " + tokens.access_token), two = await bridge.authenticate("Bearer " + next.access_token);
    if (one.status !== "authenticated" || two.status !== "authenticated") throw new Error("Expected verified access");
    expect(two.authInfo.extra).toEqual(one.authInfo.extra);
  });

  it("stops refresh rotation at a finite bound instead of growing unbounded state", async () => {
    const f = await start();
    let tokens = await (await exchange(f, await authorized(f))).json();
    for (let i = 0; i < 64; i++) {
      const rotated = await refresh(f, tokens.refresh_token); expect(rotated.status).toBe(200); tokens = await rotated.json();
    }
    expect((await refresh(f, tokens.refresh_token)).status).toBe(400);
  });

  it("caps pending authorization records and does not accept oversized token requests", async () => {
    const f = await start();
    for (let i = 0; i < 128; i++) expect((await publicRequest(f, "/oauth/authorize?" + outer(f, verifier()))).status).toBe(200);
    expect((await publicRequest(f, "/oauth/authorize?" + outer(f, verifier()))).status).toBe(503);
    expect(f.service.diagnostics().pendingTransactions).toBe(128);
    expect((await post(f, "/oauth/token", { code: "x".repeat(20_000) })).status).toBe(413);
  });

  it("does not start implicitly or expose private config through CLI errors", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/mcpAuthCli.ts", "--help"], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0); expect(result.stdout).toContain("loopback-only");
    const missing = spawnSync(process.execPath, ["--import", "tsx", "src/mcpAuthCli.ts"], { encoding: "utf8", timeout: 10_000 });
    expect(missing.status).toBe(1); expect(missing.stderr).not.toContain(client.secret);
  });

  it("rejects readable private configuration before provider/network activity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-auth-cli-")), file = path.join(root, "private.json");
    try {
      await writeFile(file, JSON.stringify({ connectorClient: { secret: client.secret } }), { mode: 0o644 });
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/mcpAuthCli.ts", "--config", file], { encoding: "utf8", timeout: 10_000 });
      expect(result.status).toBe(1); expect(result.stderr).not.toContain(client.secret); expect(result.stdout).toBe("");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not follow private config or signing-key symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-auth-private-"));
    try {
      const key = path.join(root, "key.pem"), keyLink = path.join(root, "key-link.pem"), file = path.join(root, "config.json"), fileLink = path.join(root, "config-link.json");
      await writeFile(key, signingKeyPkcs8, { mode: 0o600 }); await symlink(key, keyLink);
      const selected = config();
      await writeFile(file, JSON.stringify({ ...selected, signingKeyPkcs8: undefined, signingKeyFile: keyLink }), { mode: 0o600 });
      await symlink(file, fileLink);
      for (const target of [fileLink, file]) {
        const result = spawnSync(process.execPath, ["--import", "tsx", "src/mcpAuthCli.ts", "--config", target], { encoding: "utf8", timeout: 10_000 });
        expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).not.toContain(client.secret);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses broker-issued and renewed tokens for real Bridge Events and one canonical B admission", async () => {
    const f = await start(), issued = await (await exchange(f, await authorized(f))).json();
    const renewed = await (await refresh(f, issued.refresh_token)).json();
    const root = await mkdtemp(path.join(tmpdir(), "bridge-openai-events-")), state = new BridgeStateStore({ file: path.join(root, "state.sqlite") });
    const { oauth } = bridgeVerifier(f);
    const config = loadConfig({ CODEX_MCP_BRIDGE_OAUTH_ISSUER: oauth.issuer, CODEX_MCP_BRIDGE_OAUTH_RESOURCE: oauth.resource,
      CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL: oauth.resourceMetadataUrl, CODEX_MCP_BRIDGE_OAUTH_JWKS_URI: oauth.jwksUri,
      CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT: oauth.operatorSubject, CODEX_MCP_BRIDGE_ROOTS: root,
      CODEX_MCP_BRIDGE_STATE_DATABASE_FILE: path.join(root, "state.sqlite"), CODEX_MCP_BRIDGE_TOKEN: randomBytes(32).toString("hex"), CODEX_MCP_BRIDGE_EVENTS_ENABLED: "1" });
    const selection = { model: "gpt-5.6-sol", reasoningEffort: "medium" }, settings = new UserSettingsStore(config, { stateStore: state });
    settings.update({ modelPolicy: { mode: "automatic", constraints: { allowDelegation: false },
      allowedSelections: { kind: "explicit", selections: [selection] } } }, settings.current.revision);
    settings.updateWithProjectOperations({}, [{ kind: "add", project: { name: "Fixture", cwd: root } }], undefined, settings.current.registryRevision);
    class Upstream implements CodexUpstream {
      calls = 0;
      async listTools() { return { tools: [{ name: "codex" }] }; }
      async callTool(_name: string, args: Record<string, unknown>): Promise<ToolResult> {
        this.calls++;
        return { content: [{ type: "text", text: "Isolated fixture result" }], structuredContent: { threadId: args.threadId || randomUUID(), content: "Isolated fixture result" } };
      }
      async close() {}
    }
    const upstream = new Upstream(), deliveries: any[] = [];
    const catalog: CodexModelCatalogProvider = { getCatalog: async () => ({ source: "codex-cli", cached: false,
      fetchedAt: new Date().toISOString(), fingerprint: "c".repeat(64), stale: false, validation: "valid",
      models: [{ id: selection.model, displayName: "Fixture", defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ effort: "medium" }], serviceTiers: [], inputModalities: ["text"] }] }) };
    const server = createHttpServer(config, upstream, catalog, { stateStore: state,
      oauthJwksFetch: async () => publicRequest(f, "/oauth/jwks"), eventWebhookSender: async (_url, body) => {
        const payload = JSON.parse(body); deliveries.push(payload);
        return { status: 200, body: JSON.stringify(payload.type === "verification" ? { challenge: payload.challenge } : {}) };
      } });
    const base = await listen(server), meta = { "openai/session": "broker-original-conversation", "openai/subject": "correlation-only" };
    async function rpc(method: string, params: Record<string, unknown>, token: string) {
      const response = await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + token,
        "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": params.name as string } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method,
          params: { ...params, _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "broker-fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) });
      return { response, body: await response.json() };
    }
    try {
      const rejected = await rpc("events/list", {}, f.lastIdToken()); expect(rejected.response.status).toBe(401);
      const list = await rpc("tools/list", {}, issued.access_token), props = list.body.result.tools.find((t: any) => t.name === "codex_task").inputSchema.properties;
      const taskArgs = { requestId: randomUUID(), taskContractVersion: props.taskContractVersion.const, executionEnvelopeRef: props.executionEnvelopeRef.const };
      const project = settings.current.projects[0];
      const admitted = await rpc("tools/call", { name: "codex_task", arguments: { ...taskArgs, prompt: "Read fixture A", selection,
        project: { name: project.name, projectRef: project.projectRef, projectRevision: project.projectRevision }, approvedFollowups: [{ prompt: "Read fixture B" }] } }, issued.access_token);
      expect(admitted.body.result.isError).not.toBe(true);
      const a = admitted.body.result.structuredContent;
      const event = { name: "codex.job.terminal", arguments: { jobId: a.jobId }, delivery: { mode: "webhook", url: "https://receiver.example.com/events", secret: "whsec_" + randomBytes(32).toString("base64") } };
      const sub = await rpc("events/subscribe", event, issued.access_token), resub = await rpc("events/subscribe", event, renewed.access_token);
      expect(sub.body.result.id).toBe(resub.body.result.id);
      await vi.waitFor(() => expect((state.listJobs().find((j: any) => j.jobId === a.jobId) as any)?.status).toBe("completed"));
      const status = await rpc("tools/call", { name: "codex_status", arguments: { query: { kind: "job", id: a.jobId } } }, renewed.access_token);
      await vi.waitFor(() => expect(deliveries.some(d => d.eventId)).toBe(true));
      expect(deliveries.find(d => d.eventId).data.availableFollowups).toEqual([{ followupId: a.approvedFollowups[0].followupId }]);
      const followup = { followupId: a.approvedFollowups[0].followupId, reviewedVersion: status.body.result.structuredContent.items[0].versions.job };
      const [one, two] = await Promise.all([issued.access_token, renewed.access_token].map(token => rpc("tools/call", { name: "codex_task",
        arguments: { ...taskArgs, requestId: randomUUID(), prompt: "Read fixture B", followup } }, token)));
      expect(one.body.result.structuredContent.jobId).toBe(two.body.result.structuredContent.jobId);
      await vi.waitFor(() => expect(upstream.calls).toBe(2));
      const retained = JSON.stringify(state.listJobs()) + JSON.stringify(state.listMeta("task_followup_v1/", 256));
      for (const token of [issued.access_token, renewed.access_token, f.lastIdToken(), "private-openai-api-token", "private-openai-refresh-token"]) expect(retained).not.toContain(token);
      expect(f.service.diagnostics()).toMatchObject({ modelRequests: 0, rawOpenAiCredentialsRetained: false });
    } finally { await close(server); state.close(); await rm(root, { recursive: true, force: true }); }
  });
});
