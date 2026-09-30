# State schema ownership catalog

This catalog is the schema-31 operational inventory and telemetry schema
inventory required by issues #142 and #143. In production the operational
state-owner process is the only `state.sqlite` writer, the read process opens it
read-only, and the telemetry process is the only `telemetry.sqlite` writer.

Indexes and triggers inherit the writer, durability, migration, backup and
destination contract of their parent table. No caller may address an index or
trigger through the state-owner IPC protocol; callers use semantic commands and
queries only.

## Tables and paths

| Table | Current writer / command path | Principal readers and maintenance | Recovery or durability dependency | Target |
| --- | --- | --- | --- | --- |
| `bridge_meta` | `BridgeStateStore` startup, migration and service-open commands | startup verification, HMAC, migration and rollback checks | database identity, schema provenance, service-open rollback boundary | state |
| `bridge_instances` | `BridgeStateStore` runtime registration and shutdown | startup recovery and forensics | live/old owner detection and termination evidence | state |
| `scopes` | Activity/Agent/Job Units of Work | exact status, Dashboard and scope event cursors | scope version is authorization and ordering evidence | state |
| `project_registry` | project/settings mutations | task admission and project projection refresh | monotonic registry revision | state |
| `projects` | project/settings mutations | admission, Settings and Dashboard projections | project identity, archived/deleted state and pinned path | state |
| `user_settings` | `UserSettingsStore` mutation | Settings and task admission | execution policy and settings revision | state |
| `model_description_versions` | `UserSettingsStore` mutation through `BridgeStateStore` | macOS Settings and Settings card history reads | retained user-authored description versions and official-selection markers | state |
| `sessions` | `SessionRegistry` and Activity admission UoW | resume, Agent thread and backend routing queries | retained backend context and persistence classification | state |
| `activities` | `CodexJobRegistry` Activity commands and Job UoW | exact status, Dashboard, completion and recovery | goal lifecycle, version and terminal counters | state |
| `agents` | Agent commands and Job assignment UoW | admission, Dashboard and recovery | execution owner, lifecycle and current Job/thread | state |
| `agent_threads` | Agent link/replace commands | resume, handoff and Dashboard | current thread uniqueness and history | state |
| `activity_agents` | assign/release commands | activity and scope projections | assignment provenance and active-pair uniqueness | state |
| `jobs` | admission, progress, interaction and terminal UoW | exact status, Dashboard, history, completion and recovery | request idempotency, terminal state and bounded result | state |
| `job_interactions` | Job progress/input UoW | exact input/status and Dashboard | unresolved user input authority | state |
| `activity_events` | Activity/Job UoW | activity cursors, status summary and Dashboard | scope ordering and authoritative lifecycle projection | state (mixed; review later) |
| `job_events` | Job UoW | exact status cursor, usage/summary extraction and recovery | current Job event ordering and summary evidence | state (mixed; review later) |
| `event_budget` | `job_events` triggers only | event retention budget checks | bounded authoritative event storage | state |
| `event_retention_state` | `EventRetention` maintenance | restartable event cleanup | retention cursor and budget progress | state |
| `result_holds` | completion/read commands and retention | result access and event retention | prevents premature result deletion | state |
| `completion_outbox` | Activity completion UoW and native delivery commands | native completion delivery | durable pending/leased/delivered evidence | state |
| `job_completion_deliveries` | terminal Job UoW and host receipt commands | exact completion result paths | acceptance uncertainty, leases and offer evidence | state |
| `agent_mutations` | Agent mutation UoW | duplicate-request lookup | mutation idempotency receipt | state |
| `cancellation_operations` | cancellation UoW | duplicate lookup and recovery | logical cancellation idempotency and aggregate result | state |
| `cancellation_intents` | cancellation UoW | impact review, status and recovery | cancellation provenance and dispatch certainty | state |
| `steering_deliveries` | steering UoW | duplicate lookup and recovery | prepared/dispatching/delivered uncertainty journal | state |
| `user_questions` | `QuestionStore` commands | question/result tools and expiry maintenance | user-response authority and expiry | state |
| `codex_question_deliveries` | `QuestionStore` delivery commands | question notification recovery | delivery claim and uncertainty evidence | state |
| `thread_connections` | `ThreadConnectionStore` commands | admission and connection controller | unfinished-work and handoff/release state | state |
| `work_history_state` | `WorkHistoryStore` commands and history maintenance | Dashboard/history projections | acknowledgement and expiry state | state |
| `work_history_control` | `WorkHistoryStore` policy commands | retention policy | cleanup policy revision | state |
| `runtime_problem_resolutions` | problem review commands | Dashboard problem projection | acknowledged runtime problem revision | state |
| `automatic_recovery` | `AutomaticRecoveryStore` commands | recovery controller | retry budget, lease and terminal recovery state | state |
| `automatic_recovery_incidents` | `AutomaticRecoveryStore` commands/maintenance | recovery diagnostics and review | bounded incident evidence used by recovery policy | state |
| `transport_observations` | compatibility-only; production appends go to the telemetry service | older private diagnostics retained for rollback compatibility | no mutation authority; bounded loss is allowed | retained unused in state until a later schema migration |
| `operational_command_receipts` | isolated state command Unit of Work | response-loss recovery and identical-command replay | commit proof for the IPC uncertainty window; payload-hash conflicts fail closed | state |

