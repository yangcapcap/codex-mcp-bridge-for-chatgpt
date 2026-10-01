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

An observation or supplied merge that exceeds the bounded retained ledger sets
a sticky `incomplete: true` flag. Partial observed identities are retained even
when traversal throws. Fresh empty process tables cannot certify absence of
unrecorded escaped descendants. The flag survives snapshot serialization and
merge into a new registry; normal release/cleanup and forget cannot erase this
UNKNOWN. Pinned historical entries are bounded as well as current live entries.
Other trees in a complete snapshot are still inspected when one tree overflows.
The execution-service snapshot parser accepts only an absent or literal true
incomplete flag. This field carries uncertainty, never shutdown authority.

An ordinary cleanup already in progress invokes retention after every complete
or partial tree observation, including its polling and escalation continuations.
Final retention also runs when a later probe throws. A birth-bound descendant
observed after pinning therefore survives snapshot serialization and recovery
even if the cleanup never returns successfully. Failed overflow still retains
the incomplete flag; known identities are kept alongside that UNKNOWN.

The upstream router has an explicit optional-backend capability boundary.
`closeNonforcing()` snapshots the false policy, seals its own sticky close state
before synchronously invoking each backend capability, rejects subsequent new
requests and retains thread/worker bindings. An absent, invalid, rejected or
unresolved receipt is uncertain; it never calls ordinary backend close as a
fallback. Ordinary close after pinning cannot independently force recovery.
Fresh observation requires a separately supplied observation capability and
does not rewrite the old receipt. Prior ordinary shutdown history stays unknown.

The router aggregates backend evidence and does not itself implement worker or
execution-service shutdown. The local App Server pool capability below requires
its own tree supervisor; the actual execution-service backend still lacks the
complete path. No operator or runtime option invokes this path. Router receipts
are transport aggregation, not external authority or generation/owner-bound
worker proof.

Execution shutdown frames have a separate strict local correlation parser. A
close frame binds the current executor generation/PID, authenticated controller
ID and a fresh request ID. A later observation has its own request ID and retains
the original close ID. Receipts match every field and the operation, reject
accessor/inherited/missing/extra fields and inconsistent results, and copy an
immutable result. Parsing alone performs no action or source authentication;
the owner/controller IPC and real lifetime proof are still to be wired.

The App Server pool now supplies the optional router capability. It closes new
worker admission and synchronously pins every retained/starting connection before
yielding. Each connection pins its owned JSON-RPC transport and an optional local
tree supervisor, suppresses new ordinary exit-cleanup callbacks, retains worker
and thread bindings, and bounds tree receipts. Already-running ordinary cleanup
keeps history uncertain. A separate signal-free lifetime callback can mark the
owned root exited without releasing its tree. Default shutdown stays unchanged.

A local tree receipt must match a fresh pool UUID, worker ID, generation, PID and
original group, using exact data-only fields and a valid immutable result. A
missing supervisor, failed synchronous fence, void result, other generation,
malformed envelope or late/rejected response cannot approve exit. Transport exit
and matching tree absence are both required. Fresh observation does not rewrite
a retained timeout. These local bindings are correlation evidence, not external
approval, authenticated IPC, or a replacement for the tree's birth observations.

The execution owner now supplies a local registry supervisor from trusted worker
spawn and actual-exit callbacks, using an immutable pool/worker/generation/PID/group
binding in both callbacks. Registration records the root synchronously; a failed
birth probe does not block ordinary admission but keeps nonforcing proof unknown.
Controller/owner policy IPC, draining and recovery timers still need adaptation;
the execution service's unsupported router path returns uncertain.
No operator/runtime option enables nonforcing shutdown through the full system.
A caller-supplied supervisor is trusted local code and must pin every associated
cleanup continuation; an acknowledgement alone is not an independently measured
process-tree proof. The isolated actual test wires the reviewed registry and
measures an escaped child remaining alive after its parent exits.

