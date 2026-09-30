# Nonforcing shutdown adaptation

Status: lower-level primitives only. No operator, environment option, production
cutover or complete SDK2 runtime shutdown path is enabled by this change.

An explicit `JsonRpcProcess.close({allowSigkillEscalation:false,graceMs})` pins
the decision on that retained transport before yielding. It rejects pending and
new requests, closes owned stdin, waits for real child exit and original process
group absence, and may send SIGTERM to the trusted child handle. It never sends
SIGKILL. Each wait uses a monotonic, bounded deadline. Permission errors, false
absence probes, changed handles/PIDs and signal failures remain uncertain;
parent exit with a live original group is a timeout. Grace is bounded to 60 s
per phase. Numeric/default close retains ordinary force recovery.

The sealed close receipt remains immutable even after a timeout. A separate
read-only `observeNonforcingExit()` may later prove absence from the retained
handle and group; it does not rewrite the old result or send a signal. Existing
default/wire-error cleanup continuations recheck the pinned decision before
escalation. A nonforcing request that arrives after ordinary cleanup already
began returns uncertain and cannot certify a wholly nonforcing history.

These observations cover the retained direct child and original group only.
Descendants that establish another group still require the current execution
service's birth-bound process-tree ledger. Lower-level success is not a complete
runtime, worker, state-service or telemetry shutdown receipt.

`terminateManagedChildren()` accepts the same explicit escalation prohibition
and retains actual survivor handles. It pins the prohibition in a WeakSet so a
concurrent/default cleanup cannot later SIGKILL those handles. It observes
SIGINT/SIGTERM exit, with integer timeouts bounded to 60 s per phase. Its result
covers direct owned handles only, not descendant trees or subordinate service
receipts. Ordinary cleanup on unpinned handles retains SIGKILL escalation.

`boundedShutdown()` and `observeShutdown()` copy validated exact-field data
receipts into immutable snapshots. Missing, void, accessor-based, inconsistent,
rejected or late evidence is uncertain. `combineShutdown()` rejects missing
members and count overflow; a fulfilled promise is not exit proof. Collections
must contain 1 to 4096 own data slots, with no holes, inherited/accessor slots or
extra keys. Exact receipt fields reject symbol extras. The policy is read into
an immutable data-only snapshot once before state changes; policy accessors are
rejected without invocation. Fresh observation includes property access inside
its bounded rejection boundary and cannot wait forever on an unresolved Promise.

Remaining work: propagate the explicit policy and bounded generation-bound
receipts through the new App Server pool, execution/state/read/telemetry
services, runtime/frontend and launcher. Preserve supervised tree evidence and
real survivors; prevent every subordinate recovery timer from independently
escalating. The complete path must receive new exact-head independent review,
full validation and operator integration before production use.

The supervised process registry additionally has a synchronous, sticky
`pinNonforcingShutdown()` fence. Queued ordinary release/cleanup becomes
observation only; an already running cleanup rechecks the fence before every
SIGKILL. It retains an append-only copy of observed birth/group identities,
including descendants observed after pinning. Release, cleanup and forget cannot
erase that ledger while pinned. Ordinary unpinned cleanup retains escalation.

`observeNonforcingExit()` performs a bounded, serialized fresh process-table
observation without worker signals. A retained escaped child prevents success
after parent exit; missing birth information, reused identities, populated old
groups, changed tree membership, probe faults and unsupported platforms remain
uncertain. A timeout receipt stays immutable when a later separate observation
proves absence. Pinning after ordinary cleanup already began cannot certify a
nonforcing history and keeps uncertainty. This registry proof is not a
generation-bound worker/owner receipt and still cannot account for a detached
descendant never observed before reparenting. The bounded /bin/ps probe retains
its own timeout cleanup; that auxiliary probe is not a supervised worker.

These registry primitives are not yet connected to App Server pool policy,
worker-exit callbacks, execution-service IPC or runtime/operator shutdown.
