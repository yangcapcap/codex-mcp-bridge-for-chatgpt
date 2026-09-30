# Bridge database schema and lifecycle

Schema 30 is the current SQLite schema. `src/stateSchema.ts` contains the complete
DDL and projections used for a new installation. `src/stateStore.ts` contains
upgrade code for schemas 3 through 30; schemas 1 and 2 are rejected. The published v0.2 and
v0.3 line used schema 3, and the pre-change development installation used schema
18. Every supported upgrade ends with the same tables, columns, constraints,
indexes, and triggers as direct schema-31 creation.

The database is the durable authority for Bridge business state: admission,
scope and permission decisions, project and Activity relationships, request
idempotency, result storage and delivery receipts. Actual Codex turn events and
worker lifetime are established by the App Server and the execution owner, as
described in [execution authority and evidence](execution-authority-and-evidence.md).
Settings, projects, retained sessions, and Jobs no longer have parallel JSON
files or JSON mirrors. SQLite
payloads remain where their contents are inherently variable, but fields used for
identity, joins, constraints, state transitions, or indexes are columns and are
removed from those payloads.

Best-effort transport telemetry is deliberately outside this authority. The
isolated production runtime stores it in a separate `telemetry.sqlite` database
with its own WAL, bounded queue, and retention. Telemetry failure is observable
but cannot change an operational command. The schema-25
`transport_observations` table remains for rollback and direct in-process
compatibility; the isolated production path does not write it.

## Ownership rules

`projects` owns a project's UUID, opaque public reference, revision, current name,
current default folder, order, and archive/delete state. Other tables store a
`project_id` only when they need a relationship. Readers join `projects.name`, so
a rename appears consistently in Settings, current work, and history. There is no
project-name history table or snapshot fallback. Archiving keeps the relationship
and current name. Deleting a registration excludes it from Settings, selection,
new admission, and tracked-project counts, while its tombstone remains the naming
authority for already retained history. A row with no valid project relationship
is shown without a project and is never guessed from a name or folder.

A registered project's current default folder is different from an admitted
execution folder:

- `sessions.cwd` and `sessions.sandbox` own the execution context of a retained
  backend thread. Continue and fork validate this context even after the project
  is relocated.
- `activities.pinned_cwd` owns the folder admitted for the Activity. It exists
  exactly when `activities.project_id` exists.
- `jobs.cwd` and `jobs.sandbox` record the context of that concrete execution.
  They are first-class fields for recovery, retention, and path-reuse checks.
- `agent_threads` owns Agent membership and current/history linkage only. Its
  execution fields are read by joining `sessions`.

`jobs` owns the current Job state, result/error receipt payload, last progress,
terminal provenance, and one compact display summary. `job_events` owns bounded
diagnostic event history. `job_interactions` owns current blocking/nonblocking
input state. There is no `job_summaries` table, and progress events do not write a
full Job document. `scopes.version` is the one scope CAS/event sequence; there is
no `scope_versions` mirror.

## Complete schema-30 table matrix

The retention column describes bridge cleanup. SQLite free pages are reusable but
remain allocated until an offline compaction; physical erasure is therefore a
separate operation.

Schema 20 removes the retired `execution_mode` columns from `activities` and
`jobs`, and removes any legacy `executionMode` member from Job payload JSON.
Admission has one durable asynchronous execution path; Job lifecycle remains
authoritative in `status`, versions, terminal provenance, and the retained
result/error receipt. Schema 21 adds exact live-Dashboard completion delivery;
schema 22 records the legacy path that marked a terminal result as read. Schema
23 adds separate completion-receipt and direct-query result-offer timestamps.
Creating a tool response is no longer treated as proof that ChatGPT received it,
and a direct query no longer consumes a pending live-card delivery. The current
Job payload also retains the immutable admission-time `completionDeliveryPolicy`;
legacy rows default to `live-card`, while `direct-wait` rows cannot claim the
live-card lease. This payload-compatible addition does not require a table
migration. Schema 24
added GPT–user Decision Card tables. The feature was retired in #141, but this
migration remains immutable for older database upgrades. Schema 25
adds compact operational command receipts in the same transaction as the
isolated state mutation so an IPC response-loss retry cannot duplicate work.
Schema 26 adds version history for user-authored model descriptions. The active
override stays in `user_settings`; a history row contains user text or a marker
for using the current official catalog description. Existing active overrides
are imported as the first version without inventing a save time.
Schema 27 removes the four retired Decision Card tables without changing Codex
Jobs, questions, answers, completion delivery, or operational receipts.
Schemas 28 and 29 add bounded history and recovery indexes. Schema 30 stores a
non-secret authentication ownership boundary on each retained session. Existing
sessions keep a null boundary because an upgrade cannot infer their owner.

