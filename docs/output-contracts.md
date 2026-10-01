# Output schema contracts

Every current tool projects its runtime result through a validated JSON Schema
2020-12 output contract. The bridge keeps model-visible structured content,
human-readable text, and app-private metadata separate. A projection cannot
turn private state or an unvalidated runtime object into model-visible output.

The projection boundary accepts every JSON root permitted by MCP, including
`null`, booleans, numbers, strings, arrays, and objects. The current public
tool schemas deliberately use object roots, but the shared boundary does not
silently narrow the protocol. Values that JSON serialization would change or
drop, such as `NaN`, `Date`, functions, or undefined object members, are
rejected before they cross the wire.

## Task result

`codex_task` input contract version 6 returns task output contract version 4.
The different numbers are intentional: input and output evolve independently.

A successful new admission returns promptly with `state: "running"`, durable
Job/Activity/Agent identities, current versions, and status requery actions. It
never waits for the Codex result. A byte-for-byte logical retry can instead
return the current stored state—including a terminal state—because `replay`
identifies the same durable request receipt rather than a new execution.

Task output has a strict root with explicitly nullable fields where a state
does not have a value. Its meaningful states are:

| State | Terminal | Result delivery |
| --- | --- | --- |
| `setup-required` | yes | none; the result has a structured setup error |
| `running` | no | status only |
| `completed` | yes | primary content when the answer is available |
| `failed` | yes | none; the result has a structured error |
| `cancelled` | yes | none or an explicitly retained result |

The schema rejects impossible combinations such as a running task with a
model-authoritative answer or a completed delivery without its answer.
`replay` distinguishes a stored logical-request result from a new admission.
`resultAvailability` and `resultOmitted` state whether an exact result must be
read separately or was deliberately not included.
An available answer in a generated tool result is a server **offer**, not proof
that ChatGPT received or used it. Host acceptance/rejection/uncertainty and
Activity completion are separate [evidence stages](execution-authority-and-evidence.md).
An exact `codex_status` Job item includes `completionEvidence` for the last
committed Job record, owner observation, terminal origin, prior result offer,
host delivery record and Activity lifecycle. This evidence does not claim that
the current tool response reached GPT.
`ownerTerminalResult` alongside `jobRecord='active-last-known'` distinguishes
a result received from the original execution owner from its still-active
durable Job row. This transient observation is never an early
terminal commit, result offer, or owner ACK.

After result retention expires, an exact `codex_status` Job/request query can
return a scoped terminal admission receipt with `replay: true`, the original
Job ID, and an omitted or unavailable result. It confirms prior admission but
contains no recovered answer; missing and foreign handles use the same error.

An admission with preapproved steps returns `approvedFollowups` in declaration
order, including each bridge-issued `followupId`, canonical `requestId` and
approval status. An exact retained predecessor read recovers those same
references. Task output uses `null` when no steps were declared; status items
omit the field. See [MCP Events](mcp-events.md) for review and expiry semantics.

## Structured next actions

Model-visible `nextActions` is a closed union, never a free-form string list.
Each entry is one of:

- a safe, allow-listed tool call to `codex_models`, `codex_settings`,
  `codex_status`, or `codex_dashboard` with a validated
  argument object; or
- a `guidance` record with a short user-facing message.

An action is recovery information. It does not confer authority to start work,
alter settings, cancel a Job, or use an arbitrary tool. The receiver still
performs the normal input, scope, version, and authorization checks.
The descriptor shares this action union through a closed `$defs` definition
and local `$ref` references across result branches.

## Model catalog and status

`codex_models` always returns output contract version 2 with `selectionMode`,
source/freshness information, and allowed models/efforts from one snapshot.
There is no legacy catalog-only branch.

Status, mutation, question, and opener results also use closed result roots.
Their state-specific fields preserve ordinary error, delivery, idempotency, and
result-retention semantics without exposing private card proofs or bridge
configuration.

## Validation

`test/outputContracts.test.ts` supplies fixtures for setup, replay, running,
completed, failed, and cancelled task results; all twelve model-visible tools;
root expansion; state contradictions; and structured action validation. The
output-contract audit measures the current model-visible output schemas at
47,340 UTF-8 JSON bytes. The total descriptor budget is 64,000 bytes and no
single public output schema may exceed 18,000 bytes. These are descriptor
measurements, not model-token counts or result-payload limits.

See [Input contracts](input-contracts.md) for the corresponding request
boundary and [the migration guide](mcp-2026-07-28-migration.md) for the
breaking-change procedure.
