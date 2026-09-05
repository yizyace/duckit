# Portable runtime and transport gate

Duckit bundles pinned Dolt, GitHub Desktop's portable Git, Git Credential Manager (GCM), and Git LFS distributions for each macOS architecture. GCM and Git LFS are upgraded from their official archives within the portable Git tree. Runtime preparation is a developer/build operation; installed applications must use the bundled paths through Electron main.

| Component              | Pinned release         | License material                                                                                |
| ---------------------- | ---------------------- | ----------------------------------------------------------------------------------------------- |
| Dolt                   | 2.3.2                  | Upstream archive's complete `LICENSES`                                                          |
| Git / dugite-native    | Git 2.53.0 / v2.53.0-4 | GPL copying terms, dugite license, corresponding Git source and build toolchain source archives |
| Git Credential Manager | 2.9.1                  | MIT license and upstream `NOTICE`                                                               |
| Git LFS                | 3.8.0                  | MIT license                                                                                     |

The committed `resources/runtime-manifest.json` pins URLs and SHA-256 digests. Binary digests came from the publisher's GitHub release assets; Git/dugite source and notice digests were independently downloaded and pinned. The Git source tag resolves to the same `67ad42147a7acc2af6074753ebd03d904476118f` submodule commit used by this dugite release. Keep source archives and notices in distributed application resources.

## Prepare and verify

Use Node 24 and the committed npm lockfile:

```sh
npm ci
npm run runtime:fetch
npm run test:transport
npx vitest run tests/runtime.test.ts
```

`npm run test:transport` selects the current Node architecture; run it with native
Node on the matching Mac. Run the Intel transport proof on a native Intel Mac. Avoid
requesting `--arch=x64` on Apple Silicon: the standalone proof does not have the
packaged smoke test's prelaunch host guard.

`node scripts/runtime-fetch.ts arm64` prepares just one architecture. With no arguments, both architectures are downloaded. Preparation verifies checksums before extraction, rejects unsafe archive paths and escaping symlinks, builds a candidate directory, and only then replaces the previous bundle. A failed download or extraction keeps the existing bundle. A corrupt cached download fails visibly; remove that digest's file under `resources/runtime/.downloads` before retrying.

The portable Git release remains v2.53.0-4; its Git tools, configuration, templates,
symlinks and matching source archives are retained. The build overlays the complete
GCM 2.9.1 runtime, including .NET libraries, from an independently pinned archive.
Its file inventory matches the GCM 2.9.0 payload in this dugite release. An unexpected
path, missing dependency, or changed inventory fails preparation before promotion;
review the replacement scope when a later GCM version changes that layout. Only the
`git-lfs` executable is copied from the official LFS ZIP. Upstream installer and
uninstaller scripts are never run. License and notice URLs follow the upgraded
component versions.

Git LFS 3.8.0 requires macOS 13 or later, matching the application's existing
Electron 44 deployment minimum. Git itself remains the latest available stable
portable dugite build; Duckit does not maintain a custom Git build.

Archives, expanded binaries, credentials and synthetic proof databases are excluded from Git. Packaging reads `resources/runtime/<arch>` and installs it as `process.resourcesPath/runtime`:

```text
runtime/
  dolt/bin/dolt
  git/bin/git
  git/libexec/git-core/git-credential-manager
  git/libexec/git-core/...
  git/share/git-core/templates/...
  licenses/...
  manifest.json
```

Runtime preparation recursively reads Mach-O architecture declarations before
promoting the candidate. Every native binary must support the requested architecture,
and the required Dolt/Git/GCM/LFS helpers must exist as compatible native code.
Package smoke repeats the recursive check over the complete Electron app before
launching it and requires a native host, Node and app. Intel package execution under
Rosetta is rejected by this gate; use the [native Intel CI runner](ci.md) instead.

Keep the entire Git tree: its helper programs, symlinks and GCM runtime are required. Set `GIT_EXEC_PATH` to `git/libexec/git-core` and `GIT_TEMPLATE_DIR` to `git/share/git-core/templates`. Put the bundled `git/bin`, `git/libexec/git-core` and `dolt/bin` first on the subprocess `PATH`; the remaining `/usr/bin` and `/bin` entries provide macOS utilities such as SSH. The proof clears inherited Git repository/configuration variables and retains `SSH_AUTH_SOCK` for existing credentials.

Set `DOLT_ROOT_PATH` to isolated application state and `DOLT_DISABLE_EVENT_FLUSH=1` for every invocation. Before using Dolt, set `metrics.disabled=true` and `versioncheck.disabled=true` in that private root with `dolt config --global --add`. This disables Dolt telemetry and version network requests. These commands must never target the user's shared Dolt configuration. Synthetic proof roots live in unique OS temporary directories and use the same isolation.

## What the proof checks

