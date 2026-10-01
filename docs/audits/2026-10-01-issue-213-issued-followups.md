# Issue 213: system-issued followup references

## Basis and disposition

This refinement starts from `dev` at
`8b8d40a55a16f9d60ee0fb0397ac16a4e31ea239` on 2026-10-01 KST and the user's
code review of [issue #213](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/213).
It supplements the [original implementation record](2026-10-01-issue-213-mcp-events.md).
Durable workflow identity belongs to the bridge. GPT supplies the approved
instruction and later references the issued identity; it does not name or
recreate a stage.

Issue #213 remains open. The default Secure MCP Tunnel + No Auth connection
has no server-verified subscriber principal, so it cannot use Events today.
This is a product connection design gate before host acceptance. Establish
an officially supported authenticated ChatGPT/Tunnel path first; then verify
actual conversation resume and A result review followed by one B admission.
Conversation metadata and callback verification cannot replace authentication.
The refinement does not implement a new authentication adapter or assert that
the existing bearer endpoint is supported by the actual ChatGPT host.

## Contract and persistence

`approvedFollowups` accepts at most eight exact prompts, without `stepId` or
caller-issued `followupId`. The original Job's atomic admission issues opaque
`followupId` and canonical request UUID values in declaration order. Admission
replay and exact retained Job/request reads recover those same references after
response loss and restart. Completed events carry only available followup IDs
as snapshot hints; GPT must retrieve the exact result and current references.

The issued reference combines the system-created predecessor Job with an
internal declaration slot. Lookup uses the existing exact metadata key, without
a global scan, a new index journal or a SQL schema change. Identical prompts
declared as separate steps have separate references. Referring to the same step
with different submission UUIDs always converges to its one canonical receipt.
IDs provide no authority by themselves.

Followup admission still requires the exact approved prompt, original principal,
scope, Activity/Agent, completed and offered predecessor result, reviewed
version, thread, sandbox and model/reasoning/service tier. Receipt consumption
and B admission remain atomic. Only prompt hashes are retained; GPT must
resubmit the original approved text. Code enforces result offer plus an explicit
version claim, not proof of private GPT understanding or review. No review
engine is added. Ordinary new-task caller/host request UUIDs are unchanged.

Retained v1 Job metadata and receipts receive current references internally.
Their original canonical UUIDs, request hashes and admitted Jobs are preserved.
The legacy hash identity comes only from stored receipts, never public input.
Refresh tool discovery; old caller `stepId` inputs are rejected. Existing queued
webhook bodies remain intact and their exact query recovers current references.

Task output includes a required nullable approval-reference field, preserving
its all-required envelope. Sharing the existing closed recovery-action union
through JSON Schema `$defs` keeps the descriptor within unchanged limits:
47,340 bytes overall and 12,420 bytes for status, against 64,000 and 18,000-byte
budgets. Wire action objects and runtime validation are unchanged.

## Verification and limits

The feature suite uses the actual HTTP MCP handler/SDK client, temporary SQLite,
fixture Codex execution and injected callbacks. Added cases cover lost A
admission responses, exact query/event/restart reference recovery, rejected
caller identifiers, atomic receipt-write rollback, separately approved identical
prompts, and retained v1 pending approvals. Existing duplicate B, response loss,
scope, prompt, model/context, expiry, retention and callback tests remain.

An additional isolated cross-version trial loaded the actual `8b8d40a` source,
admitted and completed A and B with its old public `stepId` contract, stopped its
server/store, and reopened the same temporary database using the refined code.
Two current callers recovered the original B with its canonical UUID and request
hash unchanged, zero new upstream executions, and an altered prompt rejected.
This is synthetic bridge acceptance with a fixture upstream, not actual
ChatGPT/Tunnel acceptance or an installed-app test.

`npm run validate:affected` passed: release/localization and exact App Server
schema checks (416 JSON and 827 TypeScript files), Node build and 1,134 tests in
113 files, and full macOS build/localization plus 216 Swift tests (2 intentionally
skipped, 0 failures). The 48 Events/webhook tests and output-contract checks are
included. `git diff --check` also passed. Environment: Darwin arm64, Node
24.11.1, npm 11.6.2 and Swift 6.3.3, with Codex CLI 0.153.3 first on the
validation-only PATH and the global CLI override unset.

The repository's release workflow does not run on `dev` pushes; local results must not be labeled
independent GitHub CI results. The installed app, operational authentication,
settings and database were not changed. Actual host support, GPT review, upper
Chat model/Pro mode and usage remain unverified.
