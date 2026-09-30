# State data access and maintenance ownership

This document is the schema-30 operational ownership contract. Authoritative
state remains one durable `state.sqlite` database; best-effort diagnostics use
the separate `telemetry.sqlite` described by issue #142. A shared operational
file does not imply shared write authority.

The issue #142 successor architecture that preserves these owners while moving
execution behind a child-process boundary is documented in
[State execution isolation architecture](state-execution-isolation.md).

The production runtime has three state access classes inside separate process
boundaries:

- Commands and domain repositories own invariants and mutations.
- `DashboardReadModel` and `StatusReadModel` execute read-only projections.
- `StateMaintenanceScheduler` rotates bounded maintenance slices independently
  of thread connection release.

`BridgeStateStore` is the transaction coordinator and the only cross-domain
Unit of Work. A domain store may read another domain to decide eligibility, but
it must not mutate that domain's authoritative tables through its raw SQLite
handle. In particular, history expiry calls the central Unit of Work, and event
retention accesses `jobs.summary` through `EventRetentionJobRepository`.
Activity-event and result-hold cleanup is scheduled by the event-retention
slice but executed through `EventRetentionMaintenanceRepository` commands
implemented by the State Unit of Work.

## Schema 28 ownership matrix

“State UoW” below means `BridgeStateStore`. Read models never appear in the
writer column.

| Table | Authoritative owner | Allowed writers | Principal readers | Maintenance owner |
| --- | --- | --- | --- | --- |
| `bridge_meta` | State UoW / schema, operations and bounded protocol journals | State UoW | startup, migration, policy diagnostics, exact-Job Events and approved followups | owning command or maintenance slice |
| `scopes` | State UoW / scope repository | State UoW | status, Activity and Job repositories | none |
| `bridge_instances` | State UoW / runtime ownership | State UoW | startup and diagnostics | State UoW at clean start/stop |
| `project_registry` | State UoW / project repository | State UoW | settings, Session/Job project projections | none |
| `projects` | State UoW / project repository | State UoW | admission, Dashboard, shared helper inspection | explicit project commands only |
| `user_settings` | State UoW / settings repository | State UoW | settings and retention policy reads | none |
| `model_description_versions` | State UoW / settings history repository | State UoW in the same settings transaction | per-model paged Settings history | retained through general Settings reset |
| `sessions` | State UoW / Session repository | State UoW | Session registry, Dashboard | explicit Session capacity command |
| `activities` | State UoW / Activity repository | State UoW | Activity API, Dashboard, retention protection | State UoW reconciliation |
| `agents` | State UoW / Agent repository | State UoW | Agent API, Dashboard, recovery | State UoW reconciliation |
| `agent_threads` | State UoW / Agent repository | State UoW | admission, Dashboard, recovery | explicit Agent commands |
| `activity_agents` | State UoW / Activity repository | State UoW | assignment API | explicit assignment commands |
| `jobs` | State UoW / Job repository | State UoW only | Job registry, status and Dashboard read models, retention eligibility | Job retention plus central history-expiry UoW |
| `job_interactions` | State UoW / Job repository | State UoW | status, unfinished-work query | Job progress/terminal commands |
| `activity_events` | State UoW / Activity event repository | State UoW | Activity/status projection | event-retention slice |
| `job_events` | Event repository | State UoW inserts through `EventRetention`; `EventRetention` deletes/normalizes | Job hydration and diagnostics | event-retention slice; central history-expiry UoW delegates deletion |
| `completion_outbox` | State UoW / Activity completion repository | State UoW | completion delivery, retention protection | completion commands |
| `agent_mutations` | State UoW / mutation receipt repository | State UoW | idempotency reads | command capacity policy |
| `cancellation_operations` | State UoW / cancellation repository | State UoW | cancellation/status projection | cancellation commands |
| `cancellation_intents` | State UoW / cancellation repository | State UoW | cancellation, unfinished-work and retention protection | cancellation commands |
| `steering_deliveries` | State UoW / steering repository | State UoW | steering/status and retention protection | steering commands |
| `transport_observations` | compatibility-only legacy journal | no production appends after telemetry cutover | rollback-era diagnostics only | retained until a later schema migration |
| `user_questions` | `QuestionStore` | `QuestionStore` | Question query/card paths | question slice and startup recovery |
| `codex_question_deliveries` | `QuestionStore` | `QuestionStore` | Question delivery commands | question slice and startup recovery |
| `thread_connections` | `ThreadConnectionStore` | `ThreadConnectionStore` | admission, connection controller, Dashboard | connection controller only; no DB retention |
| `event_budget` | Event repository | SQLite event triggers | `EventRetention` | event-retention slice |
| `event_retention_state` | Event repository | `EventRetention` | `EventRetention` | event-retention slice |
| `result_holds` | State UoW / result repository | State UoW | retention protection | event-retention slice expires holds |
| `work_history_state` | `WorkHistoryStore` | `WorkHistoryStore` | Dashboard/history/problem projection | history slice |
| `work_history_control` | `WorkHistoryStore` | `WorkHistoryStore` | history policy and review projection | history slice |
| `runtime_problem_resolutions` | `WorkHistoryStore` | `WorkHistoryStore` | Dashboard problem projection | explicit review commands |
| `automatic_recovery` | `AutomaticRecoveryStore` | `AutomaticRecoveryStore` | recovery controller and Dashboard | recovery slice |
| `automatic_recovery_incidents` | `AutomaticRecoveryStore` | `AutomaticRecoveryStore` | recovery controller | recovery slice |
| `job_completion_deliveries` | State UoW / exact completion repository | State UoW | completion delivery and retention protection | central history-expiry UoW |
| `operational_command_receipts` | State UoW / isolated command receipt repository | State UoW in the same mutation transaction | command replay and outcome-unknown recovery | idempotent maintenance receipts: 24-hour uncertainty window, 500-row bounded slice; business-command receipts require a separate reference-aware policy |

