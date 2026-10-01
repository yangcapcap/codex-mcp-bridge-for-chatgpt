# Issue #213 — In-app Browser OAuth connection

Date: 2026-10-01 KST. Integration target: `dev`. Baseline: `4aef89c`.

## Observed result

The already approved temporary HTTPS issuer, dedicated private HTTP Tunnel,
registered ChatGPT client and six-scope OpenAI sign-in were retried in the
**Codex In-app Browser**. Recipient, scopes and grant lifetime were unchanged.
No permanent hosting, paid account or separate provider account was created.

At **2026-10-01 10:53:09 UTC (19:53:09 KST)** ChatGPT exchanged the single-use
Bridge code successfully: `/oauth/token` returned **200**. Diagnostics recorded
one verified OpenAI login, one code exchange and one renewable Bridge grant.
ChatGPT subsequently displayed the connected account. Its app page listed
17 tools and `codex.job.terminal`, and a real authenticated project query
returned the isolated fixture project's Bridge-issued selector.

This proves the composed OAuth connection can complete in the In-app Browser.
Safari and a Mac unlock were not needed for this retry. It does not establish
all browser/account configurations or completion of #213. Private screenshots,
status-only HTTP observations and sanitized runtime/DB summaries retain the
trial evidence. The authorization service made **zero model requests** and
retained **no raw OpenAI credentials**; the subsequent Codex A turn is a
separate model execution and is not included in that zero count.

## Additional browser correction

The initial In-app retry successfully verified OpenAI sign-in and submitted
Bridge consent with the correct issuer Origin. The handler returned **303**,
but the browser blocked the redirect to ChatGPT because the page's CSP allowed
only `form-action 'self'`. A browser security log explicitly reported this
violation. No Bridge code exchange/grant occurred in that failed retry; the
unused code expired without being extracted or manually navigated to.

The verified consent GET now allows `'self'` and the **configured HTTPS callback
origin** in its form policy. The server still constructs only the **complete
registered callback URI**, with its existing query preserved, and checks the
exact client/callback/resource and outer PKCE during exchange. CSP is not
claimed to bind the callback path or query. Callback hostnames containing CSP
delimiters, quotes or wildcards are rejected before listeners/provider activity.
Other pages and code-redirect responses retain their original restrictive CSP
and `no-referrer`. Consent keeps `same-origin`, exact POST Origin, the secure
browser cookie, one-time nonce, expiry, no-store and framing/base restrictions.

This is a narrow policy correction, not acceptance of an absent/null/foreign
Origin or arbitrary callback. The isolated authorization process was replaced
with the compiled correction after checking task ownership and zero live
codes/grants/Jobs; its task-owned HTTPS edge was retained. A fresh transaction
then completed through normal browser UI without header interception, cookie
copying, custom token minting or security-warning bypass.

Primary policy reference: [W3C CSP form-action](https://www.w3.org/TR/CSP3/#directive-form-action).

## Executed validation

- New real-handler checks failed before the correction and pass afterward.
  They verify the consent-only callback origin, exact redirect/path/query,
  nondefault port and rejection of policy delimiters, wildcard and quote hosts.
- Focused OpenAI authorization, OAuth/JWKS and Events checks: **109 passed**.
- Full local affected validation: **115 Node files, 1,201 passed**;
  **216 Swift executed, 2 skipped, 0 failures**. Release/localization,
  TypeScript and pinned Codex CLI **0.153.3** schema checks passed.
- These are local executed results, not independent GitHub CI.

## Actual A and remaining host boundaries

In one newly authorized ChatGPT test conversation, A was admitted **once** with
the exact approved fixture prompt and one exact approved B declaration. The
isolated DB records a verified MCP principal, `sandbox=read-only`, one issued
followup receipt and one terminal Codex turn. Its execution-access receipt
confirms no network access and zero writable roots.

The A turn is marked `completed`, but its retained result says the local
command runner failed to start and the fixture could not be read. It returned
neither the required JSON nor `canProceed=true`. Turn completion is therefore
**not fixture success or approval to run B**. No A retry or B was admitted.
The command-runner cause has not yet been established.

Before an explicit plugin rescan, this chat reported no callable native MCP
Events subscription facility or host-provided callback/secret. That observation
alone did not exclude a cached catalog. At the operator's request, the trial
plugin's **Refresh tools** action was run from its management page. A repeat
with status-only browser observation confirmed the refresh request returned
HTTP **200**, and the app's tool/event catalog still listed `codex.job.terminal`.
The original conversation was reloaded and explicitly asked to subscribe only
to its existing A; it again reported no callable subscription facility. A fresh
test conversation created through the trial app also reported no exposed
native subscription facility after a capability-only diagnostic request.

The isolated subscription journal remained empty: no stored subscription,
verified challenge, webhook receipt or Events-based resume was observed.
There is still exactly one A and no B; rescan and both diagnostic turns did
not request another Codex execution. These are observations of the tested
conversations after rescan, not a claim that all ChatGPT hosts lack Events or
proof of the cause. Catalog visibility and actual subscription are distinct
acceptance steps in the [official Events test procedure](https://developers.openai.com/plugins/build/mcp-events).

During the later checks, ChatGPT's requests to `/oauth/token` also returned
200 after the original 15-minute access lifetime, with no new browser login or
authorization-code exchange. This is evidence of token renewal in this live
process; issuer restart/grant persistence and subscription renewal are not
established by it.

The existing live-card completion path also selected the ordinary installed
Bridge instead of the test connection. Its retained-result query was denied
with `HANDLE_UNAVAILABLE`; explicitly mentioning the test app allowed the
original A to be read in the same conversation. The current
[Dashboard completion prompt](../../ui-resources/dashboard.html) hardcodes
the ordinary app name. This observed routing limitation is recorded separately
from Events; this change does not modify the card or claim it fixed. It did
not create another Codex Job or authorize B.

**#213 remains OPEN.** Native subscription/delivery/resume, a successful A JSON
review followed by exactly one B, restart/renewal controls and actual host
mode/usage behavior remain unverified. Permanent HTTPS hosting is still an
operator decision. Existing operational DB, installed profiles and Codex
credentials were preserved. The active private services require retaining
their task branch/checkout until shutdown; no conversations were changed for
cleanup.
