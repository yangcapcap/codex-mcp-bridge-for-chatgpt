/**
 * Schema 19 remains the immutable released base DDL used by its recorded
 * migration. Fresh databases apply the v20 through v31 projections below in the
 * same transaction; older databases follow the append-only migration catalog.
 */
export const CURRENT_STATE_SCHEMA_VERSION = "31";

export const CURRENT_STATE_SCHEMA = `
  CREATE TABLE scopes (
    scope_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE bridge_instances (
    instance_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    termination_reason TEXT,
    process_id INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload))
  ) STRICT;

  CREATE TABLE project_registry (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    registry_revision INTEGER NOT NULL CHECK(registry_revision >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT;
  INSERT INTO project_registry(singleton, registry_revision, updated_at) VALUES (1, 0, 0);

  CREATE TABLE projects (
    project_id TEXT PRIMARY KEY,
    project_ref TEXT NOT NULL UNIQUE,
    project_revision INTEGER NOT NULL CHECK(project_revision >= 1),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    cwd TEXT NOT NULL,
    sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    deleted_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX projects_active_name ON projects(name_key)
    WHERE archived_at IS NULL AND deleted_at IS NULL;
  CREATE UNIQUE INDEX projects_active_cwd ON projects(cwd)
    WHERE archived_at IS NULL AND deleted_at IS NULL;
  CREATE INDEX projects_ordered ON projects(deleted_at, archived_at, sort_order, created_at);

  CREATE TABLE user_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    settings_revision INTEGER NOT NULL DEFAULT 0 CHECK(settings_revision >= 0),
    updated_at INTEGER
  ) STRICT;

  /* sessions is the canonical execution context for a retained backend thread. */
  CREATE TABLE sessions (
    thread_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
    backend_kind TEXT NOT NULL,
    cwd TEXT NOT NULL,
    sandbox TEXT NOT NULL CHECK(sandbox IN ('read-only','workspace-write','danger-full-access')),
    session_id TEXT,
    forked_from_thread_id TEXT,
    persistence TEXT NOT NULL CHECK(persistence IN ('persistent','ephemeral','unknown')),
    visible_in_codex_app INTEGER CHECK(visible_in_codex_app IN (0,1)),
    selection TEXT CHECK(selection IS NULL OR json_valid(selection)),
    policy_revision INTEGER CHECK(policy_revision IS NULL OR policy_revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_scope_recent ON sessions(scope_id, last_used_at DESC);
  CREATE INDEX sessions_project_recent ON sessions(project_id, last_used_at DESC);

  CREATE TABLE activities (
    activity_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL,
    pinned_cwd TEXT,
    continuation_of_activity_id TEXT REFERENCES activities(activity_id),
    card_generation INTEGER NOT NULL DEFAULT 1 CHECK(card_generation >= 1),
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('discussion','investigation','review','implementation','other')),
    execution_mode TEXT NOT NULL CHECK(execution_mode IN ('foreground','background')),
    handoff_policy TEXT NOT NULL CHECK(handoff_policy IN ('none','notify','verify')),
    completion_trigger TEXT NOT NULL CHECK(completion_trigger IN ('manual','sealed-jobs-terminal')),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('open','sealed','terminating','completed','cancelled','abandoned')),
    waiting_on TEXT NOT NULL CHECK(waiting_on IN ('none','codex','orchestrator','user','verification')),
    verification TEXT NOT NULL CHECK(verification IN ('not-required','pending','verifying','verified','failed')),
    version INTEGER NOT NULL CHECK(version >= 1),
    completion_version INTEGER NOT NULL DEFAULT 0 CHECK(completion_version >= 0),
    legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sealed_at INTEGER,
    completed_at INTEGER,
    total_jobs INTEGER NOT NULL DEFAULT 0 CHECK(total_jobs >= 0),
    running_jobs INTEGER NOT NULL DEFAULT 0 CHECK(running_jobs >= 0),
    completed_jobs INTEGER NOT NULL DEFAULT 0 CHECK(completed_jobs >= 0),
    failed_jobs INTEGER NOT NULL DEFAULT 0 CHECK(failed_jobs >= 0),
    interrupted_jobs INTEGER NOT NULL DEFAULT 0 CHECK(interrupted_jobs >= 0),
    cancelled_jobs INTEGER NOT NULL DEFAULT 0 CHECK(cancelled_jobs >= 0),
    terminal_jobs INTEGER NOT NULL DEFAULT 0 CHECK(terminal_jobs >= 0),
    CHECK((project_id IS NULL) = (pinned_cwd IS NULL))
  ) STRICT;
  CREATE INDEX activities_scope_recent ON activities(scope_id, updated_at DESC);
  CREATE INDEX activities_scope_attention ON activities(scope_id, waiting_on, verification, updated_at DESC);
  CREATE INDEX activities_continuation ON activities(continuation_of_activity_id, created_at ASC);
  CREATE INDEX activities_project_pin ON activities(project_id, pinned_cwd, lifecycle);

  CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    agent_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('idle','active','waiting-input','orphaned')),
    current_thread_id TEXT,
    current_job_id TEXT,
    version INTEGER NOT NULL CHECK(version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    orphaned_reason TEXT,
    UNIQUE(scope_id, normalized_name)
  ) STRICT;
  CREATE INDEX agents_scope_state_recent ON agents(scope_id, lifecycle, updated_at DESC);

  /* Thread execution fields are read through sessions; this table owns only Agent membership. */
  CREATE TABLE agent_threads (
    thread_id TEXT PRIMARY KEY REFERENCES sessions(thread_id) ON DELETE RESTRICT,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
    context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','fork','fresh')),
    is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
    linked_at INTEGER NOT NULL,
    replaced_at INTEGER
  ) STRICT;
  CREATE INDEX agent_threads_agent_history ON agent_threads(agent_id, linked_at ASC);
  CREATE UNIQUE INDEX agent_threads_one_current ON agent_threads(agent_id) WHERE is_current = 1;

  CREATE TABLE activity_agents (
    assignment_id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE RESTRICT,
    role TEXT NOT NULL,
    context_mode TEXT NOT NULL CHECK(context_mode IN ('continue','fork','fresh')),
    assigned_at INTEGER NOT NULL,
    released_at INTEGER
  ) STRICT;
  CREATE INDEX activity_agents_activity_history ON activity_agents(activity_id, assigned_at ASC);
  CREATE INDEX activity_agents_agent_history ON activity_agents(agent_id, assigned_at ASC);
  CREATE UNIQUE INDEX activity_agents_active_pair ON activity_agents(activity_id, agent_id)
    WHERE released_at IS NULL;

  CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL,
    activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
    thread_id TEXT,
    source_thread_id TEXT,
    status TEXT NOT NULL CHECK(status IN (
      'running','terminating','termination-failed','completed','failed','interrupted','cancelled'
    )),
    execution_mode TEXT NOT NULL CHECK(execution_mode IN ('foreground','background')),
    backend_kind TEXT NOT NULL,
    bridge_instance_id TEXT,
    worker_id TEXT,
    worker_generation INTEGER,
    upstream_request_id TEXT,
    terminal_version INTEGER,
    agent_id TEXT REFERENCES agents(agent_id),
    context_mode TEXT CHECK(context_mode IN ('continue','fork','fresh')),
    cwd TEXT NOT NULL,
    sandbox TEXT NOT NULL CHECK(sandbox IN ('read-only','workspace-write','danger-full-access')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    job_version INTEGER NOT NULL CHECK(job_version >= 1),
    last_progress_at INTEGER NOT NULL,
    last_progress TEXT CHECK(last_progress IS NULL OR json_valid(last_progress)),
    terminal_origin TEXT CHECK(terminal_origin IS NULL OR terminal_origin IN (
      'normal-completion','upstream-failure','app-server-interrupted','explicit-cancellation',
      'assignment-containment','bridge-restart','worker-loss','sdk-abort','sdk-timeout',
      'authentication-failure','usage-limit','legacy-unattributed-cancellation'
    )),
    cancellation_intent_id TEXT,
    summary TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary)),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    UNIQUE(scope_id, request_id)
  ) STRICT;
  CREATE INDEX jobs_scope_recent ON jobs(scope_id, updated_at DESC);
  CREATE INDEX jobs_status_recent ON jobs(status, updated_at DESC);
  CREATE INDEX jobs_activity_recent ON jobs(activity_id, updated_at DESC);
  CREATE INDEX jobs_thread_active ON jobs(thread_id, status) WHERE archived_at IS NULL;
  CREATE INDEX jobs_source_thread_active ON jobs(source_thread_id, status) WHERE archived_at IS NULL;
  CREATE INDEX jobs_agent_active ON jobs(agent_id, status) WHERE archived_at IS NULL;

  CREATE TABLE job_interactions (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    interaction_id TEXT NOT NULL,
    is_blocking INTEGER NOT NULL CHECK(is_blocking IN (0,1)),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    PRIMARY KEY(job_id, position),
    UNIQUE(job_id, interaction_id)
  ) STRICT;
  CREATE INDEX job_interactions_blocking ON job_interactions(job_id) WHERE is_blocking = 1;

  CREATE TABLE activity_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
    scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
    event_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload))
  ) STRICT;
  CREATE INDEX activity_events_activity_cursor ON activity_events(activity_id, event_id);
  CREATE INDEX activity_events_scope_cursor ON activity_events(scope_id, scope_version, event_id);

  CREATE TABLE job_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
    scope_version INTEGER NOT NULL CHECK(scope_version >= 1),
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload))
  ) STRICT;
  CREATE INDEX job_events_job_cursor ON job_events(job_id, event_id);
  CREATE INDEX job_events_scope_cursor ON job_events(scope_id, scope_version, event_id);

  CREATE TABLE completion_outbox (
    outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
    completion_version INTEGER NOT NULL CHECK(completion_version >= 1),
    channel TEXT NOT NULL CHECK(channel IN ('notify','verify')),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at INTEGER,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    delivered_at INTEGER,
    acknowledged_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(activity_id, completion_version, channel)
  ) STRICT;
  CREATE INDEX completion_outbox_pending ON completion_outbox(delivered_at, next_attempt_at, created_at);

  CREATE TABLE agent_mutations (
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    result TEXT NOT NULL CHECK(json_valid(result)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_id, request_id)
  ) STRICT;

  CREATE TABLE cancellation_operations (
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL,
    root_intent_id TEXT NOT NULL UNIQUE,
    action_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('model-tool','widget-control','activity-cascade','operator','assignment-containment')),
    tool_name TEXT NOT NULL,
    action_name TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('job','activity')),
    target_job_id TEXT,
    target_activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
    target_agent_id TEXT,
    target_thread_id TEXT,
    target_turn_id TEXT,
    target_presentation_id TEXT,
    expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
    caller_presentation_kind TEXT CHECK(caller_presentation_kind IN ('automatic','explicit')),
    caller_presentation_id TEXT,
    widget_instance_present INTEGER NOT NULL CHECK(widget_instance_present IN (0,1)),
    widget_instance_digest TEXT,
    card_generation INTEGER CHECK(card_generation >= 1),
    caller_request_digest TEXT,
    bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('recorded','completed','failed')),
    result TEXT CHECK(result IS NULL OR json_valid(result)),
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    reason_text TEXT CHECK(reason_text IS NULL OR length(reason_text) BETWEEN 1 AND 500),
    PRIMARY KEY(scope_id, request_id),
    CHECK((target_kind = 'job') = (target_job_id IS NOT NULL)),
    CHECK((widget_instance_present = 1) = (widget_instance_digest IS NOT NULL)),
    CHECK((caller_presentation_kind = 'automatic') = (caller_presentation_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX cancellation_operations_target_job ON cancellation_operations(target_job_id, created_at ASC);
  CREATE INDEX cancellation_operations_target_activity ON cancellation_operations(target_activity_id, created_at ASC);

  CREATE TABLE cancellation_intents (
    intent_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    parent_intent_id TEXT REFERENCES cancellation_intents(intent_id) ON DELETE RESTRICT,
    cascade_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('model-tool','widget-control','activity-cascade','operator','assignment-containment')),
    tool_name TEXT NOT NULL,
    action_name TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK(target_kind IN ('job','activity')),
    target_job_id TEXT,
    target_activity_id TEXT NOT NULL REFERENCES activities(activity_id) ON DELETE RESTRICT,
    target_agent_id TEXT,
    target_thread_id TEXT,
    target_turn_id TEXT,
    target_presentation_id TEXT,
    expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
    caller_presentation_kind TEXT CHECK(caller_presentation_kind IN ('automatic','explicit')),
    caller_presentation_id TEXT,
    widget_instance_present INTEGER NOT NULL CHECK(widget_instance_present IN (0,1)),
    widget_instance_digest TEXT,
    card_generation INTEGER CHECK(card_generation >= 1),
    caller_request_digest TEXT,
    bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('recorded','dispatched','succeeded','failed','no-op')),
    created_at INTEGER NOT NULL,
    dispatched_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY(scope_id, request_id) REFERENCES cancellation_operations(scope_id, request_id) ON DELETE RESTRICT,
    CHECK((target_kind = 'job') = (target_job_id IS NOT NULL)),
    CHECK((widget_instance_present = 1) = (widget_instance_digest IS NOT NULL)),
    CHECK((caller_presentation_kind = 'automatic') = (caller_presentation_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX cancellation_intents_operation ON cancellation_intents(scope_id, request_id, created_at ASC);
  CREATE INDEX cancellation_intents_target_job ON cancellation_intents(target_job_id, created_at ASC);
  CREATE INDEX cancellation_intents_target_activity ON cancellation_intents(target_activity_id, created_at ASC);
  CREATE INDEX cancellation_intents_cascade ON cancellation_intents(cascade_id, created_at ASC);

  CREATE TABLE steering_deliveries (
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    job_id TEXT NOT NULL,
    expected_job_version INTEGER NOT NULL CHECK(expected_job_version >= 1),
    prompt_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','delivered','not-delivered','uncertain')),
    bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
    result TEXT CHECK(result IS NULL OR json_valid(result)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    dispatched_at INTEGER,
    completed_at INTEGER,
    PRIMARY KEY(scope_id, request_id),
    CHECK(length(action_hash) = 64),
    CHECK(length(prompt_sha256) = 64),
    CHECK((status IN ('prepared','dispatching')) = (completed_at IS NULL))
  ) STRICT;
  CREATE INDEX steering_deliveries_job_recent ON steering_deliveries(job_id, created_at DESC);
  CREATE INDEX steering_deliveries_status_recent ON steering_deliveries(status, updated_at DESC);

  CREATE TABLE transport_observations (
    observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('http-request-aborted','http-response-detached','mcp-handler-aborted','status-wait-aborted','activity-watch-aborted','presentation-superseded')),
    scope_id TEXT,
    job_id TEXT,
    activity_id TEXT,
    tool_name TEXT,
    caller_request_digest TEXT,
    bridge_instance_id TEXT NOT NULL REFERENCES bridge_instances(instance_id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX transport_observations_recent ON transport_observations(created_at DESC, observation_id DESC);

  CREATE TABLE user_questions (
    question_id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    response_ref TEXT UNIQUE,
    expires_at INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    UNIQUE(scope_id, request_id)
  ) STRICT;
  CREATE INDEX user_questions_expiry ON user_questions(expires_at);

  CREATE TABLE codex_question_deliveries (
    scope_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    question_ref TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_id, request_id),
    UNIQUE(scope_id, question_ref)
  ) STRICT;

  CREATE TABLE thread_connections (
    thread_id TEXT PRIMARY KEY,
    agent_id TEXT,
    scope_id TEXT NOT NULL,
    persistence TEXT NOT NULL CHECK(persistence IN ('persistent','ephemeral','unknown')),
    phase TEXT NOT NULL,
    handoff_requested INTEGER NOT NULL DEFAULT 0,
    last_finished_at INTEGER,
    last_job_id TEXT,
    worker_pid INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    reason TEXT,
    evidence TEXT
  ) STRICT;
  CREATE INDEX thread_connections_idle ON thread_connections(phase, last_finished_at);
  CREATE INDEX thread_connections_agent ON thread_connections(agent_id);

  CREATE TABLE event_budget (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    rows INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  ) STRICT;
  INSERT INTO event_budget(id, rows, bytes) VALUES (1, 0, 0);
  CREATE TRIGGER event_budget_insert AFTER INSERT ON job_events BEGIN
    UPDATE event_budget SET rows=rows+1, bytes=bytes+length(CAST(NEW.payload AS BLOB)) WHERE id=1;
  END;
  CREATE TRIGGER event_budget_delete AFTER DELETE ON job_events BEGIN
    UPDATE event_budget SET rows=rows-1, bytes=bytes-length(CAST(OLD.payload AS BLOB)) WHERE id=1;
  END;
  CREATE TRIGGER event_budget_update AFTER UPDATE OF payload ON job_events BEGIN
    UPDATE event_budget SET bytes=bytes+length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)) WHERE id=1;
  END;

  CREATE TABLE event_retention_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    policy_version INTEGER NOT NULL CHECK(policy_version >= 1),
    cursor_event_id INTEGER NOT NULL CHECK(cursor_event_id >= 0)
  ) STRICT;
  INSERT INTO event_retention_state(singleton, policy_version, cursor_event_id) VALUES (1, 2, 0);

  CREATE TABLE result_holds (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE work_history_state (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    acknowledged_at INTEGER,
    expired_at INTEGER,
    review_sequence INTEGER
  ) STRICT;
  CREATE INDEX work_history_expired ON work_history_state(expired_at);

  CREATE TABLE work_history_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    review_revision INTEGER NOT NULL DEFAULT 0 CHECK(review_revision >= 0),
    cursor_updated_at INTEGER NOT NULL DEFAULT 0 CHECK(cursor_updated_at >= 0),
    cursor_job_id TEXT NOT NULL DEFAULT '',
    last_cleanup_at INTEGER,
    last_cleanup_count INTEGER NOT NULL DEFAULT 0 CHECK(last_cleanup_count >= 0),
    total_removed INTEGER NOT NULL DEFAULT 0 CHECK(total_removed >= 0)
  ) STRICT;
  INSERT INTO work_history_control(singleton) VALUES (1);

  CREATE TABLE runtime_problem_resolutions (
    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    resolved_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE automatic_recovery (
    recovery_key TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    job_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('recheck','retry-stop','release')),
    state TEXT NOT NULL CHECK(state IN ('retrying','resolved','blocked')),
    attempts INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    evidence TEXT
  ) STRICT;
  CREATE INDEX automatic_recovery_scope ON automatic_recovery(scope_id, updated_at);
  CREATE INDEX automatic_recovery_job ON automatic_recovery(job_id);

  CREATE TABLE automatic_recovery_incidents (
    identity_key TEXT PRIMARY KEY,
    recovery_key TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0,1)),
    updated_at INTEGER NOT NULL
  ) STRICT;
`;