`jobs.summary` is part of the Job repository even though event retention derives
its `execution`, `usage`, and `uncertainResponseReview` projection. The event
domain therefore uses the narrow summary repository rather than issuing raw
cross-domain `UPDATE jobs` statements.

The opt-in MCP Events journal (`mcp_events_v1/`) and approved-followup receipts
(`task_followup_v1/`) use narrow State UoW metadata methods on that same writer.
Exact terminal result plus event intent, and followup Job plus admission receipt,
commit atomically with the existing Job transaction. These journals are separate
from diagnostic `job_events`, native `completion_outbox`, and card/completion
receipt facts. Projection workers do not activate the outbound event worker.
The journal is capped at 256 subscriptions and eight per Job; its finite result
recovery protection survives webhook ACK and unsubscribe. See [MCP Events](mcp-events.md).

## Query and command boundaries

- `CodexJobRegistry.get`, `list`, counts and lookup helpers never prune or
  persist. Project identity projection checks `project_registry.registry_revision`
  and reloads identities only after that revision changes.
- `QuestionStore.get` and `readResponses` do not prune or acknowledge. An
  expired record is hidden by its timestamp; `consumeResponse` is the explicit
  acknowledgement command.
- `DashboardReadModel.archivedByAgent` uses a SQL window and materializes at
  most one archived row per Agent for ordinary overview, or thirteen only for
  the explicitly requested history view. Representative selection is explicit:
  filtered status views preserve the Dashboard's created-time “latest run”
  meaning, while update-time ordering remains available for recent-history
  projection. The remaining history rows retain update-time order.
- `DashboardReadModel.agentHistory` applies the same split at the Agent-detail
  boundary: it always returns the exact created-time representative plus at
  most twelve update-time-ordered rows that explicitly exclude that Job. The
  representative therefore cannot fall outside the bounded history window.