If shutdown pins a connection before its owned-worker registration callback has
completed, that connection retains sticky uncertainty in both close and later
observations. An empty supervisor ledger cannot certify the absence of a worker
whose registration is pending. Completing registration after parent exit cannot
reconstruct an escaped descendant that was never captured, so it does not clear
this UNKNOWN. Transport prohibition still pins immediately; no wait for the
registration callback can defer or reopen ordinary force recovery.

The retained execution peer has a synchronous local nonforcing fence. It freezes
an already authenticated owner generation/PID and controller ID, drops unsent
ordinary requests with explicit delivery errors, prevents new owner launches and
all signal controls, and refuses ordinary close/termination or execution frames
on the pinned link. Only strict matching close/observation frames may cross it;
the original close request and normalized grace remain sealed. Reconnect is
restricted to the captured owner; another generation/PID keeps uncertainty.

Peer observation proves only an actual exit of its exact retained owned child
handle. A reattached lease, unknown owner, changed handle/PID or prior ordinary
close/signal history cannot approve that proof. It does not certify descendants,
whole execution-service shutdown, authenticated receipt provenance or operator
activation. Owner-side IPC and controller close still need policy propagation,
real supervised-tree receipts and retention. This fence is not invoked by the
current runtime until that complete integration is implemented and reviewed.

The peer serializes each accepted outbound message once, classifies ordinary
close/termination history from those exact bytes, and retains private bytes in
the queue. Caller mutation, accessors and `toJSON` cannot change the transmitted
representation after acceptance. An ordinary serialization that reentrantly
installs the nonforcing fence is rejected before enqueueing. Prior serialized
ordinary shutdown history remains unknown even after actual owned-child exit.

Scoped tree observation copies an exact PID/original-group selector before any
queue yield and requires that tree to already exist in the pinned ledger. A
missing selector, later registration or malformed data cannot approve absence.
It reads that retained tree in the same serialized registry, preserving active
force-history uncertainty, partial ledgers and birth observations. The result
counts only that tree's observed survivors; it does not prove all other workers
exited or bind a worker generation. An execution supervisor still needs trusted
spawn-time association and a separate all-tree check before whole-owner exit.

The local worker supervisor never adopts a caller-supplied shutdown binding as
spawn evidence. It requires an exact previously registered binding with a
completed birth observation, shares the original registry fence, and returns
only that worker tree's correlated receipt. Pending/failed/late registrations,
owner/generation disagreement, reused numeric roots and callback association
faults retain uncertainty. At most 4096 historical associations are retained;
exceeding that bound keeps UNKNOWN while preserving the registry evidence.
These callbacks do not authenticate parent IPC or enable full nonforcing close.

The eligible pinned-tree map is captured before inspecting caller descriptors.
A Proxy trap that registers another tree or first installs the pin cannot make
that new evidence eligible for the observation already in progress. Original
retained tree objects still supply serialized lifetime/history observations.

### Authenticated execution-owner shutdown IPC

The execution protocol is now version 7. Explicit nonforcing shutdown pins the
controller's retained execution peer and worker ledger synchronously, then sends
an exact `close-nonforcing` request bound to the authenticated controller UUID,
execution generation, owner PID, original close nonce and bounded grace. An
owner receipt reports its pool and retained trees; it is never owner-exit proof.
A fresh `finalize-nonforcing` nonce permits cooperative listener closure only
following a fresh zero-worker observation and successful receipt write on the
same authenticated stream. The controller additionally requires actual exit of
its original owned child handle and fresh retained local tree absence. A
reattached owner, missing/mismatched/equivocating receipt, incomplete registration,
prior ordinary shutdown or unresolved observation remains UNKNOWN.

Nonforcing shutdown retains pending execution reservations, assignments, terminal
ACK and release evidence. Late ordinary responses/ACKs cannot release unknown
writers. It prevents default force timers, restart/replay, raw owner controls and
queued ordinary cleanup from regaining termination authority. Initial receipts
remain immutable; fresh read-only observation may resolve a previous timeout,
but `close()` still reports the original unconfirmed result. Overlapping remote
pool/tree and controller tree counts use their maximum, with the execution owner
as a separate root. These are measured overlapping snapshots, not an assertion
of globally simultaneous unique process counts; EXIT requires every view to be
zero and positively confirmed.

