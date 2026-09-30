# Release governance

This repository has one product release unit: `codex-mcp-bridge`. The native
macOS app and the generic npm server archive are two distributions of that one
product. They never receive independent product versions.

## Version authorities and independent axes

| Classification | Authority or mirror | Meaning |
| --- | --- | --- |
| Product SemVer authority | `package.json#/version` | The one product version |
| Release-stage authority | `release-manifest.json#/release/stage` | `development`, `candidate`, `stable`, or `deprecated` |
| Release-unit authority | `release-manifest.json#/release/releaseUnitId` | Always `codex-mcp-bridge` |
| Product-version mirrors | root versions in `package-lock.json`, `release.version`, `.codex-plugin/plugin.json#/version`, `CFBundleShortVersionString`, tag and asset names | Must match the product authority |
| Derived publication channel | `release.channel` | `none`, `prerelease`, or `stable`, fixed by the stage |
| Candidate provenance | `release.sourceVersion` | Suffix-free development version from which the target bump was calculated |
| Stable provenance | `release.sourceCandidate` | Exact last `X.Y.Z-rc.N` used for stable promotion |
| Build identity | `CFBundleVersion`, `dist/build-info.json` commit/time/source hash | Identifies a build, not the product version |
| Manifest schema | `manifestVersion` (currently 6) | Release metadata plus state and UI compatibility contracts |
| UI resource policy | `ui-release-catalog.json`, its manifest digest, generated release inventory, UI contract generations and explicit URI versions | One current file per active card; compatible updates keep the URI, independent of SemVer |
| State compatibility | `stateCompatibility` plus `state-migrations.json` (currently source schemas 3–30 to 31) | Local data, applied-migration provenance, state-profile, backup, and recovery axes; see the [state upgrade and recovery runbook](state-upgrade-recovery.md) |
| Tool/runtime contracts | Task input contract 6, helper protocol 2, local companion protocol 10, remote companion protocol 8, execution-policy references, App Server schema lock and pinned Codex CLI | Independent protocol and state axes |
| Runtime state | `.env`, authentication material, SQLite data, process locks | Never a version authority or release payload |

`npm run release:check` checks the version mirrors, generated plugin and UI
metadata, manifest schema, state contract/runtime constants, migration and fixture
checksums, release stage, branch combination, and active change fragments in one
entry point. `npm run release:sync` repairs derived metadata. It refuses to change
or remove an existing migration, fixture, or checkpoint record; a changed deployed
transformation requires a new schema step. The command does not choose a stage or
grant publication authority.

## Database candidate boundary

Stable uses `~/.codex-mcp-bridge/state.sqlite`; candidate and development builds
default to their own profile paths. A candidate can touch operational state only
through an explicit stable-profile or absolute-file selection after every owner
has stopped and the preflight succeeds.

The candidate workflow runs the state release audit in the unpacked npm tarball
and in each mounted arm64/x64 DMG runtime. Each report binds its artifact checksum,
commit/build, OS/architecture, Node ABI, `better-sqlite3` and SQLite versions,
migration-catalog digest, source fixture, migration/restart results, verified
backup restore, and prior v0.3 runtime execution. Reports contain no user payload
and are retained as private workflow evidence for 90 days. All three must belong
to the same final RC. See the [runbook](state-upgrade-recovery.md) for the exact
pre-service restore and post-service forward-repair boundary.

## Card resource gate at release boundaries

The [UI card release policy](ui-release-compatibility.md) requires one current
file for each active card: Settings and Dashboard. Compatible card and metadata
updates overwrite those files while preserving their explicit URI versions.
The catalog has no published baseline or temporary compatibility selection.

Finalize card contracts before the final RC. Increment only the affected
card's URI version when a cached card cannot safely use the new server contract,
then refresh connector discovery and reopen both cards. Activity and Question
presentation resources remain retired while their durable state and execution
logic remain available through current contracts.

## Stage and branch lifecycle

```text
ordinary work -> dev -> release/X.Y.Z -> main
```

| Stage | Allowed publication branch | Version form | Publication |
| --- | --- | --- | --- |
| `development` | `dev` and ordinary work branches | `X.Y.Z` | none |
| `candidate` | matching `release/X.Y.Z` | `X.Y.Z-rc.N` | GitHub prerelease |
| `stable` | prepared on matching release branch, published from `main` | `X.Y.Z` | GitHub release |
| `deprecated` | historical record only | `X.Y.Z` | forbidden |

