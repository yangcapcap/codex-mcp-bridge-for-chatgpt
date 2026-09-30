# State upgrade and recovery runbook

This runbook owns the release-time contract for the bridge SQLite database.
The current target is schema 31. Supported upstream source schemas are 3 through 30;
schemas 1 and 2, databases newer than 31, and the retired standalone Settings,
session, and Job JSON stores are rejected. `release-manifest.json` and
`state-migrations.json` are the machine-readable authorities.

Legacy CoGate schema21 is a distinct lineage and remains rejected before startup
writes. Schema31 adds storage only; the explicit operator conversion and actor
integration are not available. See [the conversion contract](cogate-unified-lineage-conversion.md).

Product SemVer, SQLite schema, Settings schema, protocol versions, and the
SQLite engine version are separate compatibility axes. A bridge executable is
safe for an existing database only when its manifest supports that source
schema and its migration catalog matches the packaged migration code.

## State profiles

The default database path follows the packaged release stage:

| Release stage | Default profile | Default database |
| --- | --- | --- |
| Stable | `stable` | `~/.codex-mcp-bridge/state.sqlite` |
| Release candidate | `candidate` | `~/.codex-mcp-bridge/profiles/candidate/state.sqlite` |
| Development or deprecated | `development` | `~/.codex-mcp-bridge/profiles/development/state.sqlite` |

Set `CODEX_MCP_BRIDGE_STATE_PROFILE` to `stable`, `candidate`, or
`development` to select one of those paths. An absolute
`CODEX_MCP_BRIDGE_STATE_DATABASE_FILE` takes precedence and is reported as the
`explicit` profile. A development or candidate build that explicitly targets
the stable path emits a startup warning.

The separate defaults prevent an ordinary development or candidate launch from
upgrading stable state. To test an upgrade, use a consistent protected copy in
the candidate profile. To deliberately upgrade operational state, stop the
stable runtime first and select the stable profile or exact absolute file. Do
not point two profiles at the same database through different path aliases.

## What startup enforces

Every persistent HTTP and stdio startup follows the same lifecycle:

1. Inspect the existing database read-only. Reject a malformed, unsupported, or
   future schema before enabling WAL or creating bridge tables.
2. Acquire one lock for the canonical database target. A symlink or alternate
   path to the same file resolves to the same owner.
3. Reinspect under the lock, reject a live bridge owner, and, for an upgrade,
   run `integrity_check`, `foreign_key_check`, file/directory permission checks,
   and a capacity check. Required free space is twice the current DB/WAL/SHM
   bytes plus 16 MiB of headroom.
4. Place the SQLite connection in exclusive migration mode. Create and verify
   one consistent source snapshot with `VACUUM INTO`; committed WAL content is
   included by SQLite.
5. Apply the catalogued steps in order. Each step commits its destination schema
   and records an ID, from/to schemas, implementation checksum, original source,
   product/build, and time. A durable pending record closes the crash window
   between the schema commit and its provenance record.
6. Validate the complete applied path, database integrity, foreign keys, and
   schema 30 before registering the runtime owner and opening a transport.

The private status file beside the DB ends in `.migration-status.json` and
records `preflight`, `backup`, `migrating`, `verifying`, `completed`, or
`failed`. The macOS helper accepts fresh status from the live migration process
as readiness progress. Each fresh checkpoint grants up to five more minutes,
bounded to 30 minutes from startup, so a valid migration is not treated as the
ordinary 60-second readiness failure. A single backup or migration step that
cannot finish within that grace, or a complete upgrade that exceeds 30 minutes,
requires a planned maintenance run and investigation before service admission.

Starting another old or new runtime while migration owns the database fails
closed. Existing Job, question, cancellation, steering, recovery, and hold rows
are never marked complete or resent to make startup succeed.

## Backup identity and retention

For a source schema `S`, the migration creates these mode-0600 files beside the
database:

```text
state.sqlite.pre-vS-to-v31.sqlite
state.sqlite.migration-vS-to-v31.backup.json
```

The JSON sidecar binds the snapshot to the logical and physical source database,
source/target schemas, exact migration path and checksums, source runtime when it
was recorded, target product/build and Settings schema, creation time, snapshot
SHA-256, integrity/foreign-key results, and a digest of every table's row count.
The sidecar itself is owner-only, bounded, and read without following symlinks.