The synthetic proof executes the bundled Dolt, Git and GCM version commands with developer binary paths removed. It initializes a temporary Git seed branch, uses a local bare Git repository as a native Dolt remote, pushes to `refs/dolt/data`, and checks a fresh **Dolt** clone. Ordinary Git cloning is insufficient to restore a working budget database. Dolt requires an initialized Git remote with at least one branch. [Dolt remote documentation](https://www.dolthub.com/docs/sql-reference/version-control/remotes/)

For divergent snapshots the proof creates a shared base, conflicting account changes, independent category changes, inserted/deleted transactions, and tables that exist on only one side. It tests choosing either complete snapshot:

1. Start `dolt merge --no-ff --no-commit` on a candidate branch so both parents are recorded.
2. Clear row conflict metadata, then explicitly drop every table absent from the chosen snapshot.
3. Check out **every** table from the reviewed chosen revision. Conflict resolution alone would retain independent changes from the unwanted side.
4. Verify exact table/row equality, create a normal commit, and assert that its two parent hashes are the reviewed revisions.
5. Push and verify a fresh Dolt clone of each result.

This establishes complete domain table/row replacement and history preservation. The proof does not cover altered column/index definitions, foreign-key constraint ordering, schema compatibility enforcement, production stale-review races, or crash recovery. Production must validate both reviewed revisions and schema versions again before applying this procedure in a separate candidate database. The storage layer owns those checks.

## Optional private GitHub gate

This explicitly requested network QA mode uses the developer's authenticated `gh` CLI only to check repository identity and privacy; native transport still invokes the bundled Git with existing macOS SSH credentials:

```sh
node scripts/transport-proof.ts --github=OWNER/PRIVATE_REPOSITORY
```

The repository must already be private and have an initialized Git branch. The proof rechecks its immutable identity and privacy before upload. It writes synthetic state to a unique `refs/dolt/duckit-proof-<uuid>` ref, clones using `dolt clone --ref`, checks state equality, deletes its exact temporary ref, and verifies deletion. It never writes `refs/dolt/data` in the GitHub mode. GitHub may retain unreachable synthetic objects after deleting a ref. A cleanup failure reports the exact test ref requiring removal and preserves the original error.

## Recorded evidence and verification limits

On 2026-09-04, using macOS 26.5 on Apple Silicon:

- Both architecture archives and all notices/source archives passed pinned checksums and extraction validation.
- Apple Silicon Dolt 2.1.0, Git 2.53.0 and GCM 2.9.0 executed. `otool -L` inspection of Dolt, Git, HTTPS transport and GCM found only macOS system dynamic library paths.
- Apple Silicon and Intel binaries (Intel under Rosetta) passed native local Git push/fresh Dolt clone and both complete-snapshot merge choices, including two-parent checks and fresh clone parity.
- Apple Silicon native private GitHub push and fresh Dolt clone passed on a temporary synthetic ref, followed by verified ref removal. Private repository evidence is retained in private task tracking.
- Five focused unit tests cover checksum corruption, archive traversal, internal/external symlinks, dual architecture pins, and polluted subprocess environments.

Initial 0.1.0 release verification also passed packaged onboarding, exact saves, backup, clean exit,
reopen and restore on Apple Silicon and under Rosetta, with developer tools absent
from the application's PATH. Bundled GCM reused an existing Keychain credential for
authenticated HTTPS push and fresh native Dolt recovery. Production recovery and
schema compatibility have separate integration tests described in
[synchronization](sync.md) and [capabilities](capabilities.md).

The Dolt 2.3.2 / GCM 2.9.1 / Git LFS 3.8.0 upgrade was checked separately on
Apple Silicon. Both architecture bundles passed archive checksums and recursive
32-file native-code audits. Comparing the complete portable Git trees confirmed
that only reviewed GCM/LFS files changed; neighboring Git files, executable modes,
and symlinks were preserved. Thirteen focused runtime tests passed, including ZIP
traversal rejection and guarded helper replacement. New GCM credential storage was
exercised through bundled Git with an isolated synthetic store, without accessing
the user's Keychain or a remote.

A synthetic budget and native backup created with Dolt 2.1.0 opened under 2.3.2.
The production storage APIs saved exact large integer amounts, created a verified
backup before the checkpoint, reopened the budget, and restored both old/new
backups. All normalized fields matched while preserving transaction and schedule
split order; comparisons allowed only the deliberate revision increase on restore.
Twenty-nine focused persistence, recovery, service, and synchronization tests passed
with their existing deadlines. Native local Git push/fresh Dolt clone and both
complete-snapshot choices passed, including two-parent commits and fresh clone
parity. These local checks do not substitute for the combined dependency build's
native Intel CI and packaged smoke reports.

Current package validation requires native execution on the matching CI runner;
consult the release's smoke report for its hardware coverage. Fresh-Mac Gatekeeper
behavior and a fresh browser credential grant remain unverified. No signing identity
was available; the local builds are unsigned
and unnotarized. Source/binary acquisition does not sign or notarize a release.

Upstream references: [Dolt 2.3.2 assets](https://github.com/dolthub/dolt/releases/tag/v2.3.2), [portable Git release and checksums](https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4), [dugite macOS build](https://github.com/desktop/dugite-native/blob/4098283a7ecb8a227b9d43580336c78a06f90e5d/script/build-macos.sh), [GCM 2.9.1 release](https://github.com/git-ecosystem/git-credential-manager/releases/tag/v2.9.1), [Git LFS 3.8.0 release](https://github.com/git-lfs/git-lfs/releases/tag/v3.8.0), [GCM usage](https://github.com/git-ecosystem/git-credential-manager/blob/v2.9.1/docs/usage.md). GCM supports HTTP(S) credential flows; SSH uses macOS SSH and existing keys.