## Index inventory

The current schema contains these explicit indexes. Every name is tied to its
parent table and is covered by the same owner above.

- `activities`: `activities_continuation`, `activities_project_pin`,
  `activities_scope_attention`, `activities_scope_recent`
- `activity_agents`: `activity_agents_active_pair`,
  `activity_agents_activity_history`, `activity_agents_agent_history`
- `activity_events`: `activity_events_activity_cursor`,
  `activity_events_scope_cursor`
- `agent_threads`: `agent_threads_agent_history`, `agent_threads_one_current`
- `agents`: `agents_scope_state_recent`
- `automatic_recovery`: `automatic_recovery_agent_state`, `automatic_recovery_due`,
  `automatic_recovery_interrupted`, `automatic_recovery_job`,
  `automatic_recovery_retention`, `automatic_recovery_scope`
- `automatic_recovery_incidents`: `automatic_recovery_incident_retention`
- `cancellation_intents`: `cancellation_intents_cascade`,
  `cancellation_intents_operation`, `cancellation_intents_target_activity`,
  `cancellation_intents_target_job`
- `cancellation_operations`: `cancellation_operations_target_activity`,
  `cancellation_operations_target_job`
- `completion_outbox`: `completion_outbox_pending`
- `job_completion_deliveries`: `job_completion_deliveries_claimable`
- `job_events`: `job_events_job_cursor`, `job_events_scope_cursor`
- `job_interactions`: `job_interactions_blocking`
- `jobs`: `jobs_activity_recent`, `jobs_agent_active`, `jobs_agent_recent_history`, `jobs_scope_recent`,
  `jobs_history_retention`, `jobs_source_thread_active`, `jobs_status_recent`, `jobs_thread_active`
- `operational_command_receipts`: `operational_command_receipts_committed`
- `projects`: `projects_active_cwd`, `projects_active_name`, `projects_ordered`
- `sessions`: `sessions_project_recent`, `sessions_scope_recent`
- `steering_deliveries`: `steering_deliveries_job_recent`,
  `steering_deliveries_status_recent`
- `thread_connections`: `thread_connections_agent`, `thread_connections_handoff`,
  `thread_connections_idle`, `thread_connections_protected`,
  `thread_connections_release_due`, `thread_connections_worker`
- `transport_observations`: `transport_observations_recent`
- `user_questions`: `user_questions_expiry`
- `work_history_state`: `work_history_expired`

SQLite automatically created indexes are implementation details of declared
primary-key and unique constraints and inherit the table contract. They are
intentionally excluded by the `sqlite_%` rule in the inventory test.