| Table | Current consumer and authoritative fields | Decision and retention |
| --- | --- | --- |
| `bridge_meta` | Schema version and migration facts; installation HMAC keys; bounded conversation-link and late-response journals whose formats are owned by their modules | Keep for distinct installation/schema metadata. Dynamic work-history, event-retention, and runtime-resolution keys moved to typed tables. Obsolete JSON-import markers and the transient upgrade-in-progress marker are deleted at v19; the original upgrade source version remains as provenance. |
| `scopes` | Scope resolver and all scoped mutations; `scope_id`, `version`, creation/update time | Keep as scope identity and the single atomic sequence. Retained while referenced. `scope_versions` was merged here. |
| `bridge_instances` | Restart ownership, cancellation/delivery provenance, diagnostics; process and stop facts | Keep as an append-only operational journal. Open older instances are marked superseded at startup; rows remain while provenance can reference them. |
| `project_registry` | Project registry CAS; singleton `registry_revision`, `updated_at` | Keep separately because registry-wide CAS has a different lifetime from each project revision. |
| `projects` | Settings, admission, current-name projection; UUID/ref/revision, current `name`, canonical key, current `cwd`, order, archive/delete times | Sole registered-project authority. Archived/deleted rows remain while execution relationships refer to them; a deleted tombstone can label retained history but cannot be selected or admitted. Active name and cwd are unique. |
| `user_settings` | `UserSettingsStore`; ordinary settings JSON plus independent settings CAS and update time | Keep one JSON object because presentation/policy settings evolve together and are not joined individually. Project arrays/default aliases are forbidden here. |
| `model_description_versions` | Per-model user description revisions, save time, and official-selection markers | Append a version in the same transaction as the active override change. Never copy official catalog text into history. Retain history through general Settings reset and catalog disappearance. Fetch one model at a time in bounded pages. |
| `sessions` | Session registry, continue/fork, Agent thread projection, cwd reuse; thread/scope/project relationship, `auth_boundary`, and structured backend execution context | Canonical retained-thread execution context. A null legacy owner remains historical and cannot be resumed under the current login. Global session retention removes old unreferenced sessions; an Agent thread prevents deletion. No payload or project-name copy. |
| `activities` | Activity lifecycle, admission, counters, and completion state; optional project relation and pinned cwd | Keep current workflow authority. Project name copies and duplicate project UUID/cwd columns were removed. Retained Activity state does not imply an Activity-card presenter. |
| `agents` | Agent identity and live lifecycle; current thread/job pointers, version, orphan evidence | Keep current Agent authority. `archived_at` and the `archived` lifecycle are removed; schema 18 restored archived Agents once before schema 19. |
| `agent_threads` | Agent membership/history and current-thread selection; context mode and link/replacement times | Keep relationship data only. Thread execution details come from `sessions`; invalid legacy-project contexts are dropped and are never resumed or mapped to a new project. |
| `activity_agents` | Activity-to-Agent assignment history; role, context mode, assignment/release times | Keep because Activity membership has a different lifecycle from Agent thread membership. Active pairs are unique. |
| `jobs` | Admission replay receipt, execution/recovery state, Dashboard/current/history projection; formal identity, source/current thread, status, execution context, versions/progress, terminal provenance, immutable completion-delivery policy, bounded `summary`, variable result/error `payload` | Keep one row per admitted request. Legacy payloads read as `live-card`; each new Job snapshots `live-card` or experimental `direct-wait`, and later Settings changes cannot rewrite it. Full result bodies normally follow result retention. After a ChatGPT card crosses the send boundary, an unresolved completion is protected only through the selected run-history period; a completion-receipt offer grants one ordinary result-retention recovery window. Later history expiry reduces payload to the compact replay receipt but preserves `(scope_id, request_id)` and terminal outcome. An exact scoped Job/request status read can return that compact admission fact without restoring expired content. Structured fields cannot also appear in payload. Summary may contain only `execution`, `usage`, and `uncertainResponseReview`; status, timestamps, duration, and error provenance stay in formal columns or the retained Job payload lifecycle. |
| `job_interactions` | Input/approval wait projection, retention protection, unfinished-work checks; authoritative `interaction_id`/`is_blocking` plus the remaining variable interaction payload | Keep only the current interaction set and replace it atomically with Job state. The two structured fields are reconstructed for public DTOs and do not remain in payload JSON. Delete with the Job. Replaces `pendingInteractions` JSON scans. |
| `activity_events` | Activity cursor/watch and compatibility diagnostics | Bounded diagnostic/control history: at most 50,000 recent rows and seven-day cleanup in batches. Delete with Activity/scope. |
| `job_events` | Progress projection, usage/reroute summary extraction, status cursors | Bounded diagnostics: 256 per Job, global 50,000 rows/64 MiB payload budget, 8 KiB per payload, seven-day metadata cleanup. Delete with Job. Does not contain a full Job copy. |
| `completion_outbox` | Durable local completion-notification selection, dispatch, acknowledgement, and retry state | Keep delivery authority independently of Dashboard presentation. The local macOS companion claims only retryable `notify` records through its private socket and acknowledges an exact record only after macOS accepts its generic notification. `verify` records are never sent as success notifications. A failed presentation releases its lease; a crash after presentation can be retried, so the outbox does not claim exactly-once visible delivery. |
| `job_completion_deliveries` | One exact ChatGPT completion audit event per terminal Job; stable opaque receipt, bounded live-card lease, host acceptance/rejection/uncertainty, legacy result-read evidence, and separate completion/direct result-offer times | Separate from the native Activity outbox. Only a `live-card` Job in the authenticated originating conversation with its exact Dashboard presentation can claim it. A `direct-wait` Job keeps the row for offer/retention audit but cannot claim a lease. A direct Job/request offer never consumes or settles this event. `ui/message` carries only the receipt lookup instruction; its text and the Job result are not copied into this row. A completion-receipt offer starts one ordinary result-recovery window. Before that offer, a delivery that crossed the send boundary protects the exact result no later than selected run-history expiry; a merely pending cardless event follows ordinary result retention. Acceptance uncertainty is never replayed automatically. Delete the delivery row when its run-history entry expires; keep the Job's compact request reservation and terminal outcome. |
| `agent_mutations` | Agent mutation request replay/idempotency; scoped request hash/result | Keep as the durable replay receipt for retained mutation requests. It is not a second Agent state store. |
| `cancellation_operations` | Root cancellation request idempotency, exact target/proof/result | Keep while request replay and audit provenance are needed. It is protected from generic event cleanup. |
| `cancellation_intents` | Per-target cancellation dispatch and result provenance | Keep recorded/dispatched intents through restart; terminal evidence remains with the retained request journal. Target indexes serve protection and recovery checks. |
| `steering_deliveries` | Steering idempotency and delivery certainty; prompt digest, expected Job version, status/result | Keep prepared/dispatching/uncertain records through restart and retain completed evidence with the request receipt. Prompt text is never stored here. |
| `transport_observations` | Rollback/direct-runtime compatibility for bounded aborted/detached/presentation diagnostics | Non-authoritative and disposable. Isolated production writes the separate telemetry database instead, so this table grants no replay or execution authority. |
| `user_questions` | Question request/answer state and response reference | Keep until its explicit expiry; startup removes expired rows. Payload is question state, not a Job mirror. |
| `codex_question_deliveries` | Codex-originated question delivery idempotency | Keep one scoped request/question-reference receipt so restart cannot redeliver the same question as new. |
| `thread_connections` | App Server connection ownership, handoff/release and recovery inspection | Keep current connection evidence independently of `sessions`: a saved execution context does not prove a live connection. Unfinished-work checks join indexed Job/interactions/cancellation fields. |
| `event_budget` | Trigger-maintained Job-event row and payload-byte counters | Derived singleton. Rebuilt during migration and updated by three triggers; it is not a DB/WAL or backup size limit. |
| `event_retention_state` | Event cleanup policy generation and restartable event cursor | Keep typed singleton because the cursor has transactional cleanup semantics. Replaces dynamic `bridge_meta` keys. |
| `result_holds` | Temporary operator/result-review protection; reason and expiry | Keep only until `expires_at`; maintenance deletes expired holds in batches. Delete with Job. |
| `work_history_state` | Per-Job optional acknowledgement, display expiry, and review sequence | Keep while the Job receipt exists. It changes review/display state without changing the Job outcome. Delete with Job. |
| `work_history_control` | Global review revision, restartable history cursor, cleanup totals | Keep typed singleton because global CAS/pagination invalidation and cleanup progress have distinct semantics. Replaces dynamic `bridge_meta` keys. |
| `runtime_problem_resolutions` | Current runtime-problem resolution evidence by Agent revision | Keep the latest matching resolution only; delete with Agent. Replaces one dynamic meta key per Agent. |
| `automatic_recovery` | Durable bounded recovery action/budget; kind/state/attempts/schedule/evidence | Keep unresolved work through restart and retained resolved evidence through history retention. It never authorizes arbitrary new execution. |
| `automatic_recovery_incidents` | Stable incident identity to active recovery relationship | Keep current and historical incident identity so a restart does not reset attempt limits; one recovery key per incident. |
| `operational_command_receipts` | Isolated-state command ID, operation, payload digest, optional aggregate/version, compact result, committing generation and time | Keep through the unresolved IPC uncertainty window. Idempotent `maintain` receipts are eligible after 24 hours and are removed in bounded 500-row slices; future business-command receipts require a separate reference-aware policy. An identical retained command retry returns the original result; a changed operation, payload hash, or aggregate fails closed. Receipt storage does not prove an external recipient accepted an effect. |

