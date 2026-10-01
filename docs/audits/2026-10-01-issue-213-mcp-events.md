# Issue 213: exact-Job Events implementation and acceptance boundary

This record describes `8b8d40a`. The subsequent
[system-issued followup ID review](2026-10-01-issue-213-issued-followups.md)
replaces caller-named steps and clarifies the product connection gate.

## Basis

This work started from clean `dev` and `origin/dev` at
`5747072d392769414fc7b82b0797b7417bdfeb71` on 2026-10-01 KST, using
[issue #213](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/213)
and the [official MCP Events contract](https://developers.openai.com/plugins/build/mcp-events).
The endpoint stays on MCP `2026-07-28`, SDK v2 (`@modelcontextprotocol/server`
2.0.0), task contract 6 and the existing ordinary request-hash generation.
Standard Webhooks 1.1.1 signs exact callback bytes; ipaddr.js 2.5.0 checks
destination address classes. No deployed SQL schema or migration is changed.

The bounded implementation adds one opt-in terminal event and optional exact
approved-step inputs. It reuses the existing state writer and Job admission
transaction. The [operating contract](../mcp-events.md) documents authentication,
lifetimes, retention, key recovery, stage receipts and the intermediate-question
limit. Default `live-card` and retained `direct-wait` policies are preserved.

## Evidence classes

| Evidence | Result and boundary |
| --- | --- |
| Official contract | Discovery, webhook subscription/verification, signatures, finite refresh and callback handling were checked against the official document. It describes a subscribed conversation; it does not establish this installation's host support or Pro mode. |
| Synthetic protocol tests | Real local HTTP MCP handler and SDK clients, temporary SQLite, fixture Codex upstream and injected callback sender. Security socket tests mock DNS/HTTPS to inspect connection pinning. These are not actual ChatGPT runs or public TLS endpoint trials. |
| Actual host acceptance | Pending behind a product connection gate: the default No Auth/Tunnel path has no verified subscriber principal. A supported authentication connection must be settled before an isolated trial. No real resumed-call metadata, GPT result review, card closure or background trial was observed. |
| Installation | Pending. This task did not replace the installed app, change its operational authentication/settings, inject faults into its database, or publish a release. |

The currently supported Events authorization is the existing HTTP installation
bearer credential, converted to a non-secret operator principal after validation.
It is not multi-user OAuth. Original scope, Job/Activity/Agent ownership and
project access are independently required. No Auth / Secure MCP Tunnel metadata
does not establish that principal, so Events fail closed there. A callback echo
or an `openai/subject` value cannot substitute for authentication. Codex execution
authentication remains independent.

## Synthetic findings

| Boundary | Observed result | Limit |
| --- | --- | --- |
| Pre-completion and late subscription | One retained exact result supplies the same stable terminal event, without another upstream execution. Discovery advertises the extension only when enabled. | Exact terminal snapshot with `cursor:null`, not arbitrary event replay. |
| Result/intent transaction | Injected metadata-write failure rolls back the terminal result and intent together. Repeating the same save produces an intent and retains one execution. | Same-process injected SQLite operation failure; no operating process was killed. |
| Verification, refresh and unsubscribe | Correct signed challenge activates a finite grant. Wrong echo, foreign scope and No Auth fail. Key rotation verifies both keys; unsubscribe racing first verification cannot reactivate it. | Fixture callback transport, no actual ChatGPT callback. |
| Delivery and access | Stable event IDs survive retry and server/store recreation. 410/413 stop retries; exhausted attempts stop; confirmed project withdrawal revokes. A transient authorization read failure preserves pending delivery and recovers after refresh. | Server and store recreation in one test process, not OS process recovery or Tunnel connectivity. |
| Callback security | Private/reserved addresses, mixed public/private DNS, rebinding and redirects are rejected; socket lookup is pinned while preserving TLS hostname checks. DNS timeout opens no socket. Exact-body signatures reject tampering. Encrypted destinations reject swapped records and token rotation. | DNS/HTTPS mocked. No public network or adversarial TLS server was used. |
| ACK and retention | Receipt is independent of exact-result offer/review and card delivery. Original result recovery protection survives ACK, failure and revoked access. Expiry does not cancel the Job. | Finite 24-hour recovery minimum, followed by normal retention. |
| Approved A → B | Different caller UUIDs, concurrent submissions, repeat calls and response loss followed by server/store recreation converge to one B. A and B produce two fixture upstream calls. Changed prompt, unapproved step and foreign conversation fail. | Explicit caller review assertion plus exact result offer; no private GPT reasoning or actual review was observed. |
| Stage receipt conflict/expiry | An unrelated Job occupying the canonical ID cannot masquerade as B. Unused grants expire; admitted receipts remain tombstones and cannot authorize another Job. | Ordinary intentional reruns remain distinct. No exactly-once claim about Codex external effects. |

## EVT disposition

No actual-host checkbox is marked complete solely from synthetic evidence.

| Requirement | Status |
| --- | --- |
| EVT-1 / EVT-1A | Protocol path implemented and tested. Actual ChatGPT/Tunnel discovery, verified subscriber identity and resumed original-scope equality remain pending. |
| EVT-2 | Atomic intent, fast completion and late subscription covered synthetically. Actual host result retrieval remains pending. |
| EVT-3 / EVT-3A | Durable scoped step identity and duplicate admission covered with separate clients/requests and restart. Actual A review → B, two GPT runs, and unapproved-B host control remain pending. |
| EVT-4 | Synthetic restart and scope rejection covered. Card closure, conversation switching, backgrounding, connectivity loss and installed-bridge restart each remain pending. |
| EVT-5 | Duplicate admission/retry, expiry, unsubscribe, access withdrawal and bad callback covered synthetically. Actual host out-of-order/burst/batched-event processing remains pending. |
| EVT-6 / EVT-6A | Separate journals and same-transaction intent implemented; ACK does not release the result or prove review. Actual host observations remain distinct. |
| EVT-7 | Existing Node/macOS regression validation is recorded below. Actual host delivery acceptance is separate. |
| EVT-8 / EVT-8A | Official, synthetic, actual and installation evidence are separated here. Upper Chat model, Pro mode and usage contract remain unconfirmed. |

The next host trial must use an isolated authenticated connection and a
preapproved read-only A/B pair, retaining the source/build, host and Tunnel
versions. Record callback receipt, exact result retrieval, actual GPT review,
B admission and Activity verification separately. Include an unapproved-B
control and deliver the same logical step to two distinct GPT runs. Compare
resumed `openai/session`/organization/subject scope with original admission;
never relax access checks to make the trial pass.

Terminal Events do not notify intermediate questions. The existing
`codex_status kind=input` and `codex_answer` paths remain necessary; question
Events follow minimal actual terminal acceptance. No unattended-flow, card
retirement, default-policy switch or Pro preservation is claimed.

## Local validation

The final feature tests passed: 44 tests in `test/mcpEvents.test.ts` and
`test/mcpWebhook.test.ts`. `npm run validate:affected` passed on the final changed
worktree: release/localization checks, the exact App Server schema lock
(416 JSON and 827 TypeScript files), Node build and 1,130 tests in 113 files,
and macOS localization/build plus 216 Swift tests (2 intentionally skipped,
0 failures). TypeScript checking and `git diff --check` also passed.

Environment: Darwin arm64, Node 24.11.1, npm 11.6.2, Swift 6.3.3. The reproducible
App Server baseline is Codex CLI 0.153.3, placed first on the validation-only
`PATH`; the installed CLI was not replaced. Initial attempts correctly refused
the installed CLI 0.159.0 baseline, then found README length and a globally
exported CLI override interfering with four dotenv fixtures. The compact README
and PATH-only validation invocation resolve those setup failures.
