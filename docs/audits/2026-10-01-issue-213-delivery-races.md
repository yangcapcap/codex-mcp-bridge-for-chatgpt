# Issue 213: delivery grant races and JWKS outages

## Basis and disposition

This correction starts from `dev` at
`0eafc8fbf1fc695bbfe97461ea24c661692b4356` on 2026-10-01 KST.
ChatGPT's static review, performed at the user's request, identified stale
subscription writes across webhook awaits and provider lookup failures
reported as invalid credentials.
The isolated regressions reproduced both problems before production changes.
Issue #213 remains open for provider configuration and actual ChatGPT acceptance.

## Subsequent static review assessment

On 2026-10-01 KST, ChatGPT, at the user's request, statically reviewed production
changes and regression cases at
`3ea31e323588c714bdc998d98bbad0b16d983381` through the GitHub plugin and judged
the delivery/renewal revision corrections and JWKS outage classification
acceptable. That review found no further acceptance-blocking defect in those
changed paths and confirmed that remote `dev` matched the reviewed commit.

The earlier wording incorrectly attributed this tool use and static review
to the human user. This record now identifies ChatGPT as the reviewer and
keeps any final human acceptance separate, requiring its own explicit evidence.
The review covered the two reported defects and related code paths; it did not
independently rerun tests, verify local cleanup or complete issue #213. The local
results below retain their original scope. These two defects no longer block
provider configuration or the actual ChatGPT trial; authenticated login,
conversation resume, GPT review of A and one execution of approved B still
require installed-product evidence.

## Reproduction and correction

Four added regressions failed on the original code: S2 unsubscribe during S1
delivery was undone (revision 2 returned to 1 and S2 was sent); S2 renewal during
S1 delivery lost its replacement key/expiry/revision; an ACK committed during
renewal callback verification was overwritten and caused a second delivery;
an expired JWKS cache during provider HTTP failure returned 401 rather than
service-unavailable. These were deterministic promise-gated HTTP/SQLite
fixtures, not failures injected into the installed app.

The journal now compares an explicitly supplied grant revision in the existing
State writer transaction. Creation uses expected revision zero; a stale update
cannot replace a newer grant or recreate a deleted record. Delivery writes keep
the grant revision, while unsubscribe/revocation/HTTP 410 disablement advance it.
Terminal intent still shares the result transaction; a failed comparison aborts
that transaction rather than committing a result without its intent.

The delivery list supplies only identities. Before each send the worker reads
the exact current record, checks disabled state, expiry, pending status and
retry budget/deadline, and persists the attempt with the expected revision.
After the response it reads again and rejects a changed/disabled/expired grant
or a changed event/delivery state before saving from the latest record. Renewal
also reads again after callback verification and preserves the latest event,
attempts, ACK/status, retry deadline and result recovery boundary. Already
started requests can finish after grant changes, but cannot overwrite those
changes. No second writer, database, schema migration or supervisor was added.

OAuth verification now reports authenticated, invalid and unavailable outcomes.
Trusted-JWKS fetch/parsing/key-resolution failures return a generic 503 with
`Retry-After: 5` and `retryable: true`, without `WWW-Authenticate` or
`mcp/www_authenticate`. Usable-key signature/claim failures and unknown keys
still follow the invalid-token path. Fresh cached keys remain usable. No token,
provider diagnostic, key material or lookup URL is exposed by the new response.
The request does not dispatch a handler or alter existing execution/receipts.

## Verification and limits

The added grant regressions use two subscriptions for the same held Job and
gate the first real delivery while an HTTP request unsubscribes or renews the
second. They verify the final grant, actual callback count, replacement-key
signature and one upstream execution. The unsubscribe
case also proves the journal rejects a direct stale-revision write. A separate
verification gate allows delivery ACK to commit before renewal and verifies
that acknowledgement/retry/recovery state remains intact with no resend.

The JWKS HTTP tests cover both provider 503 and real socket failure after a
previously usable cache expires. They preserve the original Jobs and approval
receipt, return retryable 503 for Events and exact-result tool requests without
re-login metadata, then recover the same token/result/followup references.
Expired tokens still receive the authentication challenge. Verifier fixtures
also cover redirected, oversized, malformed, unavailable and timed-out key
lookups. The timeout error fixture exercises classification; the existing
five-second production deadline is unchanged.

Targeted Events, OAuth, webhook and HTTP server validation passed: 4 files,
89 tests. Full `npm run validate:affected` passed for 11 changed paths: 114 Node
test files / 1,165 tests passed; 216 Swift tests executed, 2 skipped, 0 failures.
Required TypeScript, release/localization, pinned CLI 0.153.3 schema and macOS
localization checks passed. Local Markdown targets and the Git diff check also
passed. Five new regression cases are included in the full Node result.
All results are local synthetic evidence, not independently observed GitHub CI
or actual ChatGPT login, delivery, resume, GPT review or B execution.
Provider accounts, installed app, operational SQLite/authentication and Tunnel
settings were not changed.
