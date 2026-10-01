# Exact-Job MCP Events

The opt-in `codex.job.terminal` event implements the webhook portion of
[OpenAI's MCP Events contract](https://developers.openai.com/plugins/build/mcp-events)
on the existing MCP `2026-07-28` endpoint. It signals a committed `completed`,
`failed`, `interrupted`, or `cancelled` Job and carries an exact
`codex_status` query. It does not include the prompt, answer, callback, signing
key, or instructions to execute work.

The default completion policy remains `live-card`; retained Jobs preserve
their existing `live-card` or `direct-wait` snapshot. Events are an additional
opt-in observation channel. No default switch, card retirement, new execution
engine, automatic approval, or unrestricted flow is introduced. Callback ACK,
result offer, caller's review assertion, followup admission and Activity
verification remain separate facts.

## Authentication and enablement

For the isolated static-bearer bridge tests, enable HTTP with
`CODEX_MCP_BRIDGE_EVENTS_ENABLED=1`, a configured
`CODEX_MCP_BRIDGE_TOKEN`, and `CODEX_MCP_BRIDGE_NO_AUTH=0`. The endpoint's
existing bearer check establishes one installation operator principal; it is
not multi-user OAuth. Only a new Job admitted through that authenticated
connection can be subscribed to by that same principal and original derived
conversation scope. The original Activity, Agent and active project must also
remain accessible. Scope IDs and `openai/session`, subject and organization
metadata are correlation values, not authentication credentials.

The current No Auth / Secure MCP Tunnel HTTP or stdio path supplies no independently
verified subscriber principal. Events requests on that path are denied. Setting
`openai/subject`, knowing a Job ID, or echoing a callback challenge cannot enable
it. The opt-in OAuth adapter preserves the existing scope checks.
Existing execution and status tools continue normally.

The selected [product connection design](mcp-events-authentication.md) is user
OAuth 2.1 over a private HTTP Tunnel, with a separately reachable public identity
provider. OpenAI does not support customer-defined API keys for this ChatGPT
connection. The access-JWT adapter and authenticated HTTP launcher are implemented
and synthetically tested. Provider configuration is pending; no existing login
provider is configured. This remains a product connection gate before actual
host acceptance. Conversation metadata and
callback verification cannot replace authentication. Enabling Events on the
default No Auth connection still does not make the feature usable. Issue #213
remains open.

Discovery advertises `events` when the opt-in configuration is enabled. Use
`events/list`, `events/subscribe` and `events/unsubscribe` on the same
authenticated endpoint as tools. Rescan the plugin after changing event support.
Read-only projection workers never activate delivery or become a second writer.

## Subscription and delivery

Subscribe using `name: "codex.job.terminal"`, `arguments: {"jobId":"..."}` and
`delivery: {"mode":"webhook","url":"https://...","secret":"whsec_..."}`.
The signing key must decode from base64 to 24–64 bytes. The service grants one
hour by default and at most 24 hours; a smaller positive `ttlMs` is honored.
In OAuth mode, the granted expiry is also capped at verified access-token expiry
and checked again after callback verification. Renewal uses the same stable
operator identity and subscription ID. Expiry stops delivery without cancelling
or repeating the Job.
`ttlMs: null` still receives a finite grant. `refreshBefore` is the granted
expiration. Refresh uses the same principal, scope, exact Job and callback
identity. Unsubscribe uses that event, arguments and callback URL, without a key.

Each new callback must echo a fresh signed challenge within ten seconds before
the subscription activates. Successful verification is cached for five minutes
for that identity and key. Replacement keys are verified, encrypted and used
together with the previous key during a five-minute rotation window. A late
verification cannot undo a concurrent unsubscribe.

The delivery list supplies subscription identities only. Each send re-reads the
exact current grant, checks its disabled/expiry/delivery state, and records the
attempt only if its revision still matches in the existing writer transaction.
The response is checked against the current grant again before saving. Renewal
merges the latest event, attempts, ACK, retry deadline and recovery protection
after callback verification. A webhook already in flight can finish after an
unsubscribe or renewal; its old response cannot overwrite the changed grant,
and an unsubscribed grant cannot authorize a later send.

All verification and delivery requests require HTTPS on the standard port,
public DNS answers, a connection pinned to a validated address, and normal TLS
hostname verification. Private, local, reserved, mapped and transition addresses
are blocked. Redirects are never followed. Each attempt resolves DNS again to
prevent rebinding. Standard Webhooks signs the exact serialized bytes with the
event ID and current signing timestamp. Application bodies remain below 256 KiB;
responses and connection lifetimes are bounded.

Callback URLs and signing keys are AES-GCM encrypted in the existing database
using a key derived from the stable installation `CODEX_MCP_BRIDGE_TOKEN`, which remains
outside SQLite. The subscription ID is authenticated encryption context.
Database-only dumps cannot disclose destinations or signing keys. Backups need
the separately secured original bearer credential to recover those encrypted
records. In static-bearer mode, rotating that credential changes the operator
principal and revokes old subscriptions. In OAuth mode it is only a local
sealing secret; rotating access tokens preserves the issuer/subject/resource
principal and does not change it. Keep the original sealing secret to recover
old encrypted destinations. Neither operation changes Codex authentication or
cancels Jobs.

The bounded subscription journal uses `bridge_meta` keys under
`mcp_events_v1/`, with at most 256 records and eight per Job. It has its own
delivery state and ACK meaning. It is separate from diagnostic `job_events`,
native `completion_outbox`, and `job_completion_deliveries`. The existing State
UoW writes its delivery intent inside the exact terminal Job transaction. Late
subscription uses the retained original terminal receipt to backfill the same
event. This closes the result/intent crash boundary without polling or rerunning
Codex. Cursors are `null`: this is an exact retained terminal snapshot, not a
general event-history replay API.

An event keeps its ID across callbacks, response loss and retries. Attempts are
persisted before sending and capped at eight. Network errors, 408, 425, 429 and
5xx use bounded exponential retry; 410, 413 and other permanent failures stop
retry. HTTP 2xx records receipt only. It does not mark a card accepted, claim that
GPT reviewed the answer, acknowledge run history, or release the original
result. A 24-hour result recovery window survives ACK, failure, unsubscribe and
revocation. Normal retention applies after that finite window. Expiration and
cleanup never cancel work or manufacture a new Job.

An unavailable authorization state read defers delivery with bounded backoff;
only a confirmed access failure revokes it. An expired subscription schedules
its finite recovery cleanup rather than continuing a retry timer.

## Pre-approved A → B

Before admitting A, include only exact prompts that the user has already
approved:

```json
{
  "approvedFollowups": [
    { "prompt": "The exact already-approved B instruction" }
  ]
}
```

This optional input is part of task contract 6. It grants at most eight steps,
scoped to A's original Activity and Agent. GPT supplies meaning, not stage IDs.
The bridge issues opaque `followupId` and canonical `requestId` values at A's
atomic admission and returns them in declaration order:

```json
{
  "approvedFollowups": [
    { "followupId": "<bridge-issued reference>", "requestId": "<bridge-issued UUID>", "status": "approved-pending" }
  ]
}
```

Admission retries and exact Job/request status reads recover those same values,
including after server/store recreation. A completed event carries only
`availableFollowups: [{"followupId":"<bridge-issued reference>"}]`; it is a
snapshot hint, so requery the exact result and current references before acting.
Never name, parse, regenerate or guess a reference. Separate declarations receive
separate IDs even if their exact prompts match; repeating one reference cannot
create another stage. The IDs are references, not authentication credentials.
Prompts remain stored as hashes, so B must resubmit the exact approved text.
The approval expires after seven days if unused; it cannot be added to A by
reading its output or replaying an event. This is the model's declaration of
existing user authorization, not proof of authorization independent of the
conversation. The host/model must stop when new user input or approval is needed.

After an event, the resumed GPT calls the supplied exact query:

```json
{ "query": { "kind": "job", "id": "A-job-id" } }
```

It reviews that answer before calling `codex_task` with the exact B prompt,
the current contract/envelope, the returned canonical requestId, and:

```json
{
  "followup": {
    "followupId": "<bridge-issued reference>",
    "reviewedVersion": 2
  }
}
```

Use the actual version from the exact Job read. Omit project and selection;
the original Activity/Agent context is used. The backend requires a completed
predecessor, an original exact result offer, an unexpired approval, the exact
prompt hash, and a caller assertion of the reviewed version. It rechecks the
retained result, thread, access mode and model in the atomic Job admission.
It cannot inspect private GPT reasoning and does not equate result offer with
actual human/model review.

`original scope + predecessor Job + system-issued followupId` resolves to a
durable canonical requestId. Admission binds that receipt and B's Job in the same existing
transaction. Different UUIDs, GPT runs, event batches, duplicate card delivery,
and response-loss retries converge to B. An expired B result still reserves
the stage and cannot admit a replacement. Distinct approved steps and explicitly
authorized ordinary reruns remain distinct; no exactly-once claim is made about
external side effects performed inside Codex. Consumed receipts remain durable
admission tombstones; the existing receipt maintenance slice removes unused
expired approvals in bounded pages.

The general new-task requestId contract remains caller/host-owned. Followup
callers may also use different submission UUIDs; the issued reference always
resolves to the stored canonical receipt. Old `stepId` caller inputs are rejected.
Refresh discovery and use returned references. Retained v1 Job metadata and
receipts are adapted internally without changing their canonical requestIds or
admitted Jobs; this is stored-data compatibility, not a public caller alias.
Pending older webhook bodies stay intact and their exact result query recovers
the references. No SQL schema migration or new workflow engine is introduced.

Without a declared approved step, the backend rejects followup admission. The
GPT may report the result and ask for a new instruction. Event text can never
create a grant. Do not call an ordinary new task to evade a stage's receipt.

## Acceptance boundary

Protocol and synthetic regression tests cover the implementation. Actual
ChatGPT / Tunnel must first have an officially supported connection that supplies
a verified subscriber principal. Its discovery, callback support, resumed-call
metadata and original scope equality then need an isolated authenticated trial.
Record webhook receipt separately from exact result retrieval, actual review,
and B admission. The test must include a B-not-approved control and two distinct
GPT runs delivering the same logical step.

Card closure, conversation switching, backgrounding, connectivity loss and
bridge restart each require actual host evidence. The upper Chat model, Pro
mode and usage contract are unconfirmed until publicly documented or observed;
webhook success cannot establish their preservation. No automatic host-resume
claim or default delivery switch is made before those checks.

This first event only covers terminal results. A Job blocked on an intermediate
question has no terminal event. Continue to use `codex_status kind=input` and
`codex_answer`; response-required events are a subsequent scope after actual
terminal-event acceptance. No new question engine or automatic approval is added.