## Trigger inventory

`event_budget_insert`, `event_budget_delete` and `event_budget_update` are the
only current explicit triggers. They are owned by the `job_events` write UoW and
update `event_budget` in the same transaction. Neither object can move to
telemetry while Job events remain operational.

## Telemetry schema

These objects exist only in `telemetry.sqlite` and are created by the telemetry
child. They are intentionally absent from the operational schema inventory test.

| Table | Writer | Content and failure policy |
| --- | --- | --- |
| `telemetry_meta` | telemetry startup transaction | schema version, telemetry UUID and source `state_database_id`; a wrong source is quarantined and rebuilt |
| `transport_observations` | bounded telemetry queue | sanitized aborted/detached/presentation observations; detail may be dropped |
| `runtime_measurements` | bounded telemetry queue | component/metric count, min, max and sum duration samples |
| `diagnostic_events` | bounded telemetry queue | sanitized severity/component/reason transitions |
| `telemetry_drop_counters` | reserved telemetry control message | persistent kind/count/first/last evidence for queue, send and write loss |
| `telemetry_retention_state` | each successful detail transaction | restartable per-kind cleanup cursor and completion time |
| `telemetry_record_deliveries` | each successful detail transaction | bounded idempotency map from delivery UUID to actual record ID; startup collisions are remapped and ACK-loss retries cannot be silently ignored |

Telemetry indexes are `transport_observations_recent`,
`runtime_measurements_recent` and `diagnostic_events_recent`. The independent
retention caps are 1,000 transport observations, 5,000 measurements and 2,000
diagnostic events.

## File, IPC and backup security contract

- The state and telemetry directories are mode `0700`; database, WAL, SHM,
  backup, migration journal and digest files are mode `0600`. Startup refuses a
  non-regular canonical database target or an ownership/alias conflict rather
  than following an unsafe replacement.
- The telemetry child inherits only a minimal process environment and its local
  IPC channel. The Codex executor receives the CLI environment but explicitly
  receives no Bridge database path, bearer token, skills path or companion
  socket. Its separate private execution socket and finite in-memory receipt
  journal survive a control reconnect; its auxiliary ownership ledger contains
  process identities, not Job payloads or another state database. The state owner
  receives authoritative command payloads; the read
  child has read-only database authority and opens no listener.
- `state.sqlite` backups are sensitive operational artifacts and receive the
  same permissions and retention handling as the live database. A backup must
  include committed WAL content through the verified SQLite backup path; copying
  the main file alone is invalid.
- `telemetry.sqlite` and its backups remain private even though raw prompts,
  results, secrets, absolute project paths and unsanitized subprocess output are
  forbidden. Sanitization happens before queue admission, not after persistence.
- Backup manifests record database identity, schema, source generation, byte
  size and digest. Restore validation uses those fields and SQLite integrity and
  foreign-key checks before any service-open marker is written.
- Telemetry loss never authorizes restoring older operational state. Once the
  new operational generation accepts a command, an older state backup cannot be
  automatically selected; rollback must preserve the new authoritative writes.

## Coverage rule

`test/stateSchemaOwnership.test.ts` opens a fresh schema-31 fixture and requires
every non-SQLite-internal table, explicit index and trigger in `sqlite_master` to
appear in this catalog. Adding or renaming a schema object without updating its
owner and destination therefore fails the test.

## Schema31 CoGate storage extension

The state-service migration owns creation and the disabled control initializer.
Workspace/HMAC actor integration and the operator converter remain unavailable.
The read-only startup probe authenticates all extension DDL before any state
initialization; storing a conversion binding never supplies operating authority.
There is no retention/delete path for archived lineage evidence.

