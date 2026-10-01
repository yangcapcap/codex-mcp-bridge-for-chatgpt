import { createHash } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { McpOAuthConfig } from "./config.js";

export const MCP_OAUTH_SCOPES = ["bridge"];
const MAX_TOKEN_BYTES = 16_384;
const MAX_JWKS_BYTES = 128 * 1_024;
export type McpAuthInfo = NonNullable<NonNullable<ServerContext["http"]>["authInfo"]>;

export function mcpOAuthPrincipal(config: McpOAuthConfig): string {
  return "bridge-oauth-" + createHash("sha256").update(JSON.stringify([
    "mcp-events/oauth-principal/v1", config.issuer, config.resource, config.operatorSubject
  ])).digest("hex");
}

export function oauthChallenge(config: McpOAuthConfig, error = "invalid_token"): string {
  return `Bearer resource_metadata="${config.resourceMetadataUrl}", scope="bridge", error="${error}", error_description="Link the configured Bridge operator account to continue"`;
}

export function oauthRequiredResult(config: McpOAuthConfig) {
  return { isError: true, content: [{ type: "text" as const, text: "Link the configured Bridge operator account to continue." }],
    _meta: { "mcp/www_authenticate": [oauthChallenge(config)] } };
}

/** One shared verifier/cache per HTTP runtime. Tokens and signing keys never enter SQLite. */
export class McpOAuthVerifier {
  private readonly keys;
  constructor(private readonly config: McpOAuthConfig, fetchJwks: typeof fetch = fetch) {
    this.keys = createRemoteJWKSet(new URL(config.jwksUri), {
      timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 5 * 60_000,
      [customFetch]: async (url, options) => {
        // JOSE pins this URL to operator configuration and rejects non-200 responses.
        // Header jku/x5u values never select a network destination.
        const response = await fetchJwks(url, { ...options, redirect: "manual" });
        if (response.status !== 200) { await response.body?.cancel(); throw new Error("OAuth JWKS unavailable."); }
        if (!response.body) throw new Error("OAuth JWKS is empty.");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_JWKS_BYTES) throw new Error("OAuth JWKS exceeds the size limit.");
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        return new Response(Buffer.concat(chunks), { status: 200, headers: { "content-type": "application/json" } });
      }
    });
  }

  async authenticate(header: string | undefined): Promise<McpAuthInfo | undefined> {
    if (!header || header.length > MAX_TOKEN_BYTES || !/^Bearer [A-Za-z0-9._-]+$/u.test(header)) return undefined;
    const token = header.slice(7);
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.issuer, audience: this.config.resource, subject: this.config.operatorSubject,
        algorithms: ["RS256", "PS256", "ES256", "EdDSA"], requiredClaims: ["exp", "sub", "scope"]
      });
      if (!Number.isSafeInteger(payload.exp) || payload.exp! <= Date.now() / 1_000 || payload.exp! > 8.64e12 ||
        payload.token_use === "id" || typeof payload.scope !== "string") return undefined;
      const scopes = payload.scope.split(/\s+/u).filter(Boolean);
      if (!MCP_OAUTH_SCOPES.every(scope => scopes.includes(scope))) return undefined;
      const client = payload.client_id || payload.azp;
      return { token, clientId: typeof client === "string" ? client : "oauth-client", scopes,
        expiresAt: payload.exp, resource: new URL(this.config.resource),
        extra: { bridgeMcpPrincipal: mcpOAuthPrincipal(this.config) } };
    } catch {
      // Do not reveal claims, token bytes, URLs, key material or verifier diagnostics.
      return undefined;
    }
  }
}
