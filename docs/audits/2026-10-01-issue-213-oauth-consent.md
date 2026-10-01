# Issue #213 — browser consent Origin correction

Date: 2026-10-01 KST. Integration target: `dev`. Baseline: `789791b`.

## Actual trial and failure

After the Mac was unlocked, the already approved temporary HTTPS issuer,
dedicated private HTTP Tunnel and ChatGPT OAuth test connector were reused.
A fresh authorization request was opened in the operator's selected Safari.
OpenAI sign-in and the pinned operator/client identity verification succeeded.
The public Bridge consent page returned HTTP 200; its subsequent form POST
returned HTTP 403. Status-only diagnostics recorded one verified OpenAI login,
zero Bridge code exchanges/grants and zero authorization-service model requests.
The isolated Bridge DB contained zero actual Codex Jobs.

The verified OpenAI login does not establish a completed ChatGPT/Bridge grant.
No access token, authorization code, cookie or raw OpenAI profile was copied
from the browser or included in published records.

## Cause and correction

The shared response headers used `Referrer-Policy: no-referrer`, including the
consent HTML. For a browser form POST, that policy causes an opaque (`null`)
Origin under the [Fetch standard](https://fetch.spec.whatwg.org/#append-a-request-origin-header).
The consent handler correctly requires the exact configured issuer Origin,
so the page's own policy prevented the valid form from satisfying its check.

A separate task-owned loopback HTML fixture was exercised through the actual
In-app Browser. With `no-referrer` its normal form POST produced an opaque
Origin; with `same-origin` it produced the fixture's exact origin. Only outcome
categories and timestamps were retained. Safari's actual 403 and successful
inner login were observed, but its raw request headers were not captured.
The fixture confirms the browser policy mechanism; it is not a completed
Safari/ChatGPT acceptance test.

Only the verified GET consent page now uses `Referrer-Policy: same-origin`.
Cross-origin destinations receive no referrer, and all other responses,
including the authorization-code redirect, keep `no-referrer`. The exact
issuer Origin requirement, secure browser-bound cookie, one-time nonce,
expiry, CSP `form-action 'self'` and no-store policy remain intact. Null,
absent and foreign Origins are still rejected. No token or Events ownership
check was loosened.

The added real-handler regression failed against the old header before the
fix. It checks the corrected page policy, rejects absent/null/foreign Origins,
missing cookie and forged consent, then accepts a single valid POST while
preserving `no-referrer` on the code redirect. Consent replay remains denied.

## Retry boundary and validation

The isolated authorization process was replaced with the newly compiled
handler after checking task ownership, zero live grants/codes and zero Jobs.
The task-owned HTTPS edge and its hostname were retained. Pending browser
transactions were discarded and a fresh ChatGPT authorization request created.
Safari was then blocked by another Mac lock; a manual unlock was requested.
The diagnostic HTML server/tab were closed after recording the reproduction.

- Focused OpenAI authorization, JWT/OAuth and Events tests: **105 passed**.
- Full local affected validation: **115 Node files, 1,197 passed**;
  **216 Swift executed, 2 skipped, 0 failures**. Release/localization,
  TypeScript and pinned Codex CLI **0.153.3** schema checks passed.
  These are local checks, not independent GitHub CI.
- Actual composed Bridge grant, authenticated Events resume and GPT review of
  A followed by one B: **pending**. Issue #213 remains OPEN.

Existing operational SQLite, installed Tunnel profiles and Codex credentials
were not changed. The active private test services still require their task
checkout; worktree cleanup follows shutdown, without changing conversations.

The [subsequent In-app Browser trial](2026-10-01-issue-213-inapp-oauth.md)
completed the composed OAuth grant after also correcting the consent form's
callback redirect policy. The Mac-lock boundary above describes this earlier
trial stage, not the latest authentication status.
