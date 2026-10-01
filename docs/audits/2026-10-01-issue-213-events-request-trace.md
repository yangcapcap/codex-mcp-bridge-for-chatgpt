# Issue #213 — actual Events request boundary

Date: 2026-10-01 KST. Integration target: `dev`. Baseline: `d5190c0`.

## Result

**An actual native `events/subscribe` request reached the Bridge. OAuth passed,
but the request did not carry the original conversation metadata that the
Bridge requires. Callback verification never started.** The earlier
conversation's “no subscription tool” answer was not a transport diagnosis.
The native event-based automation route was subsequently found and invoked.

This is an observed incompatibility between this host route and the Bridge's
conversation-bound authorization contract. It is not proof of an OpenAI bug,
universal Events unavailability, callback failure or missing OAuth support.
The current [official Events documentation](https://developers.openai.com/plugins/build/mcp-events)
does not promise `openai/session` on these protocol methods. An officially
supported way to bind a native subscription to its originating conversation
must be established before changing the authorization design.

## Controlled observation

The existing A, original ChatGPT conversation, exact test app, OAuth issuer,
private Tunnel, installation sealing key and isolated SQLite were retained.
Only the task-owned product process was restarted to attach observation and
then deploy the compiled correction; the live authorization process/grant was
preserved. No additional Codex turn, B, fabricated callback, fabricated secret,
synthetic live subscription, time schedule or polling automation was created.

A private task-only observer wrapped the existing public HTTP ingress and
state-owner handlers. It delegated to the original handlers, authorization,
scope resolver and webhook sender. It observed existing emitted body chunks
without adding a consuming data listener or changing flow/backpressure. It
recorded only time, method, stage, authentication/comparison booleans, presence
of the known metadata key, HTTP status and JSON-RPC error code. It did not
record bodies, tokens, cookies, callback URLs, signing secrets, actual scope or
principal values. The observer created no requests, subscriptions, new writer
or database, and is not enabled in the product or operational installation.

Actual requests through the original ChatGPT conversation provide positive
controls for the observer. Selected sanitized observations are retained in
[the evidence summary](2026-10-01-issue-213-events-request-trace.json).

| UTC time | Observed operation | Result |
| --- | --- | --- |
| 12:07:45 | Original A `codex_status` | HTTP 200; verified principal and resolved scope matched A. |
| 12:10:42–12:10:46 | UI **Refresh tools** | Authenticated `server/discover`, `tools/list`, `events/list`, resource reads returned HTTP 200; Events authorization passed. |
| 12:14:55 | First native `events/subscribe` | Reached both ingress and handler; authenticated principal matched A; no scope resolved; HTTP 200 / JSON-RPC **-32603**; no callback started. |
| 12:14:56 | Host cleanup `events/unsubscribe` | Same authentication/scope boundary; no subscription removed or created. |
| 12:35:14 | Original A `codex_status` after correction | Wire `params._meta` contained `openai/session`; scope and principal matched A; HTTP 200. |
| 12:35:31 | Second native `events/subscribe` | Wire `params._meta` **did not contain `openai/session`**; same verified principal; handler also had no session; HTTP 200 / JSON-RPC **-32001**; no callback started. |
| 12:35:31 | Host cleanup `events/unsubscribe` | Also omitted the session; HTTP 200 / JSON-RPC **-32001**. |

The SDK forwards non-reserved request metadata into `context.mcpReq._meta`;
the second observation distinguishes an absent wire field from loss inside
Bridge handling. The native host reported `status=ERROR` and “The task service
returned an unexpected error” on both attempts. It did not surface the
Bridge's structured authorization reason. DB subscription count remained zero,
now explained by the request trace rather than inferred from that count alone.

The browser was **Codex In-app Browser**, on the **ChatGPT Work conversation
screen**. Its model picker displayed **Light, 2 of 6 power levels**, with fast
mode off; it did not expose a precise model identifier. No inference about Pro
or generic Scheduled Tasks support is made. The fresh capability-only chat
from the preceding audit was not used to subscribe the original A.

## Narrow product corrections

Missing/invalid conversation metadata on `events/subscribe` and
`events/unsubscribe` now returns a bounded authorization error **-32001** with
`missing_conversation_scope` or `invalid_conversation_scope`. It no longer
appears as an internal server error. This improves diagnosis; it does not make
the missing metadata acceptable. Principal, scope, exact Job/Activity/Agent,
project, callback and followup checks remain enforced. Job ID, OAuth principal,
caller-provided scope and callback challenge are not substituted for the
original conversation boundary.

The live-card message no longer instructs GPT to choose a hardcoded app name.
The originating component uses its standard, connection-bound `tools/call` to
read `codex_status` with the claimed completion receipt. It verifies the exact
terminal Job and hands only the public structured result/text into `ui/message`;
private `_meta`, content-block metadata and the receipt are not forwarded.
If further retrieval needs a connection that cannot be addressed exactly, the
message requires explicit user selection instead of guessing another app.
The [official UI reference](https://developers.openai.com/plugins/reference)
documents standard tool calls and defaults visibility to model and app; an
undocumented `ui/message` connection-selector field was not invented.

A failed result lookup occurs before any message is sent and can use the
existing bounded rejection/retry path. Teardown after lookup releases the
lease. Explicit message rejection remains retryable; an uncertain message
outcome stops automatic retransmission. Reading the receipt records only
result-offer evidence and does not claim GPT review or settle delivery itself.
Dashboard generation is 37; its serialized byte budget increases by 1 KiB
to accommodate the result-handoff guard.

## A's independent execution failure

The retained A was completed at Job version 11 but returned a read failure,
not fixture JSON. Its exact Codex thread's existing local diagnostic log
recorded:

```text
failed to spawn code-mode host <pinned CLI>/bin/codex-code-mode-host:
No such file or directory (os error 2)
```

The selected CLI was **0.153.3**, backend App Server, caller selection
**gpt-5.6-luna / low**, ephemeral thread, exact existing fixture directory and
**read-only** sandbox. The trial's manually staged CLI contained only `codex`,
omitting its required sibling helper. The complete official npm platform
package was restored in that same trial installation, including
`codex-code-mode-host`, bundled `rg` and bundled shell resources. The helper's
`--help` and CLI `--version` now exit successfully. A separate native read-only
sandbox probe read the fixture without a model turn or permission expansion.
That probe is **not** a successful replacement A, and helper startup is not a
complete code-mode execution acceptance test. Original A result and B=0 remain.

## Executed validation

- Focused dashboard state, UI and Events: **82 passed**.
- Browser QA through CUA: **9/9** existing completion scenarios passed, including
  exact connection-bound result handoff, rejection/retry, uncertain response,
  teardown, direct-result/direct-wait, identity mismatch and duplicate cards.
- Full local affected validation: **115 Node files, 1,212 passed**;
  **216 Swift executed, 2 skipped, 0 failures**. TypeScript, release/localization
  and pinned CLI **0.153.3** schema compatibility passed.
- The first full run found a source/built HTML difference caused by string
  constant folding. A single literal fixed it; the subsequent full run passed.
  An initial CLI version check also exceeded its bounded startup check;
  direct version and subsequent pinned schema checks succeeded.
- These are executed local checks, not independent GitHub CI or successful
  real ChatGPT event delivery/review/B execution.

## Remaining gate and unsent inquiry

**#213 remains OPEN.** The immediate gate is no longer whether a subscription
request exists or OAuth works. It is the supported authorization/correlation
contract for native Events requests that omit the original conversation field.
Callback verification/delivery and event-triggered conversation resumption are
not tested because this boundary rejects the request first. A successful new
A followed by reviewed B once also remains untested; neither was executed.

The next technical inquiry is ready, but **has not been submitted**:

> With OAuth over a private HTTP Tunnel, authenticated discovery and
> `events/list` succeed. A same-conversation `tools/call` includes
> `params._meta["openai/session"]` and can read the owned Job. The native
> event-based task creates `events/subscribe` and cleanup `events/unsubscribe`
> with the same authenticated user, but omits that field. Does the official
> native Events route support propagating the originating conversation
> metadata? If omission is intentional, what supported contract lets a server
> enforce the originating conversation's Job boundary and resume that same
> conversation without trusting caller-generated scope values or a callback
> challenge as authorization?

The active private trial services still use the task checkout. Git integration
is separate from service shutdown; task branch/worktree removal is deferred
until those processes can be safely stopped. No Codex conversations are
archived, renamed or removed for cleanup.