This component does not expose a production shutdown switch, authenticate state
activation or establish complete launcher/state/runtime shutdown. It requires a
new independent exact-head review before integration and final acceptance. The
local tests cover correlation, real owned exit, retained writer evidence, prior
force history, serialization reentrancy and an observed detached descendant.

The enclosing execution owner refreshes a pool TIMEOUT after the pool's concurrent
transport/tree close has settled. The lower pool receipt is retained unchanged;
the owner uses a fresh bounded read-only pool observation for its own receipt.
This avoids reporting an early live-worker snapshot after actual owned-worker
exit. It preserves initial UNKNOWN and still reports a surviving detached child.
Finalization and controller actual owned-exit checks remain mandatory.

### Pending private Node IPC child controller

`OwnedProcessShutdown` is a reusable controller for a directly spawned, retained
Node IPC child handle. It seals an exact child/generation/controller/close nonce,
requires a positive synchronous admission fence, preserves prior ordinary-stop
history and rejects missing or contradictory resource receipts. IPC backpressure
is queued delivery, not rejection; only the send callback, exact receipt and
bounded deadline settle delivery observation. A fresh finalize receipt plus
actual exit of the original owned handle are required. It does not authenticate
an external socket or prove process-tree absence; child-side resource/descendant
proof and each consuming actor's admission/force/restart guards are mandatory.

The draft controller is now used by the read-only state projection child, whose
private protocol is version 3. Its controller UUID is fixed in the owned spawn
arguments. The child stops admitting reads, awaits the retained serial queue,
checks resource closure and writes a bounded correlated receipt before final
disconnection. Parent timers and late replies retain unconfirmed request evidence
and cannot resume force recovery. It still needs actual-host validation and a
new independent review. State/telemetry and complete runtime/launcher adaptation
remain pending. It does not enable a production policy switch.

### Pending telemetry private IPC adaptation

The telemetry controller captures a private spawn UUID and the child generation
advertised at startup. Explicit nonforcing close pins the original owned child,
stops new telemetry admission, restart, drop retry and force continuations, and
retains queue, in-flight delivery IDs, drop counters and byte accounting. Late
ordinary ACK and send-error callbacks cannot erase this unconfirmed evidence.
The owner closes its own SQLite connection before a strict resource receipt;
fresh observation checks retained closure state without retrying resource close.
A closure error remains UNKNOWN. Receipt write/finalization and actual original
owned-child exit are required before EXIT. Unsent diagnostics stay unconfirmed;
EXIT describes resource/process closure and does not certify their persistence.
Existing ordinary diagnostic flush/recovery remains the default. This draft still
requires actual-host verification and a new independent exact-head review and
does not expose a production shutdown policy switch.

### Pending lazy execution construction fence

The lazy execution adapter seals startup before invoking its factory. A
nonforcing close immediately stops new admission, including a method captured
before an asynchronous admission guard returns. Existing instances receive their
explicit capability synchronously. A late factory result is pinned before any
resume protection or request continues; an unfinished factory remains sticky
UNKNOWN because late registration cannot reconstruct earlier resources. Missing
capabilities, prior ordinary close and unqualified disposal also remain UNKNOWN;
ordinary close/disposal never resumes after pin. Execution factory construction
checks its pin after CLI selection, and an unconfirmed router close retains the
CLI context rather than releasing it. These are local source/pure checks pending
fresh independent review and runtime/launcher integration.
The private owned-child controller retains any observed PID identity mismatch
as sticky UNKNOWN, including after the numeric PID field is restored. This
invalidates cached final receipts for current observations and ordinary close
reporting while preserving the immutable original result. No fresh finalization
or receipt request is sent once such uncertainty has been recorded. The new
repair requires its own independent exact-head review.

### Pending state progress queue retention

