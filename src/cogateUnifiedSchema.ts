/** Storage only; no conversion, approval or actor authority.
 * Retain the ten legacy Workspace/HMAC object sets and their constraints. */
export const V31_COGATE_UNIFIED_MIGRATION_SCHEMA = `
CREATE TABLE scope_aliases (
    alias_scope_id TEXT PRIMARY KEY,
    canonical_scope_id TEXT NOT NULL REFERENCES scopes(scope_id) ON DELETE RESTRICT,
    key_generation INTEGER NOT NULL CHECK(key_generation >= 2),
    rotation_id TEXT NOT NULL REFERENCES security_key_rotation_plans(rotation_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    CHECK(alias_scope_id <> canonical_scope_id),
    UNIQUE(key_generation,canonical_scope_id)
  ) STRICT;

CREATE TABLE scope_rotation_lookup_evidence (
    key_generation INTEGER NOT NULL CHECK(key_generation >= 1),
    lookup_scope_id TEXT NOT NULL,
    canonical_scope_id TEXT NOT NULL,
    rotation_id TEXT NOT NULL REFERENCES security_key_rotation_plans(rotation_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(key_generation,lookup_scope_id)
  ) STRICT;

CREATE TABLE security_hmac_keys (
    purpose TEXT NOT NULL CHECK(purpose IN ('scope','execution-policy')),
    generation INTEGER NOT NULL CHECK(generation >= 1),
    status TEXT NOT NULL CHECK(status IN ('active','pending','retired')),
    verification_mode TEXT NOT NULL CHECK(verification_mode IN ('sign-and-verify','scope-lookup-only','reject')),
    key_material TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
    rotation_id TEXT REFERENCES security_key_rotation_plans(rotation_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL,
    retired_at INTEGER,
    PRIMARY KEY(purpose,generation),
    UNIQUE(purpose,fingerprint),
    CHECK(
      (status = 'active' AND verification_mode = 'sign-and-verify' AND retired_at IS NULL) OR
      (status = 'pending' AND verification_mode = 'reject' AND rotation_id IS NOT NULL AND retired_at IS NULL) OR
      (status = 'retired' AND verification_mode IN ('scope-lookup-only','reject') AND retired_at IS NOT NULL)
    ),
    CHECK(purpose = 'scope' OR verification_mode <> 'scope-lookup-only')
  ) STRICT;

CREATE TABLE security_key_rotation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    rotation_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL CHECK(phase IN ('prepared','applying','applied','failed-prepare','failed-apply')),
    reason_code TEXT CHECK(reason_code IS NULL OR (
      length(reason_code) BETWEEN 10 AND 129 AND
      substr(reason_code,1,9)='SECURITY_' AND
      reason_code NOT GLOB '*[^A-Z0-9_]*'
    )),
    payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload) <= 16384),
    created_at INTEGER NOT NULL,
    CHECK((phase LIKE 'failed-%') = (reason_code IS NOT NULL))
  ) STRICT;

CREATE TABLE security_key_rotation_plans (
    rotation_id TEXT PRIMARY KEY,
    source_scope_generation INTEGER NOT NULL CHECK(source_scope_generation >= 1),
    target_scope_generation INTEGER NOT NULL CHECK(target_scope_generation > source_scope_generation),
    source_execution_generation INTEGER NOT NULL CHECK(source_execution_generation >= 1),
    target_execution_generation INTEGER NOT NULL CHECK(target_execution_generation > source_execution_generation),
    control_revision INTEGER NOT NULL CHECK(control_revision >= 1),
    before_schema_identity TEXT NOT NULL CHECK(length(before_schema_identity) = 64),
    before_data_identity TEXT NOT NULL CHECK(length(before_data_identity) = 64),
    migration_digest TEXT NOT NULL CHECK(length(migration_digest) = 64),
    build_id TEXT NOT NULL CHECK(length(build_id) BETWEEN 1 AND 512),
    created_at INTEGER NOT NULL
  ) STRICT;

CREATE TABLE workspace_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    mode TEXT NOT NULL CHECK(mode IN ('disabled','enabled','draining')),
    revision INTEGER NOT NULL CHECK(revision>0),
    maintenance INTEGER NOT NULL CHECK(maintenance IN (0,1)),
    updated_at INTEGER NOT NULL
  ) STRICT;

CREATE TABLE workspace_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    created_at INTEGER NOT NULL,
    UNIQUE(workspace_id,version)
  ) STRICT;

CREATE TABLE workspace_git_operations (
    repository TEXT PRIMARY KEY,
    owner TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    operation TEXT NOT NULL CHECK(operation IN ('allocate','handoff','remove')),
    state TEXT NOT NULL CHECK(state IN ('prepared','in-progress','uncertain')),
    created_at INTEGER NOT NULL
  ) STRICT;

CREATE TABLE workspace_legacy_hazards (
    owner TEXT PRIMARY KEY,
    repository TEXT,
    root TEXT NOT NULL,
    evidence TEXT NOT NULL CHECK(json_valid(evidence)),
    imported_at INTEGER NOT NULL
  ) STRICT;

CREATE TABLE workspaces (
    workspace_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE,
    scope_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    project_id TEXT NOT NULL,
    logical_root TEXT NOT NULL,
    repository TEXT NOT NULL,
    execution_cwd TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL UNIQUE,
    base_commit TEXT NOT NULL,
    owner_revision INTEGER NOT NULL CHECK(owner_revision>0),
    version INTEGER NOT NULL CHECK(version>0),
    generation INTEGER NOT NULL CHECK(generation>0),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN
      ('allocating','ready','dispatching','running','preserved','quarantined','released','removed')),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(scope_id,request_id)
  ) STRICT;

CREATE INDEX scope_aliases_canonical ON scope_aliases(canonical_scope_id,key_generation);

CREATE INDEX scope_rotation_lookup_canonical
    ON scope_rotation_lookup_evidence(canonical_scope_id,key_generation);

CREATE UNIQUE INDEX security_hmac_one_active
    ON security_hmac_keys(purpose) WHERE status = 'active';

CREATE UNIQUE INDEX security_hmac_one_pending
    ON security_hmac_keys(purpose) WHERE status = 'pending';

CREATE INDEX security_key_rotation_event_order
    ON security_key_rotation_events(rotation_id,sequence);

CREATE UNIQUE INDEX security_key_rotation_one_applied
    ON security_key_rotation_events(rotation_id) WHERE phase='applied';

CREATE UNIQUE INDEX security_key_rotation_one_applying
    ON security_key_rotation_events(rotation_id) WHERE phase='applying';

CREATE UNIQUE INDEX security_key_rotation_one_prepared
    ON security_key_rotation_events(rotation_id) WHERE phase='prepared';

CREATE INDEX workspace_repository ON workspaces(repository,lifecycle);

CREATE INDEX workspace_scope ON workspaces(scope_id,updated_at);

CREATE TRIGGER scope_alias_rejects_existing_scope
  BEFORE INSERT ON scope_aliases
  WHEN EXISTS(SELECT 1 FROM scopes WHERE scope_id=NEW.alias_scope_id)
  BEGIN SELECT RAISE(ABORT,'scope alias collides with canonical scope'); END;

CREATE TRIGGER scope_aliases_no_delete
  BEFORE DELETE ON scope_aliases
  BEGIN SELECT RAISE(ABORT,'scope aliases are immutable'); END;

CREATE TRIGGER scope_aliases_no_update
  BEFORE UPDATE ON scope_aliases
  BEGIN SELECT RAISE(ABORT,'scope aliases are immutable'); END;

CREATE TRIGGER scope_rotation_lookup_evidence_guard_insert
  BEFORE INSERT ON scope_rotation_lookup_evidence
  WHEN NOT EXISTS(
         SELECT 1 FROM security_key_rotation_plans p
         WHERE p.rotation_id=NEW.rotation_id
           AND p.source_scope_generation=NEW.key_generation
       )
    OR EXISTS(
         SELECT 1 FROM security_key_rotation_events e
         WHERE e.rotation_id=NEW.rotation_id AND e.phase='applied'
       )
    OR EXISTS(
         SELECT 1 FROM scope_aliases a
         WHERE a.alias_scope_id=NEW.canonical_scope_id
       )
  BEGIN SELECT RAISE(ABORT,'invalid scope rotation lookup evidence'); END;

CREATE TRIGGER scope_rotation_lookup_evidence_no_delete
  BEFORE DELETE ON scope_rotation_lookup_evidence
  BEGIN SELECT RAISE(ABORT,'scope rotation lookup evidence is immutable'); END;

CREATE TRIGGER scope_rotation_lookup_evidence_no_update
  BEFORE UPDATE ON scope_rotation_lookup_evidence
  BEGIN SELECT RAISE(ABORT,'scope rotation lookup evidence is immutable'); END;

CREATE TRIGGER security_hmac_keys_guard_update
  BEFORE UPDATE ON security_hmac_keys
  WHEN NOT (
    OLD.purpose=NEW.purpose AND OLD.generation=NEW.generation AND
    OLD.key_material=NEW.key_material AND OLD.fingerprint=NEW.fingerprint AND
    OLD.rotation_id IS NEW.rotation_id AND OLD.created_at=NEW.created_at AND
    (
      (OLD.status='active' AND OLD.verification_mode='sign-and-verify' AND
       NEW.status='retired' AND NEW.verification_mode IN ('scope-lookup-only','reject') AND
       OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL) OR
      (OLD.status='pending' AND OLD.verification_mode='reject' AND
       NEW.status='active' AND NEW.verification_mode='sign-and-verify' AND
       OLD.retired_at IS NULL AND NEW.retired_at IS NULL)
    )
  )
  BEGIN SELECT RAISE(ABORT,'invalid security HMAC key transition'); END;

CREATE TRIGGER security_hmac_keys_no_delete
  BEFORE DELETE ON security_hmac_keys
  BEGIN SELECT RAISE(ABORT,'security HMAC keys are immutable evidence'); END;

CREATE TRIGGER security_key_rotation_events_no_delete
  BEFORE DELETE ON security_key_rotation_events
  BEGIN SELECT RAISE(ABORT,'security rotation events are append-only'); END;

CREATE TRIGGER security_key_rotation_events_no_update
  BEFORE UPDATE ON security_key_rotation_events
  BEGIN SELECT RAISE(ABORT,'security rotation events are append-only'); END;

CREATE TRIGGER security_key_rotation_plans_no_delete
  BEFORE DELETE ON security_key_rotation_plans
  BEGIN SELECT RAISE(ABORT,'security rotation plans are immutable'); END;

CREATE TRIGGER security_key_rotation_plans_no_update
  BEFORE UPDATE ON security_key_rotation_plans
  BEGIN SELECT RAISE(ABORT,'security rotation plans are immutable'); END;

-- Fail-closed storage initialization; no dispatch authority.
INSERT INTO workspace_control(singleton,mode,revision,maintenance,updated_at)
VALUES(1,'disabled',1,0,0);

CREATE TABLE cogate_lineage_conversions (
  conversion_id TEXT PRIMARY KEY,
  format TEXT NOT NULL CHECK(format='cogate-lineage-conversion/v1'),
  logical_database_id TEXT NOT NULL UNIQUE,
  source_profile TEXT NOT NULL CHECK(source_profile='cogate-v2-workspace-hmac/schema21/v1'),
  source_schema INTEGER NOT NULL CHECK(source_schema=21),
  target_schema INTEGER NOT NULL CHECK(target_schema=31),
  source_preservation_sha256 TEXT NOT NULL CHECK(length(source_preservation_sha256)=64 AND source_preservation_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_projection_sha256 TEXT NOT NULL CHECK(length(target_projection_sha256)=64 AND target_projection_sha256 NOT GLOB '*[^0-9a-f]*'),
  implementation_sha256 TEXT NOT NULL CHECK(length(implementation_sha256)=64 AND implementation_sha256 NOT GLOB '*[^0-9a-f]*'),
  source_candidate_sha256 TEXT NOT NULL CHECK(length(source_candidate_sha256)=64 AND source_candidate_sha256 NOT GLOB '*[^0-9a-f]*'),
  target_candidate_sha256 TEXT NOT NULL CHECK(length(target_candidate_sha256)=64 AND target_candidate_sha256 NOT GLOB '*[^0-9a-f]*'),
  approval_sha256 TEXT NOT NULL CHECK(length(approval_sha256)=64 AND approval_sha256 NOT GLOB '*[^0-9a-f]*'),
  sealed_backup_sha256 TEXT NOT NULL CHECK(length(sealed_backup_sha256)=64 AND sealed_backup_sha256 NOT GLOB '*[^0-9a-f]*'),
  recorded_at TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK(json_valid(evidence))
) STRICT;

CREATE TABLE cogate_legacy_metadata (
  conversion_id TEXT NOT NULL REFERENCES cogate_lineage_conversions(conversion_id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(conversion_id,key)
) STRICT;

CREATE TABLE cogate_legacy_execution_modes (
  conversion_id TEXT NOT NULL REFERENCES cogate_lineage_conversions(conversion_id) ON DELETE RESTRICT,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('job','activity')),
  entity_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('foreground','background')),
  PRIMARY KEY(conversion_id,entity_kind,entity_id)
) STRICT;

CREATE TRIGGER cogate_lineage_conversions_no_update BEFORE UPDATE ON cogate_lineage_conversions
BEGIN SELECT RAISE(ABORT,'CoGate lineage evidence is immutable'); END;

CREATE TRIGGER cogate_lineage_conversions_no_delete BEFORE DELETE ON cogate_lineage_conversions
BEGIN SELECT RAISE(ABORT,'CoGate lineage evidence is immutable'); END;

CREATE TRIGGER cogate_legacy_metadata_no_update BEFORE UPDATE ON cogate_legacy_metadata
BEGIN SELECT RAISE(ABORT,'CoGate lineage evidence is immutable'); END;

CREATE TRIGGER cogate_legacy_metadata_no_delete BEFORE DELETE ON cogate_legacy_metadata
BEGIN SELECT RAISE(ABORT,'CoGate lineage evidence is immutable'); END;

CREATE TRIGGER cogate_legacy_execution_modes_no_update BEFORE UPDATE ON cogate_legacy_execution_modes
BEGIN SELECT RAISE(ABORT,'CoGate lineage evidence is immutable'); END;

CREATE TRIGGER cogate_legacy_execution_modes_no_delete BEFORE DELETE ON cogate_legacy_execution_modes
BEGIN SELECT RAISE(ABORT,'CoGate lineage evidence is immutable'); END;

`;

export const COGATE_UNIFIED_SCHEMA_TABLES = Object.freeze([
  "workspace_control",
  "workspaces",
  "workspace_events",
  "workspace_git_operations",
  "workspace_legacy_hazards",
  "scope_aliases",
  "scope_rotation_lookup_evidence",
  "security_hmac_keys",
  "security_key_rotation_plans",
  "security_key_rotation_events",
  "cogate_lineage_conversions",
  "cogate_legacy_metadata",
  "cogate_legacy_execution_modes"
]);

export const COGATE_UNIFIED_SCHEMA_OBJECTS_SHA256 = "60d44c402a95f5ca3e160c0b5922973d8e95148abb910d5558480f585bc51765";