- Problem and automatic-recovery pages select their page before hydrating Job
  details. The selected Job IDs are fetched exactly, independently of the
  bounded recent overview, and their summaries are loaded in the same bulk
  cache used by ordinary rows. `agentHistory` also returns the exact total from
  the same statement.
- Dashboard token summaries are fetched once in chunks of at most 500 Job IDs
  and reused for the request. No turn or row performs its own summary SELECT.
- `StatusReadModel` provides exact Job and scope projections with no writes.

## Maintenance slices

The scheduler runs one slice per tick. Every slice has its own transaction and
failure record; the connection controller neither invokes nor owns maintenance.

| Slice | Bound |
| --- | --- |
| Events | 500 policy rows, 500 age rows, bounded per-Job/global deletion loops |
| History | 500 candidates and a 25 ms cooperative loop deadline |
| Questions | 500 expirations, journals, and stale notification leases |
| Recovery | 500 recovery rows and 500 incident rows |
| Command receipts | 500 expired maintenance receipts plus 500 cursor-paged unused followup grants; admitted followup tombstones are preserved; event expiry is independently capped at 256 subscriptions |
| Jobs | Registry defaults to 64 inspected candidates and 32 removals (hard caps 256/64) with a 10 ms cooperative planning deadline; the state owner revalidates the transmitted candidates under the same bounded execution deadline before atomically archiving eligible rows |

The one-time startup load may normalize the complete persisted Job set before
serving requests. Runtime maintenance never treats the configured retained-Job
ceiling as a scan bound; each invocation advances the explicit slice above.
Active Jobs reserve retained capacity before admission. A terminal Job keeps
that reservation until bounded idle maintenance removes it or verifies a
durable protection. Admission applies `JOB_RETENTION_CAPACITY` backpressure at
the ceiling, so foreground deferral cannot create an unbounded terminal-Job
backlog. Replays of an already admitted request remain available while this
backpressure is active. Protocol-v4 Job maintenance preserves the exact bounded
candidate payload and command ID across outcome-unknown recovery. Registry
memory is changed only after the state owner returns matching Job version and
timestamp classifications; a stale candidate is skipped rather than archived.

Production selects the state-owner child as the complete application/state
coordinator. Operational admission, progress, cancellation and delivery run in
that one writer; external/native callers cross protocol v2. Dashboard and
Settings queries use the read-only projection child. The protocol-v4
maintenance child remains a conformance harness and is never started beside the
production owner.

Protected history candidates receive a 15-minute in-process backoff before the
next full multi-table protection check. Losing the cache on restart is safe: it
causes an extra conservative check, never premature expiry.

## Write-path and query-plan decisions

An ordinary public progress event now has four explicit SQL writes (excluding
trigger-internal budget accounting): bounded Job state, interaction projection,
one `UPSERT ... RETURNING` scope bump, and the event insert. Event coalescing and
per-Job retention issue deletes only when a matching or over-limit row exists.
State-only progress remains two writes.

Current-policy event sweep rows are compared byte-for-byte and are not updated
when normalization produces the stored payload. Legacy or policy-upgrade rows
still use the restartable event cursor.

Schema 25 intentionally keeps no `result_holds(expires_at)` index. Holds are a
sparse, manually created subset with a 30-day maximum lifetime; the maintenance
query is capped at 500, and adding an index would add a write and page cost to
every hold. The storage audit records the scan so this decision can be revisited
if operating cardinality changes. History candidate selection is likewise
cursor- and time-bounded; its remaining temporary sort is recorded rather than
silently changing the released schema. Event age/order scans use the integer
primary-key order and bounded batches.

## External schema consumers

The macOS helper calls `inspectRegisteredProjectRoots` from
`stateProjectInspection.ts`. That common read-only compatibility boundary owns
schema-version validation, `projects` column interpretation, absolute-path
validation, and the read-only SQLite connection. The helper no longer embeds a
second project-table query.

The bridge never performs a live `VACUUM`. Storage audits open the operating
database read-only, work from a consistent disposable backup, and perform
`VACUUM INTO` only on that copy.