The internal fair progress queue can pin without discarding pending snapshots
or charging them as dropped. Once pinned, ordinary close and remove callbacks
cannot erase retained work, including a remove predicate that reentrantly pins.
An already delivered scheduler callback or run-method lookup also checks the
fence before consuming work. A prior ordinary discard remains explicitly
uncertain. This primitive still needs state-owner application wiring and an
independent review; it does not prove whole-runtime quiescence.

## Pending state background writer fences

The state-owned progress queue now has a synchronous nonforcing pin that cancels
scheduling while retaining unconfirmed snapshots and counters. The connection,
automatic recovery and maintenance controllers similarly stop dispatch before
awaiting outstanding work. Each controller reports its own remaining async work;
these resource observations never prove that a durable writer was released.
Late connection and recovery responses leave their exact original journal rows
unconfirmed. Maintenance retains the original dispatched command ID and suppresses
late registry mutation callbacks. Ordinary-close history and uncertain maintenance
commands stay UNKNOWN. The resource APIs are internal and are not native/MCP
methods. Production state/runtime composition and policy propagation are still
pending; this component alone does not authorize a shutdown or database close.
Lazy direct delegation captures each actionable backend method before a final
admission check. A getter that reentrantly installs the nonforcing fence cannot
invoke its returned method or clear retained resume protections afterward. This
also covers direct tool/catalog/detach delegation and factory-time protection
lookups. The new repair retains the rejected predecessor and requires fresh
independent review.

Each retained-protection flush also checks admission before lookup and after the
callback, including the final item. A callback that installs the fence cannot
start a later callback or clear the retained IDs, even in a single-item flush.

Lazy continuations check admission immediately after awaiting an instance, before
starting an admission guard, after awaiting that guard, and after method lookup.
An ordinary close also rechecks its captured close method before invocation, so
lookup-time pinning cannot resume force recovery. These checks preserve prior
rejected evidence and require a fresh independent review.

Connection and recovery sweep handles are registered before any configurable
callback or method lookup can reenter shutdown. A callback cannot observe EXIT
while its original work is still running; later quiet observations do not alter
that initial observation. The final candidate includes independent regressions
for this synchronous registration race.

## Pending state background reentry repair

The rejected `abb21de` component is retained as evidence. Its successor snapshots
recovery and connection result fields as validated own data properties before a
journal write. Accessor or malformed receipts retain the original unconfirmed
row and sticky uncertainty, rather than execute code inside a transaction or
publish release evidence. Clock callbacks are checked before each write. Timer
intervals and queue limits are read before admission, with a final fence check
before installing a timer or changing retained queues. The retained independent
regressions are copied implementation baselines; a new exact-head review remains
required, and complete state/runtime propagation is still pending.

The rejected `b3fc3fd` successor is also retained. Thread request/cancel commands
now check the fence after their clock callback and before changing a handoff.
Recovery captures page/job resolver methods once and checks before delegation
and after callbacks. A captured page avoids a second method getter altogether;
an initial getter or the callback itself can still pin and suppress further work.
Discovery arrays (at most 4096 entries) and required candidate fields are copied
from own data descriptors, with checks around each descriptor lookup. Accessors,
sparse/malformed arrays, invalid identities and excessive discovery leave the
journal untouched and retain uncertainty. These checks also cover page slots and
release eligibility clocks. Only validated primitive snapshots reach journal
writes. Root regression results are component evidence; fresh independent review
and full state/runtime composition remain required.

The rejected `6a5c3a6` admission candidate remains immutable. Its successor uses
`Reflect.apply` for every captured connection, recovery and maintenance callback;
it does not look up a callable's configurable `call` property after checking the
fence. This retains the receiver and arguments while eliminating that second
executable lookup. Five independent reproductions are copied root regression
baselines. A revoked discovery Proxy rejected during Promise assimilation is a
completed discovery failure, not proof of an admitted journal write or a pin.
This repair still requires a new exact-head independent disposition.

