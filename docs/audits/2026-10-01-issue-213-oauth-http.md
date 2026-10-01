# Issue 213: OAuth HTTP adapter

## Basis and disposition

This implementation starts from `dev` at
`fea344de650a969d9856af95d8e0c040dd21da21` on 2026-10-01 KST, after the
[official connection design](2026-10-01-issue-213-auth-connection.md).
It implements the provider-configurable JWT resource-server side and an
authenticated HTTP Tunnel launcher path. It does not provision a login provider
or implement an authorization server. Issue #213 stays open for actual provider
configuration and ChatGPT host acceptance.

The bridge and Codex remain private. A managed provider can host the required
public HTTPS login/token endpoints; the operator need not run a login server.
This is nevertheless a new external authentication dependency. No provider or
hosting option has been selected, and the current No Auth installation is
unchanged.

## Authentication boundary

The explicit profile requires exact HTTPS issuer, resource, metadata and JWKS
URLs plus a provider-issued operator subject. No Auth and stdio combinations
fail closed. `jose` verifies asymmetric access-JWT signatures against the pinned
operator-configured JWKS URL, exact issuer/audience/subject, expiry, not-before
and a space-delimited scope containing `bridge`. Opaque tokens and introspection
are outside this initial profile. HMAC, token-selected key URLs and the local
installation sealing key cannot grant MCP access.

Verified issuer/subject/resource produce a stable principal stored separately
from SDK `AuthInfo.clientId`. Token refresh, JWT ID changes and client-application
ID changes do not change ownership or durable followup identities. Static
bearer ownership remains compatible, but is never transferred automatically
to an OAuth user. OAuth access tokens and JWT signing keys never enter SQLite.

The HTTP server publishes protected resource metadata and Bearer challenges.
Only protocol/tool discovery is available anonymously. Tool calls without a
valid login return `_meta["mcp/www_authenticate"]` without entering the handler.
Each tool advertises OAuth scopes in `_meta` and in the HTTP descriptor. The
current SDK projects away nonstandard top-level descriptor fields; the HTTP
adapter adds that OpenAI extension after standard encoding. The ordinary MCP
version/schema contract is preserved.

Subscriptions use the original principal and conversation scope, and their
expiry cannot exceed the verified token expiry. The callback challenge is
followed by a second expiry/authorization check. Expired grants stop delivery;
reauthorization can renew the same identity without rerunning the Job. The
stable installation token remains the callback encryption key in OAuth mode,
not an alternative MCP login. Offline JWT verification does not promise
immediate identity-provider revocation before the finite expiry.

The launcher uses the OAuth-discovery HTTP sample and a distinct default
profile, preserves explicit authentication, checks complete configuration and
includes its digest in managed profile identity. OAuth doctor failures cannot
take the No Auth exception. MCP login configuration and sealing credentials
are stripped from Codex and Tunnel children.

These changes follow [OpenAI authentication](https://developers.openai.com/plugins/build/auth),
including its tool-level linking requirements, the [descriptor metadata reference](https://developers.openai.com/plugins/reference#_meta-fields-on-tool-descriptor),
and [Secure MCP Tunnel OAuth discovery](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Verification and limits

The new fixture uses real JWT signatures, an isolated HTTP JWKS server, the
production HTTP MCP handler, the current SDK client, temporary SQLite and a
fixture Codex upstream. It exercises invalid claims/signatures, metadata and
linking, key rotation, bounded/redirected/unavailable JWKS, retained ownership,
renewal, callback expiry races and A/B deduplication across restart. The launcher
trial starts the built bridge over real loopback HTTP with temporary runtime
state and a fixture Tunnel process, verifies authorization remains enforced,
and checks profile reuse and operator changes. It does not contact OpenAI or
complete a provider authorization-code/browser-login flow.

Full `npm run validate:affected` passed with the repository-pinned Codex CLI
0.153.3 on the validation path. Results: 114 Node test files / 1,160 tests passed;
216 Swift tests executed, 2 skipped, 0 failures. This includes 25 new OAuth
tests and the additional authenticated launcher integration case. TypeScript,
release fragments, shared CLI options and all 1,390 macOS strings across nine
languages passed their required checks. These are local verification results,
not independently observed GitHub CI or installed-product acceptance.

The installed app, operational database, authentication and Tunnel settings
were not changed.
Actual ChatGPT login, event delivery, conversation resume, GPT result review,
upper Chat model/Pro behavior and B execution remain unverified.
