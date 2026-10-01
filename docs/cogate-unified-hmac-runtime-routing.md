# Unified runtime HMAC routing integration

`BridgeStateStore` now owns the current HMAC read snapshot used by
`ScopeResolver` and `UserSettingsStore` in the existing HTTP/stdio composition.
This is a connection to the single runtime's existing state owner; it creates
no second connection, worker pool, server, operational-state command or RPC.

For ordinary upstream state, all reserved CoGate storage must retain the empty,
disabled baseline. Existing canonical generation-one meta secrets and policy
reference encodings are retained. Missing secrets can be initialized only by
an existing writable owner, at construction; subsequent reference generation
requires an existing key. Any CoGate marker or partial content prohibits
fallback or replacement with a fresh legacy secret.

For versioned state, the complete fixed schema31 and both keyrings, paired
rotation plans/events/receipts and original generation-one metadata must pass
the retained validator. Required/pending rotations, drift and provenance
conflicts fail closed. Each resolution/reference uses fresh owner state rather
than cached constructor keys. Scope routing preserves the original HMAC tuple
and UUID derivation, uses retired keys only with immutable pre-retirement lookup
evidence, and resolves existing canonical aliases. Raw host identifiers and
key material are absent from routing results. Host metadata remains correlation
input; it does not authenticate a principal, membership or Job.

Execution-policy and task-envelope references use only the current active
execution key. Generation-one upstream reference bytes remain unchanged;
rotated references additionally bind `keyGeneration` within their canonical
payload. The execution contract remains v6. No retired execution key is used
for signing or automatic backward acceptance. Key material stays in the
private runtime's composition; the state-service protocol exposes no key method.

This stage reads existing aliases and rotation evidence. It does not implement
rotation apply, alias binding, Workspace reservation, authenticated Job/worker
feedback, writer release, conversion apply or bootstrap. The pre-open and
read-projection activation guards still reject nonempty or converted CoGate
state. Memory-only fixtures seed arbitrary synthetic rotation records to test
this otherwise closed path; those records are not conversion or activation
approvals. Final whole-runtime acceptance and official dev integration remain
pending.
