# CoGate generation-aware scope inspection

`inspectCoGateScopeRouting` is a state-owned, read-only model for the upcoming
unified Workspace adapter. It operates on an idle read-only SQLite connection
(or an in-memory test fixture), owns its query-only snapshot, and accepts only
the exact retained legacy schema21 or unified storage schema31. It rejects TEMP
objects, incomplete paired keyrings, required/pending rotation, and ambiguous
canonical routes. Snapshot failure returns no evidence.

The original HMAC tuple, v1 domain and UUIDv8 derivation remain unchanged.
The active generation can locate a current scope or an existing generation-bound
alias. A retired scope key can locate only immutable lookup evidence captured by
its completed rotation; a matching UUID created after retirement is ignored.
Retired execution-policy keys remain rejected by the paired keyring validator.
The result returns neither secrets nor raw host identifiers, creates no scope,
and writes no alias, conversation link, rotation or writer evidence.

Every result has `authority: "none"`. Metadata is a routing input, not an
authenticated MCP principal. This inspector does not validate conversion
approval or source-owner control, grant runtime activation, reserve a Workspace,
or authorize execution. There is deliberately no runtime import or startup
bypass: converted and active CoGate state remain rejected until authenticated
conversion and state/execution actors are implemented and reviewed. A future
adapter must repeat this read inside its state-owned admission transaction and
bind it to the current authenticated principal, Job envelope, revision and worker
generation; a previously returned route is not a command capability.