After the source marker is durable, retry reuses and re-verifies that exact
snapshot. A missing, changed, wrong-schema, wrong-path, or other-database backup
is rejected. A different target product/build or Settings contract cannot resume
the pair; use the exact target artifact that created it. Startup does not replace
or delete a recovery point during the
rollback window. Backups contain the same private data as the live DB; keep them
on protected local storage and never attach them to CI logs, issues, or release
artifacts.

Retain the backup and sidecar until the candidate has passed migration, two
restarts, recovery rehearsal, and the operator's rollback window. Delete them
only as an explicit operator action after the upgraded service is accepted.
Record the deletion in the operational change log. If there is not enough space
to retain the original, stop; reducing the rollback window is not an automatic
fallback.

## Retired Decision data and backup disposal

Schema 27 removes `decision_cards`, `decision_card_versions`,
`decision_card_requests`, and `decision_submissions` in one forward migration.
The historical schema-24 migration and its recorded checksum stay unchanged,
so a schema-23 or schema-24 source still follows its original path before the
schema-27 deletion. No Decision row becomes a Codex question, answer, execution
request, or approval. The migration does not change `user_questions` or
`codex_question_deliveries`.

A pre-v27 source snapshot necessarily contains the original rows until the
rollback window ends. Never attach it or a row export to an issue or release.
After the upgraded service passes integrity and foreign-key checks, two
restarts, and an accepted recovery rehearsal, stop the bridge and inspect all
operator-managed `state.sqlite` snapshots and migration backups. Create and
verify one fresh, owner-only schema-27 backup for continued recovery. Checkpoint
and truncate the live WAL, run an offline `VACUUM`, and verify the live database
again. Delete each identified pre-v27 backup containing Decision tables and its
matching migration sidecar; retain unrelated backups without those tables.
Record the file paths, schema versions, table-presence results, and deletion
time in a private operational log, without recording submission contents.
External filesystem snapshots or separately managed backup services need their
own retention review. Recovery from a retained pre-v27 source is allowed only
through the schema-27 migration, which removes the tables again.

## Decide whether snapshot restore is allowed

Migration writes `state_service_opened_after_migration=0`. The HTTP runtime
changes it to `1` when its listening socket opens; stdio changes it immediately
before the MCP transport is attached so buffered request bytes cannot overtake
the marker. That is the supported rollback boundary because product work cannot
be admitted before it.

Stop every bridge/helper process, then inspect the exact pair:

```bash
node dist/stateRecovery.js inspect \
  --database /absolute/path/state.sqlite \
  --backup /absolute/path/state.sqlite.pre-v18-to-v31.sqlite
```

Inspection verifies the current target schema, service-open marker, live owners,
database identity, migration identity/path, backup checksum, table-count digest,
integrity, and foreign keys. `eligible: true` means the snapshot is structurally
eligible for the supported pre-service restore. It does not prove that the
operator still has the matching prior binary and configuration.

Snapshot restore is refused when the service opened, the boundary is unknown,
the database or backup identity differs, a live owner remains, or verification
fails. An unknown boundary is treated as post-open.

## Restore before service open

Identify the exact product version and build that owned the source DB. Use the
values recorded in the backup sidecar when present. Preserve the source
runtime's `.env`, Codex installation/login, and Settings contract as a single
rollback pair. Then run:

```bash
node dist/stateRecovery.js restore \
  --database /absolute/path/state.sqlite \
  --backup /absolute/path/state.sqlite.pre-v18-to-v31.sqlite \
  --source-product-version 0.3.0 \
  --source-build-id exact-recorded-build-id
```

Older source DBs may predate runtime identity recording. After independently
matching the held binary and configuration, add
`--acknowledge-unrecorded-source-runtime`. The flag records an operator
attestation; it does not infer provenance.

Restore verifies a temporary copy first, moves the current DB/WAL/SHM into an
owner-only `state.sqlite.recovery-<timestamp>` quarantine directory, atomically
places the original snapshot, verifies it again, and writes a private restore
receipt. Keep the quarantine until the prior runtime starts, passes health, and
reads the expected Settings, projects, retained history, and resumable sessions.
The receipt deliberately reports `serviceRestartVerified: false`; only the
subsequent runtime check can establish that fact.

Do not combine the restored main file with a newer WAL or SHM file. Do not open
the restored DB with the newer bridge before starting the source runtime, or it
will upgrade again.

## Recover after service open

Once service-open is recorded, an old snapshot can discard newly admitted Jobs,
answers, cancellations, steering certainty, request reservations, idempotency
receipts, recovery budgets, and result holds. The recovery command therefore
refuses snapshot rollback even if the snapshot itself is valid.