| Table | Current write owner | Read boundary | Maintenance |
| --- | --- | --- | --- |
| `workspace_control` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `workspaces` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `workspace_events` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `workspace_git_operations` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `workspace_legacy_hazards` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `scope_aliases` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `scope_rotation_lookup_evidence` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `security_hmac_keys` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `security_key_rotation_plans` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `security_key_rotation_events` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `cogate_lineage_conversions` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `cogate_legacy_metadata` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |
| `cogate_legacy_execution_modes` | State-service schema migration only; actor/converter writes pending | Exact DDL authentication at admission; no new public API | No deletion or forced reconciliation |

Retained explicit indexes and triggers:

- `scope_aliases_canonical` on `scope_aliases` retains the fixed legacy constraint.
- `scope_rotation_lookup_canonical` on `scope_rotation_lookup_evidence` retains the fixed legacy constraint.
- `security_hmac_one_active` on `security_hmac_keys` retains the fixed legacy constraint.
- `security_hmac_one_pending` on `security_hmac_keys` retains the fixed legacy constraint.
- `security_key_rotation_event_order` on `security_key_rotation_events` retains the fixed legacy constraint.
- `security_key_rotation_one_applied` on `security_key_rotation_events` retains the fixed legacy constraint.
- `security_key_rotation_one_applying` on `security_key_rotation_events` retains the fixed legacy constraint.
- `security_key_rotation_one_prepared` on `security_key_rotation_events` retains the fixed legacy constraint.
- `workspace_repository` on `workspaces` retains the fixed legacy constraint.
- `workspace_scope` on `workspaces` retains the fixed legacy constraint.
- `scope_alias_rejects_existing_scope` on `scope_aliases` retains the fixed legacy constraint.
- `scope_aliases_no_delete` on `scope_aliases` retains the fixed legacy constraint.
- `scope_aliases_no_update` on `scope_aliases` retains the fixed legacy constraint.
- `scope_rotation_lookup_evidence_guard_insert` on `scope_rotation_lookup_evidence` retains the fixed legacy constraint.
- `scope_rotation_lookup_evidence_no_delete` on `scope_rotation_lookup_evidence` retains the fixed legacy constraint.
- `scope_rotation_lookup_evidence_no_update` on `scope_rotation_lookup_evidence` retains the fixed legacy constraint.
- `security_hmac_keys_guard_update` on `security_hmac_keys` retains the fixed legacy constraint.
- `security_hmac_keys_no_delete` on `security_hmac_keys` retains the fixed legacy constraint.
- `security_key_rotation_events_no_delete` on `security_key_rotation_events` retains the fixed legacy constraint.
- `security_key_rotation_events_no_update` on `security_key_rotation_events` retains the fixed legacy constraint.
- `security_key_rotation_plans_no_delete` on `security_key_rotation_plans` retains the fixed legacy constraint.
- `security_key_rotation_plans_no_update` on `security_key_rotation_plans` retains the fixed legacy constraint.
- `cogate_lineage_conversions_no_update` on `cogate_lineage_conversions` rejects mutation of archived evidence.
- `cogate_lineage_conversions_no_delete` on `cogate_lineage_conversions` rejects mutation of archived evidence.
- `cogate_legacy_metadata_no_update` on `cogate_legacy_metadata` rejects mutation of archived evidence.
- `cogate_legacy_metadata_no_delete` on `cogate_legacy_metadata` rejects mutation of archived evidence.
- `cogate_legacy_execution_modes_no_update` on `cogate_legacy_execution_modes` rejects mutation of archived evidence.
- `cogate_legacy_execution_modes_no_delete` on `cogate_legacy_execution_modes` rejects mutation of archived evidence.
- `cogate_lineage_conversions_no_replace` on `cogate_lineage_conversions` rejects all existing-key inserts, including SQLite REPLACE and UPSERT. The archive has no mutable rowid alias.
- `cogate_legacy_metadata_no_replace` on `cogate_legacy_metadata` rejects all existing-key inserts, including SQLite REPLACE and UPSERT. The archive has no mutable rowid alias.
- `cogate_legacy_execution_modes_no_replace` on `cogate_legacy_execution_modes` rejects all existing-key inserts, including SQLite REPLACE and UPSERT. The archive has no mutable rowid alias.
