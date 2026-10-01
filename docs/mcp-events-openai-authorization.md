# Local OpenAI / Bridge authorization prototype

## Status and scope

On 2026-10-01, the operator selected **local implementation and isolated
verification**, with no public HTTPS domain/server. This opt-in prototype
implements the missing Bridge token issuer. The operator subsequently approved
a temporary authorization-only HTTPS trial and a separate ChatGPT connector.
Actual ChatGPT OAuth discovery and connector creation now succeed through the
product launcher. Safari completed OpenAI sign-in and verified the pinned
operator, but the separate Bridge consent failed because the page's
`no-referrer` policy made a normal browser POST use an opaque Origin. The
consent page now uses `same-origin`; exact issuer Origin, browser cookie and
one-time consent checks remain enforced. A fresh retry awaits another manual
Mac unlock. No Bridge grant, actual Events resume or A/B execution has completed. The service
is not selected by the default launcher or connected to the installed app.
[Issue #213](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/213)
remains open. The [successful OpenAI registration trial](mcp-events-authentication.md#openai-sign-in-trial)
is evidence of identity sign-in, not this composed connector flow.

The [public OpenAI open-source flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
uses a local callback and requests `openid profile email offline_access
resource.invoke chatgpt.tokens.use.direct`. This prototype reuses an already
issued registration and a verified operator identity hash. It does not enroll
an unknown operator, copy Codex credentials, store OpenAI tokens, refresh them,
or make model/API inference calls. Initial verified enrollment is still a
separate operator step. The [native Continue with ChatGPT plugin experience](https://developers.openai.com/siwc/chatgpt-plugin)
has a separate selected-partner contract; this service does not enable that
modal or claim that partner registration is complete.

## Two independent transactions

```mermaid
sequenceDiagram
    participant C as ChatGPT OAuth client
    participant U as Operator browser on the Bridge computer
    participant A as Bridge authorization service
    participant O as OpenAI sign-in
    participant B as Private HTTP MCP bridge
    C->>A: Registered client, exact callback, Bridge resource, outer PKCE
    A-->>U: Bound browser session and local sign-in link
    U->>A: Loopback sign-in start
    A-->>U: OpenAI authorize URL with independent state/nonce/PKCE
    U->>O: Login and approved OpenAI scope request
    O-->>A: Loopback OpenAI callback
    A->>O: Exchange OpenAI code and verify ID token
    A->>A: Match the pinned operator; discard OpenAI credentials
    A-->>U: Separate Bridge consent bound to the outer browser session
    U->>A: Allow or deny Bridge connection
    A-->>C: Single-use Bridge code and original outer state plus issuer
    C->>A: Client secret, exact callback/resource and outer verifier
    A-->>C: Bridge access JWT and bounded rotating Bridge refresh token
    C->>B: MCP request through private Tunnel using Bridge access JWT
    B->>B: Existing issuer/audience/operator/scope verification
```

The outer flow follows the [MCP authorization contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
and [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth).
An OpenAI ID token or OpenAI API token is never returned as the connector's
token. The inner and outer state, PKCE, callbacks, codes and client identities
are kept separate. Login alone cannot produce a Bridge authorization code.
The operator must allow the separate Bridge consent, with browser-cookie,
Origin and consent-nonce checks. Denial returns only `access_denied` to the
configured callback with the original state and exact issuer.

Because the OpenAI callback is loopback, the browser must run on the computer
hosting this service. A phone or another computer is not a supported sign-in
surface for this prototype. Public HTTPS hosting remains necessary for the
outer discovery, authorization, token and key endpoints. The
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
does not automatically host the authorization server.

## Bounded implementation

`src/openaiMcpAuthorization.ts` is separate from MCP dispatch and the existing
Job writer. Both its HTTP listeners bind to `127.0.0.1`; the public-facing
listener additionally requires the configured issuer Host. It serves only
OAuth metadata, public keys and its authorization/consent/token/revocation
routes. It has no MCP, Codex, project-file or operational-database routes.

The initial profile permits one configured operator and one preregistered
connector client using `client_secret_post` plus PKCE `S256`. It advertises
neither CIMD nor DCR. Unknown clients, callback changes, duplicate parameters,
scope expansion, resource changes and PKCE downgrade fail before OpenAI sign-in
or token issuance. The exact real ChatGPT callback and supported preregistration
UI still need to be verified at deployment; fixture URLs are not configuration
evidence.

OpenAI discovery and JWKS fetches are pinned to the documented HTTPS endpoints,
reject redirects and bound time and response size. ID tokens require RS256,
exact issuer and issued-client audience, subject, expiry, issue time and nonce;
applicable `azp` checks and the configured identity hash must match. Invalid
tokens cannot create connector authority. Necessary provider/JWKS failures
return a safe retryable `503`; neither token bytes nor provider diagnostics
appear in responses or logs.

Browser transactions expire after ten minutes and connector codes after one
minute. Codes are hashed in the temporary ledger and consumed synchronously
before signing, so concurrent redemptions cannot create two grants. Bridge
access JWTs use a separate Ed25519 key, `bridge` scope, the exact Bridge audience
and a subject derived from the pinned operator hash. Their lifetime is at most
15 minutes. Bridge refresh grants have an absolute eight-hour lifetime, rotate
on each use and revoke their family on reuse; they cannot widen scope or
resource. Rotation is limited to 64 per grant. These are Bridge credentials,
not retained OpenAI credentials.

There are at most 128 pending browser transactions, 128 pending codes and 128
renewable grants. Expired or revoked records are pruned on requests and
diagnostic reads. This prototype uses one process and bounded memory; it adds
no SQLite schema, workflow database, supervisor or Job polling loop.

Restart discards pending sign-ins, codes and refresh grants, requiring fresh
login. With the same configured issuer/resource/operator and signing key,
already issued access JWTs remain valid until their short expiry, and the
Bridge principal remains stable. Existing Jobs and followup receipts are not
rewritten. Refresh revocation or OpenAI logout does not immediately invalidate
offline-verified Bridge JWTs. This limit is shown in connector consent; an
immediate-revocation or multi-instance deployment needs further design before
claiming those properties.

## Explicit private configuration

The service requires a prior verified OpenAI registration, system-issued host
ID and operator hash. The hash is SHA-256 of the unambiguous JSON encoding of
`["https://auth.openai.com", issuedClientId, verifiedSubject]`. Obtain it from
verified enrollment, not an email, browser hint, caller input or decoded but
unverified JWT. An OpenAI registration change requires a reviewed enrollment
change; it is not silently accepted as the same operator.

Keep the JSON config and an Ed25519 PKCS#8 signing-key file in an operator-owned
private directory outside registered projects. Files must be regular,
operator-owned and inaccessible to group/others; symlinks are rejected and file
checks/read use the same opened descriptor. The CLI requires POSIX ownership
and no-follow file support; it fails closed on unsupported platforms. The
config must contain the exact future public HTTPS issuer origin, canonical
Bridge resource and callback copied from the actual ChatGPT connection page.
The issuer for this first profile has no path or trailing slash. Placeholders
below are documentation, not a working or publicly deployed connection:

```json
{
  "issuer": "https://<authorization-host>",
  "resource": "https://<actual-canonical-bridge-resource>/mcp",
  "openaiClientId": "<issued-openai-client-id>",
  "hostId": "<stable-system-issued-urn-uuid>",
  "operatorIdentityHash": "<verified-operator-hash>",
  "connectorClient": {
    "id": "<system-issued-connector-client-id>",
    "secret": "<separate-random-connector-secret-of-at-least-32-bytes>",
    "redirectUri": "<exact-callback-from-chatgpt-management-page>"
  },
  "signingKeyFile": "signing-key.pem",
  "authorizationPort": 0,
  "callbackPort": 0
}
```

The key file is resolved relative to the JSON config. The signing key,
connector-client secret and Bridge installation sealing key have different
purposes. Do not substitute a rotating OpenAI token for any of them.

For the source checkout, the explicit command is:

```sh
npm run bridge:auth -- --config /private/operator-config/bridge-auth.json
```

After building, use `node dist/mcpAuthCli.js --config <private-json-file>`.
`--help` performs no network or
configuration access. Startup never occurs through the default Bridge
launcher. The command does not provision public HTTPS, modify the installed
app/Tunnel or open a login browser. It logs only local listener addresses and
safe status, and both task-owned listeners stop on SIGINT/SIGTERM.

When an approved HTTPS deployment is available, configure the existing
[Bridge OAuth adapter](mcp-events-authentication.md#configure-the-opt-in-adapter)
with the service's exact issuer, `issuer + "/oauth/jwks"`, canonical resource
and subject `bridge-operator-<operatorIdentityHash>`. Capture the actual
resource and callback from ChatGPT's successful OAuth discovery. For the
private HTTP Tunnel, advertise the Bridge's own loopback protected-resource
metadata route; the [adapter configuration](mcp-events-authentication.md#configure-the-opt-in-adapter)
describes the exact host/port boundary and conditional Harpoon flag. The public
authorization issuer is separate from this private metadata source. Keep the
installation sealing key stable and use a new authenticated A for acceptance; existing No Auth Jobs
do not acquire OAuth ownership. Expose only the authorization listener's routes
at the approved HTTPS edge, preserving Host, cookies and POST Origin. The
OpenAI callback listener and MCP server remain private.

## Evidence still required

The [implementation audit](audits/2026-10-01-issue-213-openai-authorization.md)
records locally executed checks, retry history and the compiled CLI smoke check.
The [live discovery audit](audits/2026-10-01-issue-213-tunnel-oauth-discovery.md)
records the subsequent approved HTTPS/Tunnel trial and current login boundary.
The [consent audit](audits/2026-10-01-issue-213-oauth-consent.md) records the later
successful OpenAI verification, browser POST regression and correction.

The isolated tests use a local HTTP OpenAI/JWKS fixture, real authorization
handlers, actual Bridge HTTP MCP dispatch and a temporary SQLite database.
They verify negative identity/transaction cases, consent, code consumption,
expiry while awaiting validation, refresh/replay/revocation, restart and limits.
An integration case uses this service's signed access tokens and its public
keys, rather than fixture-minting Bridge tokens, for Events subscription and
renewal, result offering, and simultaneous requests for the same approved B.
One B is admitted and the fixture upstream executes A and B once each. This
does not show that a real GPT reviewed A or that actual ChatGPT resumed.

Before #213 can be completed:

1. Select and approve the public HTTPS deployment and exact issuer/resource.
2. Verify the real ChatGPT predefined-client UI/callback and discovery/token
   compatibility, and complete the composed real OpenAI/Bridge consent flow.
3. Run the actual authenticated ChatGPT/Tunnel Events and A-review-to-one-B
   acceptance sequence, including the required controls and restart cases.
4. Review operational hosting, rate limits and revocation requirements. A
   successful local prototype is not a production OAuth deployment audit.
