# Issue 213: local OpenAI / Bridge authorization implementation

## Scope and disposition

This work starts from `dev` at
`254a2122add91425407d781c51b2298495774189` on 2026-10-01 KST. After the
successful real OpenAI open-source registration/sign-in trial, the user asked
to continue and selected **local implementation and isolated verification**
because no public HTTPS domain/server is available.

The opt-in [authorization service](../mcp-events-openai-authorization.md) now
implements the missing application-owned Bridge token issuer. Its listeners
are loopback-only. It uses prior verified operator enrollment, separates
OpenAI login from Bridge consent, and issues Bridge credentials accepted by
the existing OAuth adapter. Public deployment and actual ChatGPT/Tunnel
acceptance remain pending; #213 stays open.

## Implementation and boundaries

- `src/openaiMcpAuthorization.ts` serves authorization-server metadata,
  public Ed25519 keys, authorization, consent, token and refresh-revocation
  routes. One preregistered connector client uses `client_secret_post` with
  PKCE S256 and an exact resource/callback. There is no CIMD/DCR advertisement,
  MCP dispatch, project-file route, operational DB access or model execution.
- OpenAI sign-in reuses an issued open-source client ID and host ID. Its state,
  nonce, PKCE verifier and loopback callback are separate from the connector
  transaction. Pinned discovery/JWKS endpoints, RS256 signature, issuer,
  audience, nonce, expiry and applicable `azp` checks precede the exact
  configured operator match. OpenAI tokens/profile values are not persisted,
  passed to ChatGPT or used as Bridge access tokens.
- Independent Bridge consent requires the original browser cookie, exact
  POST Origin and consent nonce. Single-use codes are hash-indexed, expire
  after one minute and are consumed before asynchronous signing. Access JWTs
  have `bridge` scope, the Bridge resource audience and at most 15 minutes
  of validity. Rotating refresh grants have an absolute eight-hour expiry;
  replay revokes the grant family. Browser and grant ledgers are bounded.
- The service keeps a stable Bridge subject across token renewal and restart.
  Restart drops pending transactions/codes and renewable sessions; it does
  not rewrite Jobs or followup receipts. Offline access JWT revocation is
  bounded by token expiry, as disclosed in Bridge consent and the runbook.
- `src/mcpAuthCli.ts` requires explicit private configuration and a private
  Ed25519 key. Ownership/permissions and reading use the same no-follow file
  descriptor. The command is opt-in, has no default-launcher hook and stops
  its listeners on SIGINT/SIGTERM. The existing installed executable contract
  is preserved; use the source script or explicit compiled entry point.

The existing No Auth connection still cannot authorize Events. The native
selected-partner Continue with ChatGPT plugin experience is a separate
contract and is not enabled by this prototype. The operator browser must run
on the same computer as the OpenAI loopback listener.

## Local verification

The new feature file contains **28 passing tests**, using local HTTP provider
and JWKS fixtures and real production authorization handlers. Cases cover
invalid identity/signature/claims, state/cookie/replay, exact client/callback/
resource/PKCE, independent consent and CSRF, concurrent code redemption,
expiry while awaiting validation, provider failure, refresh rotation/reuse,
revocation, restart, ledger limits and private-file/symlink rejection.

The integration case passes service-issued and renewed JWTs through actual
Bridge HTTP MCP handlers and a temporary SQLite database. The OpenAI ID token
is rejected. The two Bridge tokens yield the same subscription and principal;
terminal delivery contains the system-issued followup reference. Exact A
result offering precedes concurrent B requests with different caller UUIDs.
They converge on one admitted B Job; the fixture upstream runs A and B once
each. The test checks that token bytes are absent from retained Jobs/receipts.
This is a synthetic upstream, not evidence of actual GPT review or host resume.

The compiled CLI also started with **real OpenAI public discovery** and prior
verified enrollment metadata in private local configuration. Its issuer,
resource and connector callback were explicitly fake HTTPS addresses. Actual
loopback metadata/JWKS requests succeeded, JWKS contained public keys only,
and `/mcp` returned 404. Both listeners were confirmed on `127.0.0.1` and the
task-owned process was stopped. No composed real login, Bridge user grant,
OpenAI token refresh or model request was attempted in this smoke check.

Locally executed checks:

| Check | Result |
| --- | --- |
| TypeScript build and release/localization validation | Passed; 50 active release fragments |
| Pinned Codex CLI 0.153.3 schema | Passed; 416 JSON and 827 TypeScript files |
| Full Node suite with four workers | 115 files, 1,193 tests passed |
| macOS strict-concurrency/warnings-as-errors suite | 216 tests, 2 skipped, 0 failures |
| Changed-file UTF-8, local documentation links and diff whitespace | 9 UTF-8 files, 42 local links and whitespace checks passed |
| Model inference / operational configuration changes | 0 |

Earlier attempts are not omitted: the first full Node run had one existing
Helper login test fail while waiting one second for a child marker; an
immediate isolated retry also failed, and the unchanged 33-test file later
passed. The underlying startup delay was not established as a product defect.
A fast retry using the desktop CLI 0.159.0 failed the required reproducibility
pin. A subsequent global CLI override caused four existing dotenv/CLI-selection
tests to use the override rather than their fixture commands. Final validation
uses the pinned CLI on a validation-only PATH with both CLI overrides unset;
all 1,193 Node tests pass without editing those existing tests or product paths.
`npm run validate:affected` completed successfully for the eight implementation
and runbook paths (`Node=true, macOS=true`). This audit was added after those
code checks; the final documentation checks cover all nine paths and fast
validation was repeated. These are local execution results, not independent
GitHub CI evidence.

No public host/account was provisioned, installed app/operational DB/Tunnel
configuration was changed, or Codex credential was copied. Public reports and
repository changes exclude real enrollment IDs, identity hashes, profile data,
authorization codes, tokens, client secrets and signing keys. The release
fragment requests MINOR under the repository's 0.x feature policy.

## Remaining acceptance

The [runbook](../mcp-events-openai-authorization.md#evidence-still-required)
retains public HTTPS hosting, the real ChatGPT preregistration/callback UI,
the composed OpenAI/Bridge consent flow, actual authenticated Events resume,
GPT review of A followed by one approved B, and the host controls/restart
acceptance. Local implementation completes the authorized scope of this step;
it does not close #213 or establish production authorization-service acceptance.
