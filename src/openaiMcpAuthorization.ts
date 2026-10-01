import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { calculateJwkThumbprint, createRemoteJWKSet, customFetch, errors, exportJWK, jwtVerify, SignJWT } from "jose";

const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_RESOURCE = "https://api.openai.com/v1";
export const OPENAI_LOCAL_SIGN_IN_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"];
const OPENAI_AUTHORIZE = `${OPENAI_ISSUER}/api/accounts/authorize`;
const OPENAI_TOKEN = `${OPENAI_ISSUER}/api/accounts/oauth/token`;
const OPENAI_JWKS = `${OPENAI_ISSUER}/.well-known/jwks.json`;
const TRANSACTION_MS = 10 * 60_000;
const CODE_MS = 60_000;
const ACCESS_SECONDS = 15 * 60;
const GRANT_MS = 8 * 60 * 60_000;
const MAX_RECORDS = 128;
const MAX_ROTATIONS = 64;
const MAX_BODY = 16_384;
const MAX_PROVIDER_BODY = 128 * 1_024;
const PUBLIC_COOKIE = "__Host-bridge-oauth";
const LOCAL_COOKIE = "bridge-openai-local";

/** A separate, opt-in authorization service. Its listeners are always loopback-only. */
export interface OpenAiMcpAuthorizationConfig {
  issuer: string;
  resource: string;
  openaiClientId: string;
  hostId: string;
  operatorIdentityHash: string;
  connectorClient: { id: string; secret: string; redirectUri: string };
  signingKeyPkcs8: string;
}
export interface OpenAiMcpAuthorizationOptions {
  fetchOpenAi?: typeof fetch;
  now?: () => number;
}
interface Transaction {
  id: string;
  browserHash: string;
  outerState: string;
  challenge: string;
  expiresAt: number;
  phase: "waiting" | "signing-in" | "verifying" | "verified";
  inner?: { state: string; nonce: string; verifier: string; browserHash: string };
  consent?: string;
}
interface AuthorizationCode { challenge: string; expiresAt: number }
interface Grant { expiresAt: number; revoked: boolean; rotations: number }
interface RefreshRecord { grantId: string; active: boolean; expiresAt: number }