`main` accepts only a suffix-free stable state. A release branch can contain a
candidate and then its stable-promotion commit, but manual publication accepts
only the candidate state. Other branches cannot carry candidate or stable
state. Existing tags, releases, and assets are immutable and are never replaced.

## Change fragments and version selection

Release-relevant work adds one repository-owned `.changes/*.json` fragment.
The schema is documented in `.changes/README.md` and enforced without a third-
party tool. The highest requested bump wins; no fragments means PATCH. During
`0.x`, compatible fixes are PATCH and features or structural changes are MINOR.
A breaking `0.x` fragment requires at least MINOR, a `BREAKING:` summary, and a
migration instruction. At `1.x` and later, a breaking fragment requires MAJOR.

Inspect the non-mutating plan on `dev`:

```bash
npm run release:plan
```

Use the command's reported branch and candidate version as the authority for
the next release. The plan does not change the version, create a branch,
publish a tag, or publish a release.

After creating and switching to the exact planned branch, prepare metadata:

```bash
npm run release:prepare-candidate
```

Open one draft pull request from that same-repository `release/X.Y.Z` branch to
`main`. While the manifest is `candidate`, the pull request runs the complete
read-only release validation. Its required **Stable promotion gate** succeeds only
while the candidate PR remains draft; the draft state is the merge hold. Marking a
candidate PR ready before stable promotion makes the gate fail.

## Non-publishing rehearsal and RC identity

The first public RC must not be the first end-to-end exercise of the release
path. Before dispatching the manual publication workflow, use the exact draft-PR
candidate commit and its retained artifacts for a non-publishing rehearsal. In a
clean temporary worktree, project that candidate to stable with
`release:promote`, run `validate:stable`, rebuild and compare the npm archive,
promote and compare both candidate DMGs, and verify the five-asset assembly. The
rehearsal creates no tag or GitHub release. Record the candidate commit, PR run,
release-workflow commit, input artifact checksums, and comparison results. The
physical candidate checks remain separate required evidence.

An `X.Y.Z-rc.N` identifier is provisional until its GitHub prerelease exists. A
defect found during the rehearsal may be fixed on the same unpublished `rc.N`;
commit the fix and rerun every required check at the new exact head. Earlier
runs and artifacts remain evidence only for their old commits. Do not run
`release:next-rc` merely because an unpublished rehearsal failed.

Publication freezes the RC identifier, tag, commit, release notes, and assets.
After that point, use the following decision boundary:

| Change after a public RC | Required action |
| --- | --- |
| Transient runner or network failure with the same commit and inputs | Rerun the exact commit and keep the RC |
| Product code, UI, runtime dependency, manifest, shipped documentation, build input, or any other published payload change | Fix on the release branch and publish the next RC |
| Packaging, candidate-promotion, payload-normalization, signing, asset-assembly, or publication-authority workflow change | Publish the next RC, even if one sampled payload still compares equal |
| Validation-only change excluded from every public artifact and unable to affect the dependency graph, build plan, package construction, promotion, or authority boundary | The stable-promotion head may retain the public source RC only after full exact-head validation and all payload comparisons pass |
| Unclassified or uncertain change | Keep the release on `HOLD` and publish the next RC |

A path or filename is not proof that a change is validation-only. Tests can
participate in a build graph, and repository documentation is shipped in the npm
archive. If the actual candidate and stable artifacts differ outside the
enumerated normalization boundary, the validation-only exception does not
apply. The release PR must state which rule was used and link its evidence.

Use the next RC only after a public candidate is frozen and a new candidate is
required:

```bash
npm run release:next-rc
```

After the last RC passes all gates, remove only its RC suffix, record that RC,
and consume its active fragments:

```bash
npm run release:promote
```

The same pull request then reruns in `stable` mode. The npm distribution is
rebuilt and compared with the latest published source RC. Each stable macOS DMG
is produced from the corresponding published candidate app by replacing only
the enumerated version and build metadata, then re-signing and repackaging it.
The strict payload comparison still covers executable code, symbols, data,
runtime files and permissions; it normalizes only signature data and the
page-rounded Mach-O `__LINKEDIT` allocation left by re-signing. The required
gate passes only after every read-only job succeeds. Merge that exact promotion
into `main` for the stable publication. After the stable state is merged back to
`dev`, restore the non-publishing stage without changing the product number:

```bash
npm run release:development
```

None of these local metadata commands publishes a tag or GitHub release.

## Validation ladder

