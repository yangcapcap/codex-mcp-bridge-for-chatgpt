# Issue #213 — actual authenticated Tunnel discovery

Date: 2026-10-01 KST. Integration target: `dev`. Baseline: `a9ca90a`.

## Authorized trial and observed outcome

The operator approved a temporary Cloudflare Quick Tunnel for the separate
authorization service, a dedicated OpenAI Secure MCP Tunnel, a ChatGPT OAuth
test connector/conversation, and read-only fixture A/B execution once each.
Approval included transmitting the dedicated Bridge client credentials and
access tokens through Cloudflare/OpenAI. No paid service or permanent domain
was provisioned. Existing app, installed Tunnel profiles, operational SQLite
and Codex credentials were not changed.

The approved authorization-only HTTPS edge uses normal certificate validation.
Public requests cannot reach `/mcp`, project files, SQLite or local OpenAI
callbacks. The original OpenAI registration's verified operator/client binding
and six approved scopes are retained privately; no OpenAI token is copied from
Codex or retained by the authorization service.

Actual ChatGPT now discovers OAuth through the product secure HTTP launcher
without the diagnostic HTTP relay. The UI detects the registered-client path,
`bridge` scope, `client_secret_post`, public authorization/token endpoints,
canonical Tunnel resource and stable redirect
`https://chatgpt.com/connector_platform_oauth_redirect`.
The connector was created, and its login action reached the Bridge's real
authorization page. Private screenshots and status-only HTTP observations
record these outcomes.

Safari could not be opened because the Mac was locked and automatic unlock
was unavailable. The operator was asked to unlock it manually. At this boundary:

- OpenAI/Bridge composed verified logins: **0**.
- Bridge code exchanges and renewable grants: **0**.
- Actual Codex Jobs in the isolated DB: **0**.
- Authorization-service model requests: **0**.
- Actual authenticated Events resume and GPT A-review → one B: **not tested**.

These results establish real discovery and connector creation, not login,
Events acceptance or completion of #213. The issue remains OPEN.

## Failure and correction

The previous configuration required an off-origin public HTTPS URL for the
protected-resource metadata. Local metadata probes and `tunnel-client doctor`
passed, yet ChatGPT discovery returned “does not implement OAuth.” Manual
client configuration then failed validation of advertised PKCE `S256`, although
the authorization service did advertise it. No login or execution was started
by those failed creation attempts.

Official tunnel-client **0.0.14** source and documentation explain the boundary:
Harpoon needs a registered target, while off-origin discovered records retain
private-host registration restrictions. The trial found zero registered OAuth
metadata targets and unsupported Harpoon requests. An explicit public target
and exact-host classification did not establish the required private OAuth
metadata route. Those diagnostic configurations were discarded.

Advertising the Bridge's own loopback metadata source allowed one OAuth-tagged
private target to register. ChatGPT discovery then returned HTTP **200** and
exposed the exact resource/redirect. The product fix:

1. Allows HTTP **only** for protected-resource metadata at the exact loopback
   Bridge host/port and either supported metadata path. Credentials, query,
   fragment, whitespace, other ports/hosts/paths and non-loopback bindings fail.
2. Keeps issuer, resource/audience and JWKS strictly HTTPS.
3. Adds `--harpoon.allow-plaintext-http=true` only for this validated OAuth
   source in the secure HTTP launcher; HTTPS and No Auth behavior is preserved.
4. Retains Host/Origin checks, JWT/operator/scope verification and all existing
   Job/Events/followup ownership checks. No Harpoon control session is routed
   into the actual Bridge MCP server.

The final trial runs the production launcher, compiled server and actual
tunnel-client. Its private CLI wrapper supplies only the task-owned profile
directory, without modifying requests, metadata or responses. An initial
wrapper incorrectly added the profile-directory argument to `health`, which
does not support that argument; the launcher correctly refused readiness.
After correcting that test-only wrapper, readiness and real ChatGPT OAuth
discovery both succeeded. The diagnostic relay was stopped.

## Executed validation

- Focused OAuth/launcher/runtime/profile checks: **4 files, 56 passed**.
- Full local affected validation: **115 Node files, 1,196 passed**.
- Swift: **216 executed, 2 skipped, 0 failures**.
- Release/localization, TypeScript and pinned Codex CLI **0.153.3** schema
  checks passed. These are local results, not independent GitHub CI.
- UTF-8, local Markdown links, private-value exclusion and Git diff checks
  passed for the final source/document changes.

The new regressions verify exact loopback host/port/path boundaries, reject
HTTP issuer/resource/JWKS, exercise the actual HTTP Bearer challenge and
metadata while denying unauthenticated/foreign-operator Events, and run the
managed launcher with both HTTPS and loopback metadata to check the actual
Tunnel arguments and profile reuse/identity changes.

Private evidence excludes secrets from published records. Enrollment IDs,
Tunnel ID, operator profile/hash, client secret, signing/sealing keys, raw
authorization codes and bearer/refresh tokens are not committed or included
in GitHub status updates. Active test services require retaining their private
runtime checkout until shutdown; this is not a conversation cleanup action.

## Primary references

- [OpenAI authenticated MCP](https://developers.openai.com/plugins/build/auth)
- [OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Tunnel 0.0.14 connectors](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/connectors.md)
- [Tunnel 0.0.14 configuration](https://github.com/openai/tunnel-client/blob/v0.0.14/docs/configuration.md)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