/** Remove the retired foreground/background execution choice from durable
 * current state. Request hashes, results, cancellation provenance, and the
 * scope/request uniqueness key remain untouched. */
export const V20_ASYNC_EXECUTION_MIGRATION_SCHEMA = `
  UPDATE jobs
     SET payload = json_remove(payload, '$.executionMode')
   WHERE json_type(payload, '$.executionMode') IS NOT NULL;
  ALTER TABLE activities DROP COLUMN execution_mode;
  ALTER TABLE jobs DROP COLUMN execution_mode;
`;

/**
 * Exact Job completion delivery is intentionally separate from the Activity
 * completion_outbox used by the native macOS notification channel. A stable
 * receipt identifies one terminal Job version but never grants scope access.
 */
export const V21_JOB_COMPLETION_DELIVERY_MIGRATION_SCHEMA = `
  CREATE TABLE job_completion_deliveries (
    job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE CASCADE,
    scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE CASCADE,
    terminal_version INTEGER NOT NULL CHECK(terminal_version >= 1),
    receipt TEXT NOT NULL UNIQUE CHECK(length(receipt) = 75),
    state TEXT NOT NULL CHECK(state IN (
      'pending','leased','host-rejected','host-accepted','acceptance-unknown','result-read'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at INTEGER,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    last_host_rejected_at INTEGER,
    last_host_error TEXT,
    host_accepted_at INTEGER,
    acceptance_unknown_at INTEGER,
    result_read_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    CHECK(state = 'leased' OR (lease_owner IS NULL AND lease_expires_at IS NULL))
  ) STRICT;
  CREATE INDEX job_completion_deliveries_claimable
    ON job_completion_deliveries(scope_id, state, next_attempt_at, created_at);
`;