Schema 18 also had `scope_versions` and `job_summaries`; both are removed above.
Its other project label/UUID/name/cwd snapshot columns, session payload, Agent archive
column, and dynamic retention/history meta keys are represented in the matrix by
their schema-19 owners rather than by compatibility tables.

## Index and query contract

The schema defines 44 non-SQLite indexes and three event-budget triggers. The
indexes below are correctness or bounded-work contracts rather than incidental
optimizations:

| Query | Required access path |
| --- | --- |
| Active work for a connection | `jobs_thread_active`, `jobs_source_thread_active`, `jobs_agent_active`, `job_interactions_blocking`, and cancellation target indexes |
| Project rename/cwd conflicts and display order | `projects_active_name`, `projects_active_cwd`, `projects_ordered` |
| Scope/status/Activity Job views | `jobs_scope_recent`, `jobs_status_recent`, `jobs_activity_recent` |
| Event cursors and per-Job cleanup | `activity_events_*_cursor`, `job_events_*_cursor` |
| Pending native Activity completion delivery | `completion_outbox_pending` |
| Claimable exact Job live-card delivery | `job_completion_deliveries_claimable` |
| History cleanup and review | `jobs_status_recent`, `work_history_state` primary key, `work_history_expired` |
| Question and hold expiry | `user_questions_expiry`; bounded `result_holds` scan of at most 500 rows |
| Connection/recovery maintenance | `thread_connections_idle`, `thread_connections_agent`, `automatic_recovery_scope`, `automatic_recovery_job` |

