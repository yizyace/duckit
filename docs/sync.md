# Private native budget synchronization

`SyncManager` runs in Electron main. It connects an optional private GitHub repository to a budget, verifies native Dolt recovery, and keeps local saves independent from network status. It does not start a background helper or require a hosted Duckit account.

The service serializes `connect`, `sync`, `resolveConflict` and `disconnect` with edits through `Workspace.serial`; the manager never nests that lock. Open/focus/one-minute scheduling and the bounded quit attempt belong to the service. `cancel()` aborts API requests and kills sync process groups, including Git/Dolt helpers, when the quit deadline expires or a local save preempts background work. Sync database reads, checkpoints, validation, and its backup callback share that cancellation signal. Active database handles remain independent so cancelling synchronization cannot cancel a subsequent local save. Cancellation is terminal for that manager instance. The service waits for cancellation to settle before saving, then recreates the manager using the same binding. Conflicts are reconstructed from retained histories on the next sync. Cancellation checks before candidate activation keep unfinished incoming work separate from the active budget.

```ts
const sync = new SyncManager(
  workspace,
  (signal) => backups.snapshot(true, new Date(), new Set(), signal),
  (remote, message) => publish({ remote, message }),
)
```

## Connection and credentials

Settings first tries bundled GCM's noninteractive `get` and validates a cached token against GitHub's `/user` endpoint. A working credential is reused without opening another OAuth grant. If no credential is available, explicit Connect calls `github login --browser`. If GitHub returns 401 for a revoked token, explicit Connect adds GCM's documented `--force` flag to refresh it in the browser. Network failures and 403 responses preserve the existing credential and do not start browser sign-in or erase Keychain entries. Subsequent background work uses noninteractive `get`; expired or insufficient credentials produce a reconnect message while the budget stays local. Tokens stay in Keychain and main-process memory. The GitHub-scoped HTTPS authentication header is supplied only through each Git/Dolt subprocess environment. It is never written into Git configuration, budget tables, exports, status messages, renderer messages, or logs. Production has no dependency on `gh` or developer Git.

The manager validates repository privacy and immutable GitHub repository ID, creates a private repository if needed, and ensures a Git seed branch exists. A machine-local `sync.json` binds repository ID, repository name, native ref and budget ID. It contains no credential. The default native ref is `refs/dolt/data`; the Dolt budget branch is `main`. Changing an archive's data never activates a remote. Replacement import must call `disconnect()`, which removes only the local binding and retains all remote history.

An empty workspace can recover an existing repository by connecting and validating a fresh **Dolt** clone. A local budget cannot upload over a remote containing a different budget ID or unrelated history. Native Dolt history must be recovered using Dolt cloning; ordinary Git cloning does not produce a usable database. [Dolt remotes](https://www.dolthub.com/docs/sql-reference/version-control/remotes/)

## Saving, fast-forward and divergence

Each synchronization checkpoints durable local writes, rechecks repository identity/privacy, and observes the remote Git ref. Unchanged local and remote revisions require no push. Uploads are followed by a fresh Dolt clone and exact normalized budget/head verification; a changing remote during verification is retried on a later sync.

Incoming work happens in a separate database built with native Dolt backup/restore. A fast-forward is validated before atomic activation, with a local backup first. If incoming domain changes carry a non-increasing application revision, the candidate receives a higher revision so retained forms become stale. Normal monotonically increasing revisions do not create extra synchronization commits.

Divergence exposes independent copies of both complete budgets and their Dolt commit hashes. The original active database stays in place, and the candidate containing both histories is retained. Resolving a conflict:

1. Rechecks both reviewed hashes, the active budget binding, supported schema and repository privacy.
2. Copies the retained candidate, starts a normal uncommitted two-parent merge, and replaces every domain table from the chosen snapshot, including independently changed or deleted rows.
3. Keeps the union of command receipts from both histories, refusing contradictory reuse of a command ID. Selected undo history is retained but retired so undo cannot silently cross the integration boundary.
4. Advances the application revision beyond both snapshots, validates the whole candidate, and checks that the merge commit has exactly the two reviewed parents.
5. Backs up locally, rechecks the remote, pushes without force, verifies a fresh clone, and atomically activates the candidate.

If either reviewed revision changes, the user must review refreshed snapshots. Network, credential, validation, backup, or disk errors preserve the active budget and the reviewed histories. Disposable candidates are removed after operations. One divergence candidate is retained in private application data, with its UUID recorded in `sync-review.json` so manager restarts can retire it after a refreshed candidate is validated. Unchanged conflict checks reuse the same candidate. Successful synchronization or disconnection removes the retained review candidate; old active databases and remote commits are retained.

## Verification

```sh
npx vitest run tests/sync.test.ts tests/sync-io.test.ts
```

Tests use initialized local bare Git repositories with native Dolt `refs/dolt/data` transport and injected GitHub API/credential seams. They cover first push and fresh recovery, fast-forward and idle stability, both full-snapshot merge choices, independent deletions, two merge parents, receipt preservation, retired undo history, stale choices, privacy/identity/credential failures, unrelated budgets, unsupported schemas, credential redaction, and process-group cancellation. They contain only synthetic data.

Main-process test options can override the remote URL or use a unique `refs/dolt/duckit-proof-*` ref. Those options are not part of the renderer API. Real financial uploads require migration validation and authorized final activation.

Separate desktop acceptance passed existing Keychain credential reuse through bundled
GCM, authenticated GitHub HTTPS upload, and native Dolt recovery, without injected
credentials or simulated API responses. The packaged application also passed private
migration activation and connection. Evidence and financial data remain outside public
source. A fresh browser credential grant remains unverified; synthetic credential tests
cover the browser-flow invocation and expired-credential handling.

Primary references: [GCM usage](https://github.com/git-ecosystem/git-credential-manager/blob/v2.9.0/docs/usage.md), [GitHub repository creation](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user), [GitHub seed content API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents), [Git HTTP configuration](https://git-scm.com/docs/git-config).