/**
 * Record which model-visible read path consumed an exact Job completion.
 * Existing schema-21 rows could only reach result-read through the opaque
 * completion receipt, so the migration can backfill that source without
 * inferring anything from host timing.
 */
export const V22_JOB_COMPLETION_RESULT_SOURCE_MIGRATION_SCHEMA = `
  ALTER TABLE job_completion_deliveries
    ADD COLUMN result_read_source TEXT CHECK(result_read_source IN (
      'completion-receipt','direct-job-query'
    ));
  UPDATE job_completion_deliveries
     SET result_read_source='completion-receipt'
   WHERE state='result-read';
`;

/**
 * A tool result being constructed and returned by the Bridge is not proof that
 * ChatGPT received it. Preserve the two offer paths separately without changing
 * the completion delivery state or stealing a live-card lease. Historical
 * result-read rows are retained and projected as offers; they are never replayed
 * merely because schema 23 cannot reconstruct the old transport outcome.
 */
export const V23_JOB_COMPLETION_RESULT_OFFER_MIGRATION_SCHEMA = `
  ALTER TABLE job_completion_deliveries
    ADD COLUMN completion_result_offered_at INTEGER;
  ALTER TABLE job_completion_deliveries
    ADD COLUMN direct_result_offered_at INTEGER;
  UPDATE job_completion_deliveries
     SET completion_result_offered_at=result_read_at
   WHERE result_read_at IS NOT NULL AND result_read_source='completion-receipt';
  UPDATE job_completion_deliveries
     SET direct_result_offered_at=result_read_at
   WHERE result_read_at IS NOT NULL AND result_read_source='direct-job-query';
`;

