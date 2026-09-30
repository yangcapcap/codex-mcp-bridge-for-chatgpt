# CoGate source21 to the single upstream runtime

Status: implementation contract; source inspection and read-only preservation
ledger, schema31 storage, read-only target projection/initialization content verifiers
and a supplied-key conversion signature comparison are implemented;
conversion and actor/runtime integration are not. The operator command must remain unavailable
until all of this contract has independent exact-head review and validation.

The integration base is upstream dev 8b8d40a55a16f9d60ee0fb0397ac16a4e31ea239.
The earlier admission foundation was validated against dev5747072; its evidence
does not substitute for validation after this upstream refresh.
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
A present schema origin, receipt or gap must match its exact fixed record keys,
types and completed-generation relationships. A fresh source cannot carry orphan
completion identity. A fully authenticated completed historical path may lack an
origin that the old pre-contract runtime never recorded; the missing record stays
missing and supplies no proof. It must never be fabricated as a fresh origin.
Duplicate decoded root field names are rejected, including identical duplicates
and Unicode-escaped aliases. The source inspector cannot authenticate an earlier
conflicting raw value by accepting a later member with the same name.

The old 19->20 Workspace digest and 20->21 HMAC digest remain immutable. They
cannot be recorded as upstream 19->20 asynchronous-execution or 20->21 completion
delivery receipts. No old receipt, provenance gap, rollback record, retirement
plan, writer or UNKNOWN outcome is deleted or overwritten to admit the target.

The unified target adds an append-only upstream 30->31 storage migration. Schema31
adds Workspace/HMAC storage, retained execution-mode history, legacy provenance
storage and a separately typed conversion receipt. Existing upstream migrations
and their hashes remain unchanged. An ordinary upstream upgrade initializes disabled
Workspace control and empty security/conversion stores; it produces no legacy
conversion receipt or execution grant. Exact schema31 storage objects are verified
before startup writes, including all legacy safety triggers and archive guards.
All reserved object names are rejected on older source schemas regardless of
object kind or name casing. Archives reject existing-key INSERT/REPLACE/UPSERT
and UPDATE/DELETE; WITHOUT ROWID removes an alternative rowid conflict path. The conversion has its own named implementation
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
| Old jobs without authenticated MCP principals or followup grants | Preserve their history. Do not synthesize webhook registrations, event delivery acceptance, current principals or approved durable followups from legacy jobs. |
| Source model catalog and UI history | Preserve history; current dev remains authoritative for models, API, localization, cards and generation semantics. |
| Workspace control | Preserve revision history. Conversion cannot silently enable dispatch, clear maintenance or consume an onboarding authorization. |
| Preserved/quarantined/ready workspaces and writer locks | Preserve ownership and cleanup evidence. No forced release, fabricated terminal receipt or git deletion. |

For every shared table, validate exact column mappings, foreign keys, row counts,
and content digests using a private conversion ledger that never prints secrets.
Copy SQLite sequence high-water marks so future events cannot reuse historical
identities. Preserve opaque JSON payload bytes. Validate the two changed execution
tables, the added auth boundary and every new target table explicitly.

`inspectCoGateLegacyPreservation` authenticates the fixed source and binds all 42
tables and their columns in the same read-only SQLite snapshot. Its domain-separated
content digests include SQLite storage types, exact TEXT/BLOB bytes, exact 64-bit
integer values, row counts and sequence high-water marks; database encoding is also
bound. Physical insertion order does not change a table's digest. The ledger emits
no cell values or HMAC material and retains `authority: none`. It is private source
evidence for a future copy-to-target verifier, not a conversion receipt, backup seal,
claim of idle ownership, signing authority or readiness to apply.
Setup and rollback errors propagate without returning evidence. Cleanup always
attempts to restore the caller's original query-only setting, including a failure
before or during BEGIN and a failed ROLLBACK. If the physical rollback cannot run,
the caller retains the connection and its unresolved read transaction; no success
or transaction-exit claim is made. Caller-owned pre-existing transactions are
rejected before any setting is changed or rollback is attempted.

`inspectCoGateLegacyProjection` checks a caller-owned read-only target against
the exact 48-table schema31 object set and the fixed 42-table source ledger. It
reconstructs archived provenance and execution modes only for content comparison,
requires matching logical/conversion identities and encoding, verifies all source
content digests and sequence marks, and checks integrity and foreign keys. Added
session authentication boundaries must remain NULL, and new delivery/operational
receipts must remain empty. Extra job/activity rows and orphan archival rows fail
closed. Writable file handles and existing caller transactions are rejected.
The inspector returns hashes and counts, never raw cells or secrets.

Source and target inspectors pin schema, rows, metadata, archive and sequence
lookups to `main`. Legacy HMAC read queries also use that explicit namespace;
their cryptographic validation and recovery rules remain unchanged. Caller TEMP
objects are rejected within the snapshot, before authentication or hashing, to
prevent temporary tables/views from masking retained main data. Internal objects
are filtered using the literal `sqlite_` prefix: a SQL LIKE wildcard must not hide
user objects named `sqliteX...`. Schema31 storage preflight applies the same
literal rule to its protected object set, before any startup write.

