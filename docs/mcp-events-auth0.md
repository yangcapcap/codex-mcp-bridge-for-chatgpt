# Auth0 configuration plan for the private Events trial

## Status and hosting

This runbook prepares a managed-provider option for
[issue #213](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/213).
Sources were checked on 2026-10-01 KST. No tenant, operator login, OAuth client
or installed connection has been configured. Auth0 is a candidate pending
operator selection; a complete login and Events trial remains required.

Auth0's [Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login)
hosts the login pages on its authorization service. The operator needs an
Auth0 account and tenant configuration, but does not need to host a login site.
The MCP bridge and Codex stay on the local machine, connected through the
[private HTTP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
Auth0 handles identity, consent and token issuance; project files, prompts,
results, callback destinations and signing secrets stay in the bridge's
existing execution and delivery paths.

The [Stytch MCP guide](https://stytch.com/docs/connected-apps/guides/mcp-auth-overview)
requires an application-hosted consent component. For an operator without a
public application, that adds a hosting task beyond the provider account.
Self-hosting an identity provider adds operation of a public HTTPS service.
This makes Auth0 a useful first configuration candidate. On 2026-10-01, the
[pricing page](https://auth0.com/pricing) lists Free at $0/month, includes Auth
for MCP and requires no card for signup. It describes a 22-day trial followed
by automatic Free activation, but excludes Role Management from Free. Use the
provider domain; verify the required user-permission configuration remains
available after trial expiry. A trial-only feature does not prove an ongoing
free configuration. Account creation and a paid plan remain unapproved.

## Choose the OAuth client registration method

[OpenAI supports](https://developers.openai.com/plugins/build/auth) CIMD, DCR
and predefined clients with authorization code and PKCE `S256`. The MCP bearer
is the user's access token. A client secret used during code exchange is a
different credential and is configured on the ChatGPT connection, not the
bridge or Codex.

For the first single-operator login trial, check the predefined-client path
first. Confirm that the actual ChatGPT/Tunnel management page supports its
settings and that the selected tenant supports the required permissions.
CIMD is a later option when its tenant and metadata requirements are met.

| Method | Configuration for this trial |
| --- | --- |
| Predefined client | First path to check for this trial. Register one third-party Regular Web Application, with authorization code, PKCE and a supported code-exchange method such as `client_secret_post`. Enter the issued client ID/secret in ChatGPT's OAuth configuration and allow its exact callback. Confirm this selection in the actual Tunnel connection UI. |
| CIMD | An option when the tenant supports the method in the actual ChatGPT metadata. Import the exact metadata URL from the connection management page. Auth0 documents `private_key_jwt` as Enterprise-only; ChatGPT's transition metadata also carries a singular preference. Verify import and token-exchange compatibility instead of assuming `none` will be selected. |
| DCR | Requires enabled registration and default third-party API access. It creates connection-specific clients. For this single-operator trial, use an individually registered client when available, rather than granting all dynamically registered clients default API access. |

Auth0's [CIMD guide](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application/manual-cimd-registration)
describes the tenant toggle, import, methods and plan requirement.
Its [manual registration guide](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application/manual-client-registration)
provides the predefined-client alternative. None of these methods substitutes
machine-to-machine grants for the operator's login. Do not modify or rehost
OpenAI's CIMD to change its declared authentication method.

## Configure the selected tenant

Use a dedicated test tenant and one permitted operator for the first trial.
Record tenant ownership and feature availability privately. Keep dashboard
credentials and any Management API credential out of the bridge environment.
This setup uses Auth0's hosted login; its sample MCP application, Token Vault,
On-Behalf-Of exchange and a separately deployed application are unnecessary
for the bridge's existing JWT verifier.

1. Capture the intended ChatGPT workspace/Tunnel, canonical HTTPS MCP resource,
   external protected-resource metadata URL and exact callback from the actual
   connection setup. These deployment-specific values remain pending. Do not
   copy the localhost resource in a provider sample or construct a Tunnel URL.
2. In **Settings > Advanced**, enable **Resource Parameter Compatibility
   Profile** and **Include Issuer in Authorization Responses**. Check the
   resulting discovery metadata and actual authorization response. Keep the
   discovery `issuer` string exactly, including a trailing slash.
3. Configure Universal Login and one Database or Social connection for the
   operator. For a third-party client, promote that selected connection to
   domain level. Obtain the operator's stable Auth0 user ID and verify that it
   is the access token's `sub`; email and dashboard-admin identity are not
   substitutes.

The [resource compatibility guide](https://auth0.com/ai/docs/mcp/guides/resource-param-compatibility-profile)
explains the two toggles. Without resource compatibility, an authorization
request using `resource` can miss the API audience. The
[third-party application guide](https://auth0.com/docs/get-started/applications/third-party-applications/configure-third-party-applications)
explains domain-level connections and per-application user-delegated grants.

## Register the Bridge API and permission

In **Applications > APIs**, register an API with Identifier equal to the exact
canonical HTTPS MCP resource and signing algorithm **RS256**. Choose an access
JWT profile such as **RFC 9068**, leave JWE disabled, and define permission
`bridge`. The current bridge accepts signed access JWTs, not encrypted or opaque
tokens. Auth0's [API settings](https://auth0.com/docs/get-started/apis/api-settings)
describe these settings; the Identifier is an audience identifier and does not
cause Auth0 to contact or publicly host the private bridge.

Enable **RBAC** and assign the `bridge` API permission to only the trial operator,
directly or through a dedicated role. With RBAC, requested permissions intersect
with assigned user permissions in the token's `scope`. A `permissions` array
alone does not satisfy the bridge's space-delimited `scope` check. See
[Auth0 RBAC](https://auth0.com/docs/get-started/apis/enable-role-based-access-control-for-apis).

Register the selected ChatGPT client and grant it **User-Delegated Access** to
this API with scope `bridge`, using the per-application policy. Configure the
callback and code-exchange method from the actual connection. For CIMD, enable
the tenant registration toggle and import/preview the exact OpenAI metadata;
check that the imported method is available on the tenant. For a predefined
client, retain its ID/secret while the connection is active. OAuth refresh
tokens can rotate independently of client credentials.

Set a finite access-token lifetime suitable for the short fixture trial and
record it. Subscription authorization expires no later than that token. If
refresh is used, enable API **Allow Offline Access** and the client's refresh
grant, and confirm ChatGPT actually refreshes. Enable any OIDC scopes advertised
by tenant discovery for this client. Provider-side revocation does not invalidate
an already issued JWT immediately at the bridge's offline verifier.

## Fill the isolated bridge configuration

Read the exact issuer and `jwks_uri` from the chosen tenant's public discovery,
then use the [adapter environment contract](mcp-events-authentication.md#configure-the-opt-in-adapter).
Record the actual values privately:

| Bridge setting | Source |
| --- | --- |
| `CODEX_MCP_BRIDGE_OAUTH_ISSUER` | Exact discovery issuer |
| `CODEX_MCP_BRIDGE_OAUTH_JWKS_URI` | Discovery's HTTPS signing-key endpoint |
| `CODEX_MCP_BRIDGE_OAUTH_RESOURCE` | Same canonical HTTPS value as the Auth0 API Identifier and ChatGPT `resource` |
| `CODEX_MCP_BRIDGE_OAUTH_RESOURCE_METADATA_URL` | Metadata URL verified through the intended Tunnel connection |
| `CODEX_MCP_BRIDGE_OAUTH_OPERATOR_SUBJECT` | Operator's verified access-token subject |

Use `NO_AUTH=0` and `EVENTS_ENABLED=1` with the full Bridge prefix. Keep a stable
local sealing secret of at least 32 bytes in `CODEX_MCP_BRIDGE_TOKEN`; an OAuth
client secret or access token must not replace it. Store the runtime environment
outside registered projects. Select a dedicated absolute
`CODEX_MCP_BRIDGE_STATE_DATABASE_FILE` for the fixture trial and a separate HTTP
Tunnel profile. Preserve that trial database and sealing key across restart
checks. The native app and installed operational database are separate from
this trial.

Start the existing secure HTTP launcher with the explicit trial environment,
Tunnel and profile. Resolve any active runtime owner before switching runtime;
do not bypass the single-runtime lock. The default OAuth profile name is
`codex-mcp-bridge-oauth`. Metadata discovery and a healthy Tunnel alone do not
prove a completed login.

## Record actual acceptance

Use the [actual acceptance sequence](mcp-events-authentication.md#actual-acceptance-sequence)
with a harmless fixture project. Store only redacted evidence; do not paste an
access token into chat, logs, public issues or an online JWT decoder.

A read-only ChatGPT UI check on 2026-10-01 found the new-plugin dialog's
Tunnel and OAuth choices. With the Tunnel ID unset, advanced OAuth settings
were disabled. No client-credential configuration or login was verified, and
the draft was cancelled without creating or changing a connection.

| Evidence | Current status |
| --- | --- |
| Selected provider, tenant and available client registration method | Pending operator selection/configuration |
| Discovery issuer/JWKS, PKCE `S256`, callback and audience binding | Pending actual connection |
| Operator login, `scope` containing `bridge`, token renewal and foreign-user denial | Pending actual connection |
| Authenticated Events subscription and actual conversation resume | Pending actual ChatGPT trial |
| GPT retrieves/reviews A; one admitted B and one upstream B execution | Pending actual ChatGPT trial |
| Repeated reference/event, restart and no-approval/foreign-scope controls | Pending actual ChatGPT trial |

ChatGPT's static review at the user's request judged the reported delivery/JWKS
fixes in `3ea31e3` acceptable. That assessment and this provider plan do not
establish the pending outcomes above or final human acceptance. Issue #213
remains open until the required installed-product evidence is recorded.