For a post-open failure:

1. Stop admission and every DB owner. Preserve a consistent copy of the current
   DB/WAL state and the original pre-upgrade snapshot.
2. Run integrity and foreign-key checks on disposable copies. Compare request
   receipts, terminal states, questions/answers, interactions, outbox rows,
   cancellation/steering records, recovery budgets, holds, and session execution
   contexts.
3. Prefer a fixed newer runtime. If data repair is necessary, write and review a
   forward, data-preserving procedure with explicit invariants and a new schema
   migration where the persisted meaning changes.
4. Start only after the repaired current state passes the same checks and no
   pending request can be replayed as new work.

Database restore does not undo files changed by Codex, spawned processes, remote
API calls, messages, or any other external effect. Never replay an old request
to make DB state appear complete.

## Settings, history, and intentional deletion

Schema migration and runtime retention are recorded separately:

- `schema_v19_removed_legacy_session_count` and
  `schema_v19_removed_legacy_agent_thread_count` are the schema-19 conversion's
  declared removal of invalid legacy project contexts. The migration never
  invents a project relationship from a slug, name, or folder.
- `state_startup_maintenance_last` records question expiry, old delivered
  question-journal removal, and crash-boundary dispatches changed to `uncertain`.
- `state_retention_last_run` records configured history retention and separate
  counts for events, result holds, work-history entries, recovery records, and
  incidents.

Schema 20 removes only the retired Activity/Job execution-mode columns and any
legacy `executionMode` payload member. Migration validation preserves Job request
hashes and terminal receipts, status/results/events, deduplication state, valid session
execution contexts, questions and answers, current interactions, undelivered
outbox records, cancellation records, uncertain steering delivery, recovery
attempt budgets, and result holds. Settings payload schema 2/3 values migrate
through schema 5, retired automatic model fallbacks are removed, project JSON is not
turned into a registry identity, and saved full-access intent remains subject to
the current operator sandbox ceiling.

Schema 21 adds live-card completion rows for newly terminal Jobs without
replaying older terminal Jobs. Schema 22 records whether a consumed completion
came from its receipt or an authenticated direct Job/request result read;
existing schema-21 `result-read` rows are backfilled as receipt consumption
without creating a new delivery.

Historical visibility and resumability are different results. A retained Job
may remain visible while a missing or retired backend session cannot continue or
fork. Recovery must not recreate or execute that context. Activity-only schema
and pending delivery removal remain governed by #53; any selected removal needs
a new catalogued migration and user transition before release.

Schema 23 to 24 adds only the historical independent Decision Card tables. It
does not backfill a card or submission from Jobs, Questions, Activities, or
completion delivery. The feature was retired in #141. Current runtimes keep
the migration but do not read, submit, recover, or prune Decision state. Older
runtimes marked unresolved leases `acceptance-unknown`; a current runtime does
not interpret them as execution or answer authority.

## Candidate evidence

Run the normal schema and lifecycle suites from a clean checkout. Release CI also
runs `scripts/state-release-audit.ts` against the unpacked npm tarball and the
mounted arm64 and x64 DMGs. The packaged code opens every supported source schema
3 through 24 directly, using the three exact source fixtures and the declared
derived checkpoints. Each job records the artifact checksum, commit/build, OS and
architecture, Node and module ABI, `better-sqlite3` and SQLite versions, catalog
digest, source fixture provenance, migration checkpoints, semantic counts, two
current restarts, actual backup restore, and the published v0.3.0 runtime start
after schema-3 restoration.

The reports contain counts and identifiers only, never user payload. They are
private CI evidence with 90-day retention and are not release assets. The npm
and both native reports must belong to the same final RC commit. Any payload or
migration change requires a new RC; stable promotion must reproduce the RC
payload under the existing normalized metadata exceptions. A deterministic hook
tests the committed-schema/pending-provenance interruption and resume path. The
audit records clean process shutdown separately; process termination and physical
power-loss behavior are not claimed without separate evidence.

The checked-in [issue 98 development artifact evidence](audits/issue-98-development-state-release.md)
covers a clean generic npm package and local arm64 DMG. Its development stage and
single native architecture do not satisfy the three-artifact final-RC gate.

See [database schema and lifecycle](database-schema.md) for table ownership and
[release governance](release-governance.md) for the candidate-to-stable gate.