| Level | Command or evidence | Scope |
| --- | --- | --- |
| Fast | `npm run validate:fast` | manifest/mirror/UI drift, fragments, App Server schema lock |
| Affected | `npm run validate:affected` | fast checks plus Node and/or Swift checks selected from changed paths |
| Full integration | `npm run validate:full` | full Node build/tests, exact App Server schema, full Swift tests |
| Candidate | `npm run validate:candidate`, the read-only release PR, plus the manual release workflow | clean installs, all five assets, npm archive, both app/DMG structures, architectures, ad-hoc signatures, checksums, and three artifact-bound state migration/restore reports |
| Stable promotion | `npm run validate:stable`, the required Stable promotion gate, the main release workflow, and physical-Mac evidence | latest source RC, normalized payload equivalence, exact stage/tag, installation readiness |

A successful result applies only to the exact commit and inputs that produced
it. An unexplained difference, absent source candidate, missing asset, failed
physical-Mac check, or ambiguous evidence leaves the release on `HOLD`.

Affected validation compares committed changes with `origin/dev` and also checks
staged, unstaged, and untracked paths. Deletions and both sides of renames count;
moving source into documentation still requires the source checks. If the base
is unavailable, fetch it or pass `npm run validate:affected -- --base <git-ref>`.
An unresolved base is an error, not evidence that committed code is unchanged.

## RC-to-stable payload boundary

Stable publication downloads the three actual source-RC payload artifacts and
compares them with the newly built stable artifacts. The npm archive and both DMGs are
unpacked. Version strings, release stage/channel/provenance, build identity,
`CFBundleVersion`, `CFBundleShortVersionString`, ad-hoc signatures, and DMG
container details are the enumerated normalization boundary.

Everything else participates in a sorted SHA-256 tree digest, including file
paths, modes, symlinks, JavaScript, the native executable, UI resources, public
contracts, `release-manifest.json`, `state-migrations.json`, migration/recovery
code, runtime scripts, and production dependencies. Any unclassified
difference stops stable publication and requires another RC. The four payload
files receive entries in the aggregate checksum; payload evidence is workflow
evidence and does not add a sixth public asset.

## GitHub Actions authority

The release workflow has three entry points with separate authority:

- a `pull_request` targeting `main`, accepted only when its head is a
  same-repository `release/X.Y.Z` branch whose manifest is `candidate` or
  `stable`; this path is read-only and never publishes;
- `workflow_dispatch` on an exact `release/X.Y.Z` ref whose manifest is
  `candidate` and whose version is `X.Y.Z-rc.N`;
- a push to `main` whose manifest is `stable`, suffix-free, and names its exact
  source candidate.

Pushes to `dev`, pushes to release branches, and ordinary pull requests to
`dev` do not run this workflow. A non-release pull request targeting `main` is
rejected by the first policy job. The policy validates the event, same-repository
head, base, stage, branch, and version before installing dependencies or
building. Candidate PRs expose successful read-only validation only while they
remain draft; converting one to ready before stable promotion makes the required
Stable promotion gate fail. Stable PRs additionally require the latest existing
GitHub prerelease for `sourceCandidate` and compare both npm and macOS payloads
before the gate passes. Only manual candidate and `main` push runs receive
publication authority. The publisher rejects
repository mismatches, conflicting tags, duplicate releases, missing declared
assets, and extra undeclared assets.

The public asset set remains exactly:

```text
Codex-MCP-Bridge-for-ChatGPT-<version>-macOS-arm64-unnotarized.dmg
Codex-MCP-Bridge-for-ChatGPT-<version>-macOS-x64-unnotarized.dmg
codex-mcp-bridge-for-chatgpt-<version>.tgz
codex-mcp-bridge-for-chatgpt-<version>.tgz.sha256
SHA256SUMS.txt
```

The macOS app remains ad-hoc signed and unnotarized. No Apple developer account,
Developer ID, notarization secret, non-macOS app, installer, wrapper, or skills
archive is introduced by this policy. The generic npm server remains available
for users who want to run the server directly.

## Remote protection and promotion hold

The intended remote boundary is: `dev` is the default branch; `dev` and `main`
reject force-push and deletion; `main` requires a pull request and the strict
**Stable promotion gate** status check; release branches reject force-push but
remain deletable because they are short-lived. These settings are defined in
`.github/rulesets/`. Version-tag rules permit a new `v*` tag but reject moving
or deleting an existing one. Apply the workflow before activating the required
remote status context, then verify the remote settings separately. Remote
protection does not replace the repository-local checks.

No candidate should be published until the physical clean-Mac install,
upgrade, quit/process cleanup, `.env`, and state-preservation checks are recorded.
No stable release should be published until its source RC passes those gates.