Run the read-only storage audit against an explicit database to record actual
plans and timings. It backs up the source through SQLite and performs migration,
query, and compaction experiments only on temporary copies:

```bash
npx tsx scripts/database-storage-audit.ts /absolute/path/to/state.sqlite report.json
npx tsx scripts/card-state-restart-audit.ts /absolute/path/to/state.sqlite restart-report.json
```

The first audit reports logical cell payload, allocated and reusable pages, main
DB/WAL/SHM sizes, migration-backup totals, serialization bytes, the old/current
progress write paths, query plans, representative unfinished-work latency, and a
verified offline `VACUUM INTO` copy. The restart audit compares entity keys; full
normalized scope, Activity, Agent, work-history, and session execution state;
Agent/thread relationships; Job receipts; and exact rows for 18 critical
settings, request, question, cancellation, delivery, and recovery tables. It
allows only the declared invalid legacy-project context removal. Its second
restart must be byte-semantically stable for every current table except the
append-only bridge-instance journal.

The checked-in [schema-18 restart audit](audits/issue-95-state-restart.json)
preserved all 672 Job receipts, all 351 valid session execution contexts, and all
313 valid Agent/thread relationships; removed exactly the 43 invalid
legacy-project sessions and 43 corresponding Agent-thread relationships, exposed
31 tools on both reads, and found no business
table change on the second restart. The point-in-time
[storage audit](audits/issue-95-database-storage.json) measured a 196,378,624-byte
main DB, 4,124,152-byte WAL, 160,403,456 reusable bytes, and five older backups
totalling 239,480,832 bytes. On its disposable migrated copy, structured Job and
interaction payload duplicates and redundant summary fields were zero. The public-event
progress path changed from nine to seven SQL write statements, and a throttled
state-only progress tick uses two, excluding trigger updates. Full Job
serialization/upsert and unconditional summary/connection writes each changed from
one to zero. The sampled progress-state serialization
estimate was 93.281% smaller, 201 unfinished-work probes changed
from 80.106 ms total to 0.679 ms total with answers unchanged and keyed searches
on all three current identity indexes, and the verified compact copy was
10,252,288 bytes. These are measurements of that local
copy, not end-to-end service latency or evidence of a live replacement.