class FlowError extends Error {
  constructor(readonly status: number, readonly error: string) { super(error); }
}
function fail(status = 400, error = "invalid_request"): never { throw new FlowError(status, error); }
function randomValue() { return randomBytes(32).toString("base64url"); }
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function equal(left: string | undefined, right: string) {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function openAiOperatorIdentityHash(clientId: string, subject: string) {
  return digest(JSON.stringify([OPENAI_ISSUER, clientId, subject]));
}
export function openAiMcpOperatorSubject(identityHash: string) { return `bridge-operator-${identityHash}`; }
function httpsUrl(value: string, query = false) {
  if (typeof value !== "string" || value.length > 2_048 || /\s/u.test(value)) throw new Error("Authorization configuration requires exact HTTPS URLs.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (!query && url.search)) {
    throw new Error("Authorization configuration requires exact HTTPS URLs.");
  }
  return url;
}
function validate(config: OpenAiMcpAuthorizationConfig) {
  const issuer = httpsUrl(config.issuer);
  if (issuer.origin !== config.issuer) throw new Error("The authorization issuer must be a canonical HTTPS origin without a trailing slash or path.");
  httpsUrl(config.resource);
  const redirect = httpsUrl(config.connectorClient.redirectUri, true);
  if (["code", "state", "iss", "error"].some(name => redirect.searchParams.has(name))) throw new Error("The registered callback contains reserved authorization parameters.");
  for (const id of [config.openaiClientId, config.connectorClient.id]) {
    if (!/^[A-Za-z0-9_-]{8,200}$/u.test(id) || id === "dynamic_agent_client") throw new Error("Use issued OpenAI registration and an explicit connector client ID.");
  }
  if (!/^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(config.hostId) ||
      !/^[a-f0-9]{64}$/u.test(config.operatorIdentityHash)) throw new Error("Use verified operator registration metadata.");
  if (typeof config.connectorClient.secret !== "string" || Buffer.byteLength(config.connectorClient.secret) < 32 ||
      config.connectorClient.secret.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(config.connectorClient.secret)) throw new Error("The connector client needs a bounded secret of at least 32 bytes.");
}
function parameters(value: string) {
  const params = new URLSearchParams(value);
  for (const key of params.keys()) if (params.getAll(key).length !== 1) fail();
  return params;
}
function cookie(req: IncomingMessage, name: string) {
  const matches = (req.headers.cookie || "").split(";").map(p => p.trim()).filter(p => p.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/gu, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
function page(title: string, content: string) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:18px/1.6 -apple-system,sans-serif;margin:64px auto;max-width:680px;padding:24px;color:#17232b}button,a{font:inherit}button{padding:8px 20px}a{color:#2365a5}</style><h1>${escapeHtml(title)}</h1>${content}`;
}
function headers(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}
function html(res: ServerResponse, title: string, content: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(title, content));
}
function redirect(res: ServerResponse, url: string) { res.writeHead(303, { location: url }).end(); }
async function form(req: IncomingMessage) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/iu.test(req.headers["content-type"] || "") ||
      Number(req.headers["content-length"]) > MAX_BODY) fail(413);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); length += bytes.length;
    if (length > MAX_BODY) fail(413);
    chunks.push(bytes);
  }
  return parameters(Buffer.concat(chunks).toString("utf8"));
}
async function listen(server: Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    const error = (reason: Error) => reject(reason);
    server.once("error", error);
    server.listen(port, "127.0.0.1", () => { server.off("error", error); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

/** No files, Bridge DB, Codex credentials, model requests, or OpenAI token persistence. */
export async function createOpenAiMcpAuthorization(input: OpenAiMcpAuthorizationConfig, options: OpenAiMcpAuthorizationOptions = {}) {
  validate(input);
  const config = Object.freeze({ ...input, connectorClient: Object.freeze({ ...input.connectorClient }) });
  const signingKey = createPrivateKey(config.signingKeyPkcs8);
  if (signingKey.asymmetricKeyType !== "ed25519") throw new Error("The authorization service requires an Ed25519 signing key.");
  const publicKey = await exportJWK(createPublicKey(signingKey));
  const kid = await calculateJwkThumbprint(publicKey);
  const publicJwk = Object.freeze({ ...publicKey, kid, alg: "EdDSA", use: "sig" });
  const fetchOpenAi = options.fetchOpenAi || fetch;
  const now = options.now || Date.now;
  const providerFetch: typeof fetch = async (url, init) => {
    if (![`${OPENAI_ISSUER}/.well-known/openid-configuration`, OPENAI_TOKEN, OPENAI_JWKS].includes(String(url))) fail(503, "authentication_unavailable");
    try {
      const timeout = AbortSignal.timeout(10_000);
      const response = await fetchOpenAi(url, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); fail(503, "authentication_unavailable"); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_PROVIDER_BODY) fail(503, "authentication_unavailable");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return new Response(Buffer.concat(chunks), { status: 200, headers: { "content-type": "application/json" } });
    } catch { fail(503, "authentication_unavailable"); }
  };
  async function providerJson(url: string, init?: RequestInit) {
    try { return await (await providerFetch(url, init)).json() as Record<string, any>; }
    catch { fail(503, "authentication_unavailable"); }
  }
  const discovery = await providerJson(`${OPENAI_ISSUER}/.well-known/openid-configuration`);
  if (discovery.issuer !== OPENAI_ISSUER || discovery.authorization_endpoint !== OPENAI_AUTHORIZE ||
      discovery.token_endpoint !== OPENAI_TOKEN || discovery.jwks_uri !== OPENAI_JWKS ||
      !discovery.code_challenge_methods_supported?.includes("S256")) throw new Error("OpenAI discovery does not match the configured sign-in contract.");
  const openaiKeys = createRemoteJWKSet(new URL(OPENAI_JWKS), { timeoutDuration: 5_000, [customFetch]: providerFetch });
  const transactions = new Map<string, Transaction>();
  const codes = new Map<string, AuthorizationCode>();
  const grants = new Map<string, Grant>();
  const refreshTokens = new Map<string, RefreshRecord>();
  let callbackBase: string | undefined;
  let publicBase: string | undefined;
  let codeExchanges = 0;
  let verifiedLogins = 0;
  let closed = false;
  function prune() {
    const time = now();
    for (const [id, record] of transactions) if (record.expiresAt <= time) transactions.delete(id);
    for (const [id, record] of codes) if (record.expiresAt <= time) codes.delete(id);
    for (const [id, record] of grants) if (record.revoked || record.expiresAt <= time) grants.delete(id);
    for (const [id, record] of refreshTokens) if (record.expiresAt <= time || !grants.has(record.grantId)) refreshTokens.delete(id);
  }
  function browserTransaction(req: IncomingMessage, id: string | null) {
    const transaction = id ? transactions.get(id) : undefined;
    if (!transaction || transaction.expiresAt <= now() || !equal(digest(cookie(req, PUBLIC_COOKIE) || ""), transaction.browserHash)) fail(403, "access_denied");
    return transaction;
  }
  function connectorClient(params: URLSearchParams) {
    if (!equal(params.get("client_id") || undefined, config.connectorClient.id) ||
        !equal(params.get("client_secret") || undefined, config.connectorClient.secret)) fail(401, "invalid_client");
  }
  function callback(outerState: string, outcome: { code?: string; error?: string }) {
    const url = new URL(config.connectorClient.redirectUri);
    url.searchParams.set("state", outerState);
    url.searchParams.set("iss", config.issuer);
    if (outcome.code) url.searchParams.set("code", outcome.code);
    else url.searchParams.set("error", outcome.error!);
    return url.toString();
  }
  async function issue(grantId: string, grant: Grant) {
    const token = randomValue(), time = Math.floor(now() / 1_000);
    const refreshHash = digest(token);
    refreshTokens.set(refreshHash, { grantId, active: true, expiresAt: grant.expiresAt });
    try {
      const expires = Math.min(time + ACCESS_SECONDS, Math.floor(grant.expiresAt / 1_000));
      if (expires <= time) fail(400, "invalid_grant");
      const accessToken = await new SignJWT({ scope: "bridge", client_id: config.connectorClient.id })
        .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid }).setIssuer(config.issuer)
        .setAudience(config.resource).setSubject(openAiMcpOperatorSubject(config.operatorIdentityHash))
        .setIssuedAt(time).setExpirationTime(expires).setJti(randomUUID()).sign(signingKey);
      if (closed || grant.revoked || grant.expiresAt <= now()) fail(400, "invalid_grant");
      return { token_type: "Bearer", access_token: accessToken, refresh_token: token, expires_in: expires - time, scope: "bridge" };
    } catch (error) { refreshTokens.delete(refreshHash); throw error; }
  }
  function safeHandler(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    return (req: IncomingMessage, res: ServerResponse) => {
      headers(res); prune();
      void handler(req, res).catch(error => {
        if (res.writableEnded || res.destroyed) return;
        const failure = error instanceof FlowError ? error : new FlowError(503, "authentication_unavailable");
        if (failure.status === 503) res.setHeader("Retry-After", "5");
        json(res, failure.status, { error: failure.error, ...(failure.status === 503 ? { retryable: true } : {}) });
      });
    };
  }
  const publicServer = createServer({ maxHeaderSize: MAX_BODY }, safeHandler(async (req, res) => {
    if (closed || req.headers.host !== new URL(config.issuer).host) fail(400);
    const url = new URL(req.url || "/", config.issuer);
    if (url.origin !== config.issuer || (req.url || "").length > 8_192) fail();
    const params = parameters(url.search);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, { issuer: config.issuer, authorization_endpoint: `${config.issuer}/oauth/authorize`,
        token_endpoint: `${config.issuer}/oauth/token`, revocation_endpoint: `${config.issuer}/oauth/revoke`,
        jwks_uri: `${config.issuer}/oauth/jwks`, scopes_supported: ["bridge"], response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["client_secret_post"],
        revocation_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true }); return;
    }
    if (req.method === "GET" && url.pathname === "/oauth/jwks") { json(res, 200, { keys: [publicJwk] }); return; }
    if (req.method === "GET" && url.pathname === "/oauth/authorize") {
      if (params.get("response_type") !== "code" || params.get("client_id") !== config.connectorClient.id ||
          params.get("redirect_uri") !== config.connectorClient.redirectUri || params.get("resource") !== config.resource ||
          params.get("scope") !== "bridge" || params.get("code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/u.test(params.get("code_challenge") || "") ||
          !params.get("state") || params.get("state")!.length > 2_048) fail();
      if (!callbackBase || transactions.size >= MAX_RECORDS) fail(503, "temporarily_unavailable");
      const browser = randomValue(), id = randomValue();
      transactions.set(id, { id, browserHash: digest(browser), outerState: params.get("state")!,
        challenge: params.get("code_challenge")!, expiresAt: now() + TRANSACTION_MS, phase: "waiting" });
      res.setHeader("Set-Cookie", `${PUBLIC_COOKIE}=${browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
      html(res, "Bridge를 ChatGPT에 연결", `<p>이 컴퓨터에서 OpenAI 계정을 확인한 뒤 Bridge 연결 권한을 선택합니다.</p><p>OpenAI 로그인은 요금제 사용·API 접근·갱신 권한을 요청합니다. 이 인증 서비스는 모델을 호출하거나 OpenAI 토큰을 보관하지 않습니다.</p><p><a href="${escapeHtml(callbackBase + "/auth/start?transaction=" + id)}">OpenAI 계정으로 로그인</a></p>`); return;
    }
    if (req.method === "GET" && url.pathname === "/oauth/consent") {
      const transaction = browserTransaction(req, params.get("transaction"));
      if (transaction.phase !== "verified" || !transaction.consent) fail(403, "access_denied");
      html(res, "Bridge 연결 권한 확인", `<p>등록된 운영자 계정의 OpenAI 로그인을 확인했습니다.</p><p>ChatGPT가 Bridge의 작업·결과·이벤트에 접근하도록 허용합니다. 개별 작업 실행은 Bridge의 기존 승인 정책을 따릅니다.</p><p>연결 권한은 최대 8시간 유지됩니다. 연결을 해제해도 이미 발급된 접근 권한은 최장 15분간 유효할 수 있습니다.</p><p>대상: ${escapeHtml(config.resource)}</p><form method="post" action="/oauth/consent"><input type="hidden" name="transaction" value="${transaction.id}"><input type="hidden" name="consent" value="${transaction.consent}"><button name="decision" value="allow">연결 허용</button> <button name="decision" value="deny">취소</button></form>`); return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/consent") {
      if (req.headers.origin !== config.issuer) fail(403, "access_denied");
      const body = await form(req), transaction = browserTransaction(req, body.get("transaction"));
      if (transaction.phase !== "verified" || !transaction.consent || !equal(body.get("consent") || undefined, transaction.consent) ||
          !["allow", "deny"].includes(body.get("decision") || "")) fail(403, "access_denied");
      if (body.get("decision") === "deny") {
        transactions.delete(transaction.id); redirect(res, callback(transaction.outerState, { error: "access_denied" })); return;
      }
      if (codes.size >= MAX_RECORDS) fail(503, "temporarily_unavailable");
      const code = randomValue();
      codes.set(digest(code), { challenge: transaction.challenge, expiresAt: now() + CODE_MS });
      transactions.delete(transaction.id);
      redirect(res, callback(transaction.outerState, { code })); return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const body = await form(req); connectorClient(body);
      if (body.get("resource") !== config.resource) fail(400, "invalid_target");
      if (body.get("grant_type") === "authorization_code") {
        const codeHash = digest(body.get("code") || ""), code = codes.get(codeHash), verifier = body.get("code_verifier") || "";
        if (!code || code.expiresAt <= now() || body.get("redirect_uri") !== config.connectorClient.redirectUri ||
            !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier) ||
            !equal(createHash("sha256").update(verifier).digest("base64url"), code.challenge)) fail(400, "invalid_grant");
        if (grants.size >= MAX_RECORDS) fail(503, "temporarily_unavailable");
        // Consume before signing/awaiting. One code cannot admit two grants.
        codes.delete(codeHash);
        const id = randomValue(), grant = { expiresAt: now() + GRANT_MS, revoked: false, rotations: 0 };
        grants.set(id, grant);
        const tokens = await issue(id, grant); codeExchanges++;
        json(res, 200, tokens); return;
      }
      if (body.get("grant_type") === "refresh_token") {
        if (body.has("scope") && body.get("scope") !== "bridge") fail(400, "invalid_scope");
        const record = refreshTokens.get(digest(body.get("refresh_token") || "")), grant = record && grants.get(record.grantId);
        if (!record || !grant || grant.revoked || grant.expiresAt <= now()) fail(400, "invalid_grant");
        if (!record.active || grant.rotations >= MAX_ROTATIONS) { grant.revoked = true; fail(400, "invalid_grant"); }
        record.active = false; grant.rotations++;
        json(res, 200, await issue(record.grantId, grant)); return;
      }
      fail(400, "unsupported_grant_type");
    }
    if (req.method === "POST" && url.pathname === "/oauth/revoke") {
      const body = await form(req); connectorClient(body);
      const record = refreshTokens.get(digest(body.get("token") || "")), grant = record && grants.get(record.grantId);
      if (grant) grant.revoked = true;
      json(res, 200, {}); return;
    }
    fail(404, "not_found");
  }));
  const callbackServer = createServer({ maxHeaderSize: MAX_BODY }, safeHandler(async (req, res) => {
    if (!callbackBase || closed || req.headers.host !== new URL(callbackBase).host || req.method !== "GET") fail();
    const url = new URL(req.url || "/", callbackBase);
    if (url.origin !== callbackBase || (req.url || "").length > 8_192) fail();
    const params = parameters(url.search);
    if (url.pathname === "/auth/start") {
      const transaction = transactions.get(params.get("transaction") || "");
      if (!transaction || transaction.phase !== "waiting" || transaction.expiresAt <= now()) fail(403, "access_denied");
      const browser = randomValue(), verifier = randomValue();
      transaction.phase = "signing-in";
      transaction.inner = { state: randomValue(), nonce: randomValue(), verifier, browserHash: digest(browser) };
      const authorize = new URL(OPENAI_AUTHORIZE);
      authorize.search = new URLSearchParams({ client_id: config.openaiClientId, ext_agent_host_id: config.hostId,
        redirect_uri: callbackBase + "/auth/callback", response_type: "code", scope: OPENAI_LOCAL_SIGN_IN_SCOPES.join(" "),
        resource: OPENAI_RESOURCE, state: transaction.inner.state, nonce: transaction.inner.nonce,
        code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
      res.setHeader("Set-Cookie", `${LOCAL_COOKIE}=${browser}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600`);
      redirect(res, authorize.toString()); return;
    }
    if (url.pathname !== "/auth/callback") fail(404, "not_found");
    const transaction = [...transactions.values()].find(t => t.phase === "signing-in" && t.inner && equal(params.get("state") || undefined, t.inner.state));
    if (!transaction?.inner || transaction.expiresAt <= now() || !equal(digest(cookie(req, LOCAL_COOKIE) || ""), transaction.inner.browserHash)) fail(403, "access_denied");
    const inner = transaction.inner;
    transaction.phase = "verifying";
    try {
      const code = params.get("code"), returnedClient = params.get("client_id");
      if (params.has("error") || !code || code.length > MAX_BODY || (returnedClient !== null && returnedClient !== config.openaiClientId)) fail(403, "access_denied");
      const tokens = await providerJson(OPENAI_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.openaiClientId, code,
          code_verifier: inner.verifier, redirect_uri: callbackBase + "/auth/callback", resource: OPENAI_RESOURCE }) });
      if (typeof tokens.id_token !== "string" || tokens.id_token.length > MAX_BODY || typeof tokens.scope !== "string" ||
          tokens.scope.split(/\s/u).filter(Boolean).some((scope: string) => !OPENAI_LOCAL_SIGN_IN_SCOPES.includes(scope))) fail(403, "access_denied");
      const { payload } = await jwtVerify(tokens.id_token, async (header, jws) => {
        try { return await openaiKeys(header, jws); }
        catch (error) {
          if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) throw error;
          fail(503, "authentication_unavailable");
        }
      }, { issuer: OPENAI_ISSUER, audience: config.openaiClientId,
        algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat", "nonce"], currentDate: new Date(now()) })
        .catch(error => { if (error instanceof FlowError) throw error; fail(403, "access_denied"); });
      if (typeof payload.sub !== "string" || !payload.sub || !equal(payload.nonce as string | undefined, inner.nonce) ||
          (payload.azp !== undefined && payload.azp !== config.openaiClientId) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.openaiClientId) ||
          !equal(openAiOperatorIdentityHash(config.openaiClientId, payload.sub), config.operatorIdentityHash)) fail(403, "access_denied");
      if (closed || transaction.expiresAt <= now() || transactions.get(transaction.id) !== transaction) fail(403, "access_denied");
      // Retain only the pinned operator match and a new connector-consent nonce.
      // OpenAI codes, ID/access/refresh tokens and profile values leave no ledger.
      transaction.phase = "verified"; transaction.consent = randomValue(); transaction.inner = undefined;
      verifiedLogins++;
      res.setHeader("Set-Cookie", `${LOCAL_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0`);
      redirect(res, `${config.issuer}/oauth/consent?transaction=${transaction.id}`);
    } catch (error) { transactions.delete(transaction.id); throw error; }
  }));
  for (const server of [publicServer, callbackServer]) {
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  }
  return {
    publicServer, callbackServer,
    async listen(ports: { authorization?: number; callback?: number } = {}) {
      if (closed || callbackBase || publicBase) throw new Error("This authorization service cannot be started again.");
      try {
        callbackBase = await listen(callbackServer, ports.callback ?? 0);
        publicBase = await listen(publicServer, ports.authorization ?? 0);
        return { authorizationBase: publicBase, callbackBase, callbackUri: callbackBase + "/auth/callback" };
      } catch (error) { closed = true; await close(callbackServer); await close(publicServer); throw error; }
    },
    async close() {
      closed = true;
      transactions.clear(); codes.clear(); grants.clear(); refreshTokens.clear();
      await close(publicServer); await close(callbackServer);
    },
    diagnostics() { prune(); return { pendingTransactions: transactions.size, pendingCodes: codes.size,
      renewableGrants: grants.size, verifiedLogins, codeExchanges, modelRequests: 0, rawOpenAiCredentialsRetained: false }; }
  };
}