This verifier supplies content evidence with `authority: none`. The typed archive
binding is not authentication of external approval, a maintenance owner, backup,
candidate or implementation. New target-model state and active upstream provenance
initialization are explicitly not verified here. These require separate reviewed
initialization and operator checks before the converter can become callable. The
synthetic test copier is confined to test helpers and arbitrary fixture hashes
cannot supply any real approval. No runtime apply command or production converter
is introduced by this inspection module.

## Apply transaction and recovery

`inspectCoGateConversionApproval` performs only a read-only cryptographic
comparison. It requires a domain-separated Ed25519 signature, canonical DER key
fingerprint, strict UTF-8/Unicode and unique decoded fields at every object level,
an exact approval envelope/body shape, reviewed/expiry timestamps, and all expected
conversion/database/profile/schema, candidate, preservation, projection-plan,
implementation, backup, workflow, control, rollback and maintenance-owner digests.
Each digest must match the supplied expected binding. Approval lifetime is at most
24 hours; future reviews, expired approvals and noncanonical timestamps fail closed.
Canonical SPKI does not prove a secure Ed25519 point. The supplied raw public key
must also decode under strict RFC8032 point rules, round-trip canonically, be
nonidentity, have no small-order component and belong to the prime-order subgroup.
These checks use pinned `@noble/curves` 2.3.0 before platform signature verification;
the inspected coordinates are public and no private scalar is processed. A weak
identity authority is rejected even if the platform accepts its fixed signature.
Its canonical envelope hash is a content binding, not a claim of receipt-file
identity. The module has no file, database, process or operator action.

The result explicitly says `matched-supplied-key` and
`matched-supplied-expectations`, with `authority: none`. It does not authenticate
the external origin of that key or measure any live owner, backup, candidate,
workflow or control. Synthetic test signatures prove none of those facts. A future
operator must read its independently pinned authority from authenticated private
ceremony evidence and supply freshly measured bindings; these trust-source and
live preflight checks remain unimplemented. The comparison alone must never enable
conversion, promotion, maintenance, shutdown or target startup.

Point decoding follows [RFC8032 section 5.1.3](https://www.rfc-editor.org/rfc/rfc8032.html#section-5.1.3).
The explicit prime-subgroup and identity policy is stricter than a DER type check;
see the library's [point API](https://github.com/paulmillr/noble-curves/tree/2.3.0#internals).

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

## Target initialization content contract

`inspectCoGateTargetInitialization()` uses the same read-only transaction as the
42-table projection check. It additionally compares the complete
`model_description_versions` table with the published schema-26 backfill of
retained `user_settings.modelDescriptionOverrides`: nonempty text values become
version 1, with an unknown (`NULL`) save time. Catalog descriptions and invented
save/version history are rejected. Absent, null or empty overrides derive no
rows. Invalid JSON/Unicode, duplicate top-level settings keys, duplicate decoded
model keys and nonobject override containers cannot initialize a usable target;
the inspector never repairs or normalizes retained bytes.

The pre-service active provenance is a canonical `state_schema_origin` JSON
object, in this exact field order: `kind: "lineage-conversion"`,
`format: "cogate-unified-origin/v1"`, `sourceProfile`, `sourceSchema: 21`,
`targetSchema: 31`, `logicalDatabaseId`, `conversionId`,
`sourcePreservationSha256`, `recordedAt`. It must bind the same typed conversion
receipt and its canonical millisecond UTC timestamp. That receipt must also
carry the fixed projection-plan SHA. The only active provenance/target-only
keys are this origin, schema version 31, catalog version 1,
`cogate_lineage_conversion_v1` (the conversion ID),
`schema_v31_cogate_storage: "workspace-hmac-and-lineage-evidence-v1"` and
`schema_v31_migrated_at` (the receipt timestamp). Old provenance is retained in
the immutable archive and authenticated by the original ledger. A fresh-origin
claim, fabricated upstream migration receipt, pending/gap marker, runtime build
claim or service-start evidence conflicts with this pre-service contract.

The result says `targetInitializationVerification: "matched-content"` and
`authority: "none"`; approval and owner verification remain not performed.
This is an inspection of supplied content, not an authenticated converter,
initialization writer, live lease, trusted approval source, backup proof,
promotion operation or permission to launch. The existing projection-only
function retains its original `targetInitializationVerification: "not-performed"`
result. Neither function is connected to an operator or runtime activation path.

## Temporary ordinary runtime admission gate

Until the authenticated conversion/activation path and Workspace/HMAC actors are
implemented and independently reviewed, ordinary schema31 runtime startup only
admits the fixed empty CoGate extension with its original disabled control row.
Both read-only state-store startup and writable migration preflight reject any
retained Workspace/security/conversion rows, changed or absent control baseline,
conversion marker, conversion origin, or malformed origin. Content inspection
success does not grant runtime admission. There is no bypass flag or supplied
approval argument. Ordinary fresh upstream schema31 remains usable.

The guard reads the exact main-schema objects and all evidence within one SQLite
snapshot, retaining any caller-owned transaction and rolling back only a snapshot
it owns. Rejection precedes runtime owner/maintenance leases, status/backup writes
and business mutations. A read-only SQLite WAL connection can create an empty WAL
and coordination SHM sidecar; this is not a guarantee of zero filesystem I/O.
Retained database bytes and historical evidence are not repaired or erased.