## Upgrade and legacy-data rules

A fresh database creates schema 30 directly. A persistent supported older database
is inspected before a writable SQLite connection opens. The canonical-file lock,
live-owner check, integrity and foreign-key checks, permissions, free-space
calculation, verified backup, sequential conversion, and final verification all
complete before the HTTP or stdio service opens. Path aliases share the same lock.
Development and candidate packages use separate default state profiles; selecting
the stable DB requires an explicit profile or absolute-file override.

The upgrade gets one private, mode-0600 backup named
`state.sqlite.pre-v<SOURCE>-to-v30.sqlite` and a bound metadata sidecar. The
sidecar records the logical/physical database identity, source and target runtime
facts, migration path/checksums, snapshot checksum, integrity/foreign-key results,
and a digest of table row counts. Retrying the same upgrade reuses and fully
revalidates that pair instead of accumulating another copy. Before the durable
source marker exists, a same-named stale pair is replaced; afterward it is never
overwritten. A missing, changed, wrong-schema, or other-database recovery point
fails closed.

Every intermediate migration records its literal destination version and an
append-only applied-provenance record. A pending record is committed before each
step and reconciled if the process stops after the schema transaction but before
the provenance transaction. No step writes the current-version constant. The
schema-19 rebuild and its foreign-key check run in one transaction. The following
schema-20 projection removes execution-mode state without changing request IDs,
request hashes, Job status/results, events, or deduplication receipts. Schema 21
adds one completion-delivery row only when a Job becomes terminal after that
contract is active; it does not backfill old terminal Jobs. Schema 22 adds and
backfills only the result-read source for already consumed schema-21 deliveries.
Schema 23 projects those historical rows into result-offer evidence and adds
separate offer timestamps for new completion-receipt and direct-query responses.
It does not infer receipt from response construction and does not replay legacy
`result-read` rows whose transport outcome cannot be reconstructed. Schema 24
adds the four independent decision-card tables without backfilling or changing
any Codex Job, Question, completion, or Activity record.
Schema 25 adds an empty command-receipt table and index without backfilling or
changing existing domain state.
Schema 26 imports each active user-authored model description as version 1 with
an unknown save time, then records later changes without copying official text.
Schema 27 drops the four retired Decision Card tables, including their legacy
submissions. The original migration snapshot must be disposed of after service
acceptance under the [runbook policy](state-upgrade-recovery.md#retired-decision-data-and-backup-disposal).
Schema 28 adds `jobs_agent_recent_history` so Agent history reads can find the
latest retained Job without scanning archived rows across the full Job table.
An interrupted or invalid conversion rolls its transaction back and can be retried
after the source problem is corrected. The full operational and restore procedure is in the
[state upgrade and recovery runbook](state-upgrade-recovery.md).

Schema-18 project values are accepted only when their UUID matches `projects`.
A session or Agent-thread context with project metadata but no registered-project
match is removed. An Agent-thread row can supply a fallback session only when no
legacy session exists for that thread; it cannot replace a rejected session. The
Agent-thread relationship is also validated independently, so a bad relationship
beside a valid session is removed without removing the session. Its Agent becomes
orphaned if it would otherwise claim a removed current context. Historical Job
request/terminal receipts remain, with project metadata removed and no guessed
relationship. Migration never creates a project from a slug, name, cwd, or old
snapshot.

The supported schema-3 fixture is taken from the published v0.3.0 implementation
and passes every fixed checkpoint through schema 30. Exact deployed-development
fixtures cover schemas 16 and 18; schemas 4 through 15, 17, and 19 through 30 are generated
only as named, committed checkpoints from those sources. `state-migrations.json` binds
their provenance and hashes to the shipped implementation. Schemas 1 and 2 are
outside the supported release floor and are rejected before a backup or mutation.
Removed JSON import markers/backends cannot reintroduce retired fields on later
restarts.

## Capacity, backups, and offline compaction

The schema-30 table/write/read/maintenance ownership matrix and the command,
query, and bounded scheduler contracts are documented in
[State data access and maintenance ownership](state-data-access.md).
The selected two-database process, IPC, readiness, migration and fault contract
is documented in
[State execution isolation architecture](state-execution-isolation.md).

Treat four measurements separately:

1. Logical data is table row counts and SQLite cell-payload bytes.
2. Allocation is `page_size * page_count`; reusable allocation is
   `page_size * freelist_count`.
3. Runtime files are the main database, `-wal`, and `-shm` sidecars.
4. Migration backups are separate private files and are not limited by
   `event_budget`.

The bridge uses WAL, `synchronous=FULL`, foreign keys, a five-second busy timeout,
and mode 0600 for persistent database/backup files. Live retention keeps
transactions bounded and leaves free pages for reuse. It never runs `VACUUM` on a
live bridge.

Keep the most recent verified pre-upgrade backup through the release's physical
upgrade validation and the operator's chosen rollback window. Once that window
ends and the upgraded database has survived normal restarts, remove older backups
as a deliberate operator action. Backups contain the same private material as the
source database and require the same access controls. The bridge does not silently
delete them because release and rollback policy belong to the operator. Keep each
backup with its `.migration-v<SOURCE>-to-v30.backup.json` sidecar. Supported
snapshot restore is allowed only while the migrated DB records that neither HTTP
nor stdio service-open occurred; after that boundary, preserve current state and
use forward repair or explicit data reconciliation. See the
[recovery runbook](state-upgrade-recovery.md).

For disk compaction:

1. Stop the bridge cleanly and confirm no bridge process holds the database.
2. Retain a consistent SQLite backup that includes committed WAL content; do not
   copy only the main file from a running WAL database.
3. Open the stopped database, run `PRAGMA integrity_check` and
   `PRAGMA foreign_key_check`, then checkpoint the WAL.
4. Run `VACUUM INTO` a new mode-0600 file on the same protected filesystem.
5. Open the new file and repeat integrity, foreign-key, schema-version, and table
   count checks before an atomic replacement.
6. Keep the pre-compaction backup until the restarted bridge passes its state and
   UI reads. On any failure, stop the bridge and restore the verified complete
   backup rather than combining an old main file with a newer WAL.

The storage audit executes and verifies steps 2–5 on disposable copies and leaves
the live database untouched. A report with `liveDatabaseReplacementPerformed:
false` is implementation evidence, not evidence that an operator has compacted or
released a production installation.

The complete schema-30 table, explicit index and trigger ownership inventory,
including command/query consumers, recovery dependencies, future destination and
two-database file security rules, is in
[State schema ownership catalog](state-schema-ownership-catalog.md).

Schema31 additionally retains the ten CoGate Workspace/HMAC storage tables and
three immutable lineage archive tables. Their current ownership and constraints
are listed in [the schema ownership catalog](state-schema-ownership-catalog.md#schema31-cogate-storage-extension).
The legacy operator conversion and actor integration remain unavailable.