/** User-authored model descriptions have a durable, per-model history. The
 * active override remains in user_settings; the catalog text is never copied.
 * Legacy rows have no reliable description save time, so their time is NULL. */
export const V26_MODEL_DESCRIPTION_VERSIONS_MIGRATION_SCHEMA = `
  CREATE TABLE model_description_versions (
    model_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    description TEXT,
    created_at INTEGER,
    PRIMARY KEY(model_id, version)
  ) STRICT;
  INSERT INTO model_description_versions(model_id, version, description, created_at)
    SELECT json_each.key, 1, json_each.value, NULL
      FROM user_settings, json_each(user_settings.payload, '$.modelDescriptionOverrides')
     WHERE json_each.type = 'text' AND json_each.value <> '';
`;

/** The retired GPT–user Decision Card state has no current reader or writer.
 * Keep schema 24 intact for historical upgrades, then remove its four tables. */
export const V27_DECISION_CARD_RETIREMENT_MIGRATION_SCHEMA = `
  DROP TABLE decision_card_requests;
  DROP TABLE decision_submissions;
  DROP TABLE decision_card_versions;
  DROP TABLE decision_cards;
`;

/** Agent history lookups include archived Jobs; the active-only index cannot serve them. */
export const V28_JOB_HISTORY_INDEX_MIGRATION_SCHEMA = `
  CREATE INDEX IF NOT EXISTS jobs_agent_recent_history
    ON jobs(agent_id, created_at DESC, updated_at DESC, job_id DESC);
`;

