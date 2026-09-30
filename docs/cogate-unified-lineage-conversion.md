# CoGate source21 to the single upstream runtime

Status: implementation contract; source inspection is implemented, conversion
and runtime integration are not. The operator command must remain unavailable
until all of this contract has independent exact-head review and validation.

The integration base is upstream dev 5747072d392769414fc7b82b0797b7417bdfeb71.
The user's architecture decision on 2026-10-01 is one upstream SDK2 runtime.
The legacy source profile is not a second executable runtime, launcher or SDK.

## Identities and immutable histories

The only admitted legacy source is
`cogate-v2-workspace-hmac/schema21/v1`, pinned to the schema object set and
migration catalog of CoGate source 128932cd9099e167da4fb588cb8a340903342426.
The source logical database ID must survive the conversion. A numeric schema
version is not enough to select a lineage. Its exact schema-object digest is
`cdebf3d1c707a0458d41cf5341a79f332fde2caf4a21d0cf60ccabd3098fe362`.
The read-only inspector authenticates every retained receipt, separate completed
source generations, any historical gap, and the original HMAC read semantics.
It emits `authority: none`; a successful inspection is not permission to apply.
Unfinished source migrations require recovery in the original source runtime.

The old 19->20 Workspace digest and 20->21 HMAC digest remain immutable. They
cannot be recorded as upstream 19->20 asynchronous-execution or 20->21 completion
delivery receipts. No old receipt, provenance gap, rollback record, retirement
plan, writer or UNKNOWN outcome is deleted or overwritten to admit the target.

The unified target needs a new append-only upstream 30->31 migration. Schema31
adds Workspace/HMAC storage, retained execution-mode history, legacy provenance
storage and a separately typed conversion receipt. Existing upstream migrations
and their hashes remain unchanged. The conversion has its own named implementation
digest and fixed source/target profiles; it is not an ordinary 21->22 migration.
Old provenance remains byte-for-byte in immutable archival rows before active
upstream provenance is established. The archive includes source schema-origin,
all migration receipts, original-source markers, gap, completion and service-open
metadata. Other metadata, including logical identity and security state, remains
in its original namespace unless an explicit field mapping is reviewed.

## Projection and preservation

| Source state | Unified projection |
| --- | --- |
| 10 Workspace/HMAC tables and their indexes/triggers | Retain all rows, keys, generations, aliases, lookup evidence, events, operation uncertainty and constraints. Preserve HMAC tombstones and append-only semantics. |
| `jobs.execution_mode`, `activities.execution_mode` | Archive each value with its original row identity and source conversion binding before removing the active projection. No historic foreground completion becomes a new delivery claim. |
| Old sessions without `auth_boundary` | Set the new field to NULL. Existing sessions require the upstream explicit identity boundary rules; never assign the currently signed-in identity retroactively. |
| Old terminal jobs and completion outbox | Preserve original summaries/events/outbox and UNKNOWN. Do not create accepted/host-observed completion-delivery receipts. |
| Source model catalog and UI history | Preserve history; current dev remains authoritative for models, API, localization, cards and generation semantics. |
| Workspace control | Preserve revision history. Conversion cannot silently enable dispatch, clear maintenance or consume an onboarding authorization. |
| Preserved/quarantined/ready workspaces and writer locks | Preserve ownership and cleanup evidence. No forced release, fabricated terminal receipt or git deletion. |

For every shared table, validate exact column mappings, foreign keys, row counts,
and content digests using a private conversion ledger that never prints secrets.
Copy SQLite sequence high-water marks so future events cannot reuse historical
identities. Preserve opaque JSON payload bytes. Validate the two changed execution
tables, the added auth boundary and every new target table explicitly.

## Apply transaction and recovery

Conversion is an explicit operator action, outside automatic startup. Before any
apply, authenticate the sealed candidate, signed external approval, fixed source
profile, logical database identity, target schema/implementation, workflow and
control digests, exact release payload and rollback candidate. A private source
inspection or old review PASS supplies none of this authority.

An owner-bound maintenance lease must exclude both old and new runtimes. Stop the
source through supported controls and verify actual child/group absence plus all
required bounded nonforcing worker receipts. No active bridge owner or nonterminal
job is admitted. Confirm the inspected source identity and control revision again
under exclusive ownership; file/alias replacement or receipt changes fail closed.
Do not mutate the source merely to make these checks pass.

Create and seal an owner-bound SQLite backup under the maintenance lease. Verify
the backup's source profile, all retained content and candidate binding. Convert
an owned copy with one SQLite transaction; never operate on production rows through
ad hoc SQL. The commit records all preservation bindings and a separate conversion
receipt atomically. Before commit, rollback leaves the source untouched. After
commit, recovery must inspect the typed conversion checkpoint and source/target
digests; it must not rerun destructive mapping or fabricate a new successful
receipt. Atomic promotion requires a durable intent journal and directory fsync.
On an interrupted promotion, the operator must prove which sealed source or target
owns the path before retry. Keep all backup/journal/evidence files.

A conversion receipt proves a data transition only. Target launch acceptance,
retirement-control live revalidation, real MCP tool acceptance and target project
admission each need fresh evidence. UNKNOWN remains UNKNOWN until measured.

## One runtime and shutdown behavior

Port Workspace policy and operator behavior through the new state/execution
service IPC, current authentication principal, SDK2 tool definitions and current
job envelopes. Do not carry the old CLI, server, MCP SDK1, card catalog, localization
or runtime process graph. All target actor writes require the same owner-bound
policy checks as old CoGate.

Explicit nonforcing shutdown must propagate through launcher, runtime process,
HTTP/stdio frontend, state/read/execution services, executor pool and JSON-RPC
children. Success requires real exit/group absence and validated worker receipts,
not merely a returned promise or frontend exit. Report actual survivors and fail
closed. The default force-recovery mode remains available and keeps its current
behavior; a nonforcing request cannot independently escalate at another layer.

Bootstrap rollback must use this exact legacy schema21 profile plus candidate,
database, native startup receipt and source lineage bindings. The target uses its
own current schema31 identity. Never weaken the normal current-schema bootstrap
check into acceptance of arbitrary supported schema numbers.

## Required independent proof

Tests must reject upstream schema21 under the old ID, changed schema objects or
HMAC evidence, malformed/extra/conflicting receipts, pending source upgrades,
wrong logical IDs, wrong candidate/signature/control bindings, live owners/jobs,
stale/replaced files and aliases, inadequate backup/capacity, and failures before
and after transaction commit and every promotion checkpoint. Byte-level source
and retained-history comparisons must cover real-shaped Workspace, security,
writer, gap and UNKNOWN fixtures. No production key material enters fixtures.

After all code and fixtures are committed, a new independent reviewer must audit
the final exact SHA. Run ordinary and host-exclusive full suites twice on that
same SHA, native Swift/localization checks, compatibility, port-stress and hermetic
release checks. Only then prepare a formal release candidate and request genuine
external signing authority for its concrete bound proposal. Installation,
cutover, externally verified cross-boot recovery and real read-only CoGate Job
plus disposable onboarding/restart/recovery remain subsequent measured gates.
