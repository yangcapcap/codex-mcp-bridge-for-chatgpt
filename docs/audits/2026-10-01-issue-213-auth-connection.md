# Issue 213: authenticated product connection design

## Basis and disposition

This investigation starts from `dev` at
`7090cf1b7f3bc7716f6ae28e8448866d5026a8b2` on 2026-10-01 KST. The user accepted
the system-issued followup implementation and requested the official supported
connection and necessary configuration first, with no existing OAuth/OIDC
provider. The resulting [connection design](../mcp-events-authentication.md)
selects user OAuth 2.1 over a private HTTP Secure MCP Tunnel.

The design is documented; the product connection is not implemented or tested.
Issue #213 stays open for provider configuration, the bridge adapter and actual
ChatGPT Events acceptance. Issue #214 is a separate execution-provider concern.

## Evidence

- [OpenAI authentication](https://developers.openai.com/plugins/build/auth):
  user authorization-code with PKCE `S256`, protected resource discovery,
  resource-bound tokens, CIMD/DCR/predefined clients and actual-page redirect
  configuration. Customer-defined API keys and machine-to-machine grants do
  not provide this ChatGPT connection. A stable user identity must be verified
  independently of the OAuth client application ID.
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels):
  private MCP OAuth discovery can traverse Tunnel; the authorization server
  remains separately reachable. Transport credentials are not user credentials.
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events):
  the MCP `2026-07-28` event methods use the same authenticated endpoint as
  tools, with authorization before callback verification and subscription.
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt):
  validate individual capabilities before complete installed-plugin acceptance.

Read-only local inspection confirmed the current constraints:

- `src/server.ts` returns 404 for protected resource metadata and performs
  the installation-token bearer check without OAuth discovery/challenges.
- `src/mcpEvents.ts` binds its operator and callback vault to that bearer.
  `AuthInfo.clientId` currently holds the bridge's own bearer principal; it is
  not a verified OAuth user identity.
- `scripts/start-codex-mcp-bridge.mjs` selects `sample_mcp_remote_no_auth` for
  HTTP and forces `CODEX_MCP_BRIDGE_NO_AUTH=1`. `src/stdio.ts` also forces No Auth.
- Installed `tunnel-client` is
  `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`. Its help and built-in profile
  samples distinguish No Auth from OAuth discovery. A ready/doctor result is
  transport/discovery evidence, not end-user authentication or Events resume.

No provider was selected or provisioned, no Tunnel/profile/login configuration
was changed, and no installed app or operational database was modified. No
actual ChatGPT connection, OAuth login, callback or Codex execution was run.
The actual resource/audience and redirect remain configuration evidence to
capture from the chosen connection, rather than guessed values.

## Verification

This change only adds or clarifies documentation and a release change fragment.
`npm run validate:affected` passed for all seven changed paths: localization,
release metadata/policy and the exact Codex CLI 0.153.3 App Server schema checks
(416 JSON and 827 TypeScript files). The path selector correctly required no
Node or macOS implementation tests. `git diff --check` and local Markdown link
target checks also passed. Validation used Node 24.11.1 and npm 11.6.2 with the
pinned CLI first on the validation-only PATH and the global CLI override unset.

These are local documentation checks, not independent GitHub CI results. The
earlier Node/Swift implementation results remain in their original audit and
do not establish OAuth or actual host acceptance.