/** Exact recovery and connection peers keep each background slice independent
 * of the size of the retained incident and connection catalogs. */
export const V29_BACKGROUND_WORK_INDEX_MIGRATION_SCHEMA = `
  CREATE INDEX IF NOT EXISTS automatic_recovery_agent_state
    ON automatic_recovery(agent_id, state, recovery_key);
  CREATE INDEX IF NOT EXISTS automatic_recovery_interrupted
    ON automatic_recovery(state, attempts, recovery_key);
  CREATE INDEX IF NOT EXISTS automatic_recovery_due
    ON automatic_recovery(state, next_attempt_at, recovery_key);
  CREATE INDEX IF NOT EXISTS automatic_recovery_retention
    ON automatic_recovery(updated_at, recovery_key);
  CREATE INDEX IF NOT EXISTS automatic_recovery_incident_retention
    ON automatic_recovery_incidents(updated_at, identity_key);
  CREATE INDEX IF NOT EXISTS jobs_history_retention
    ON jobs(updated_at, job_id)
    WHERE archived_at IS NOT NULL AND status IN ('completed','failed','interrupted','cancelled');
  CREATE INDEX IF NOT EXISTS thread_connections_worker
    ON thread_connections(worker_pid, thread_id);
  CREATE INDEX IF NOT EXISTS thread_connections_handoff
    ON thread_connections(handoff_requested, thread_id);
  CREATE INDEX IF NOT EXISTS thread_connections_protected
    ON thread_connections(thread_id)
    WHERE handoff_requested=1 OR phase!='connected';
  CREATE INDEX IF NOT EXISTS thread_connections_release_due
    ON thread_connections(persistence, last_finished_at, thread_id)
    WHERE phase != 'released';
`;

/** Older sessions have no proven owner. Keep them null and never assign the
 * current login retroactively when adding durable ownership. */
export const V30_SESSION_AUTH_BOUNDARY_MIGRATION_SCHEMA = `
  ALTER TABLE sessions ADD COLUMN auth_boundary TEXT;
`;