The rejected `aff9ef7` candidate is retained. Queue error handling now checks
before looking up an error hook and after lookup, and invokes it intrinsically.
Pinning during a running projection preserves its exact scope/value and counters
and latches uncertainty; it cannot produce a quiet resource claim while the
original callback is still executing. Non-void callback returns are unsupported
ownership evidence and retain bounded (128) original values plus sticky UNKNOWN.
Queue status reads the last validated primitive limits without executing option
getters after pin. Nine root suites (116 cases) are regression evidence only;
fresh exact-head independent review and complete runtime wiring remain pending.


## Pending state registry integration

The registry has an internal synchronous `pinNonforcingShutdown()` fence with a
positive acknowledgement only after every existing owned background component
has been pinned. Admission, recovery, deferred launch/discard, cancellation,
steering, interaction responses and registry mutation endpoints cannot resume
once pinned. Application service drain cancellation cannot reopen this fence.
The internal fence is not an MCP tool or a public runtime RPC method.

Registry callback inputs are captured as bounded own-data snapshots before
mutation. Accessors, cycles, unsupported values and descriptor inspection failures
are retained as uncertainty. Late progress, assignment and original settlements
cannot update the durable Job or acknowledge an execution owner after the fence.
The original outcome stays reserved; terminal rollback callbacks are retained
rather than executed after the fence. Completion callbacks accept only `undefined`
or a synchronous undo function; unsupported returns retain the original resolved
settlement without a terminal commit or execution ACK. Ordinary admitted-thread
callbacks update the registry's captured `sessionDecision` object.

Observation is resource-only. A known active Job, construction or bounded observer
wait gives `TIMEOUT`; retained outcomes, unfinished admissions or control maps,
unsupported callback returns, prior ordinary-close history and a fence inside an
activity transaction give sticky `UNKNOWN`. Activity transactions reject their
commit after a reentrant fence. Notification dispatch stops before later listeners
when one listener pins. Retained observation samples are bounded at 128 and
sample overflow remains `UNKNOWN`.

Execution acknowledgements register their owner before reading or invoking the
upstream callback. Synchronous failures and unsupported results remain `UNKNOWN`;
a native Promise stays registered until it resolves before pinning. Pinning while
an acknowledgement is pending permanently retains uncertainty and its original
identity, even if it later resolves. Throwing change listeners are retained with
their original error. Invalid progress or worker identity inputs preserve the
last valid Job and original producer outcome without terminal commit or ACK.
Interaction input checks admission before lookup, before delegation and before
returning captured data. Cancellation, steering and persistence errors inspect
own message data without invoking accessor messages or writing after pinning.
Explicit retained-Job maintenance also rejects after the permanent pin.

Native Promise ACK observation accepts only the unchanged intrinsic Promise
prototype, constructor and species descriptors, with no own constructor field.
Other objects remain unconfirmed without invoking a constructor/species getter.
Worker assignment persistence/runtime fields must satisfy their semantic types.
Completion callback exceptions and rollback undo exceptions or non-void returns
retain the original successful producer outcome and callback uncertainty; they
cannot fabricate a failed terminal Job or authorize an execution ACK.

This registry component does not close the state database, retire a durable writer
or approve the complete runtime. The full runtime owner must additionally fence
in-flight application RPCs and frontends before closing resources and authenticating
its generation-bound shutdown receipts. Production policy remains unchanged.


## Pending registry callback and result repair

The initial registry candidate `3220b2a` remains unapproved. Its independent
review found ignored assignment callback returns, deferred identity deletion
following an authentication callback pin, retained-ownership getter delegation
after pin, and malformed data interpreted as a successful terminal result.
The successor captures both ownership capabilities before delegation, checks
admission again after authentication, and fences the deferred finish closure.
Unsupported assignment returns and exceptions retain their original callback
observation and resolved owner outcome without a terminal commit or ACK.

Data snapshots alone are not terminal-result authority. The successor validates
the captured value against the installed SDK v2 `CallToolResultSchema`, preserving
additional captured fields and the SDK's empty-content default for structured-only
results. Invalid results remain reserved at their original owner. The already
locked SDK core package is now an explicit runtime dependency; package versions
and installed dependency bytes are unchanged. These repairs require a new exact
head review; the database and complete runtime have separate pending reviews.
