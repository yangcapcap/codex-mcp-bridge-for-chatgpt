# Workspace execution evidence component

`CoGateWorkspaceExecutionEvidence` ports protocol-managed execution accounting
from the retained CoGate implementation into a bounded, generation-correlated
component. It imports no old SDK, pool, CLI, native adapter or state database.
The original `ManagedExecution` regression assertions are retained, and its
mutable state/helpers use ECMAScript private fields.

The execution owner must establish a binding from the admitted Workspace, Job,
Activity, Agent, scope, current execution-envelope reference and actual worker
assignment. This component receives serialized, strictly parsed JSON events with
an exact binding and contiguous sequence. The future owner adapter must provide
the event-local thread/turn correlation, including terminal turn ID. Unknown
events, missing evidence, output-only tools, sequence gaps/replays, mismatched
generation and late events permanently retain uncertainty. Pending/approved
approval commands are not implemented; unsupported inputs retain uncertainty.
No command is dispatched by recording a declined approval.

Limits are 64 KiB per event, 8 MiB total input and 4096 events. Capacity failure
preserves existing evidence and invalidates protocol certainty. Command identity
and terminal outcomes are retained; output text is not durable process evidence.
The return value only reports whether the local ledger remains consistent.

All snapshots carry `authority: "none"`, `cleanupAuthorized: false` and
`workerClosureVerification: "not-performed"`. `protocol: "matched-ledger"`
checks correlated command completion; it cannot establish authenticated event
origin, runtime idle, background-process absence, process-group closure, writer
release, reuse or removal. A forged but well-formed stream is not authority.
No current runtime entrypoint imports this component. The next state/execution
adapter must authenticate the existing owner channel and commit this evidence
with its original Job/Workspace revision and binding, while keeping protocol
release separate from generation-bound closure and cleanup. Existing converted
state activation gates remain closed.
