# Architecture

Duckit is an offline Electron application with a pure budgeting engine and a local
Dolt database. This document maps the implementation and its invariants.
[Capability status](capabilities.md) records verified behavior and remaining limits;
[agent work](agent-work.md) covers ownership, commands, and evidence handoff.

## Module map

| Responsibility                                                          | Entry points                                                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Domain schemas, commands, API and result types                          | [shared/contracts.ts](../src/shared/contracts.ts)                                                                                    |
| Exact money, calendar rules and budget/report calculations              | [engine/](../src/engine/), especially `money.ts`, `calendar.ts`, `calculator.ts`                                                     |
| Domain mutations and invariants                                         | [changes.ts](../src/engine/changes.ts), [validation.ts](../src/engine/validation.ts), [transfers.ts](../src/engine/transfers.ts)     |
| Application lifecycle, validated IPC, dialogs and background scheduling | [main/index.ts](../src/main/index.ts), [preload/index.ts](../src/preload/index.ts)                                                   |
| Local commands, status and workspace activation                         | [service.ts](../src/main/service.ts), [workspace.ts](../src/main/storage/workspace.ts)                                               |
| SQL projection, revision guards, receipts and undo history              | [database.ts](../src/main/storage/database.ts), [schema.ts](../src/main/storage/schema.ts)                                           |
| Import reconstruction, parsing and statement commands                   | [imports/](../src/main/imports/), with [statement behavior](statements.md)                                                           |
| Portable archives, native backups and atomic files                      | [recovery/](../src/main/recovery/), [atomic-file.ts](../src/main/storage/atomic-file.ts)                                             |
| Remote integration and credential/transport boundary                    | [sync/manager.ts](../src/main/sync/manager.ts), [sync/io.ts](../src/main/sync/io.ts)                                                 |
| Renderer state, navigation and feature views                            | [App.tsx](../src/renderer/src/App.tsx), [Shell.tsx](../src/renderer/src/Shell.tsx), [views/](../src/renderer/src/views/)             |
| Reusable controls and themes                                            | [components/ui/](../src/renderer/src/components/ui/), [lib/](../src/renderer/src/lib/), [styles.css](../src/renderer/src/styles.css) |
| Build and bundled runtime                                               | [electron.vite.config.ts](../electron.vite.config.ts), [electron-builder.yml](../electron-builder.yml), [runtime notes](runtime.md)  |

## Data and process boundaries

`Budget` is the serializable domain snapshot. Money crosses API, archive and SQL
boundaries as canonical integer minor-unit strings; arithmetic uses `bigint`.
Calendar dates and months remain strings without timezone conversion. Currency is
metadata: relabeling it does not convert amounts. Sparse overspending overrides,
future month identities and Classic debt categories belong to the domain model;
the [budgeting skill](../.agents/skills/duckit-budgeting/SKILL.md) defines their rules.

Transactions contain ordered splits. Whole-transaction and split-level transfers
share balanced transfer identities across accounts. Editing one leg must retain
the counterpart's identity, metadata and unrelated splits. SQL persists split
positions; comparisons and migrations must preserve posted and scheduled split
order. Payee/account/category edits use stable IDs. Relevant deletions retain
tombstones and import provenance.

The renderer receives `DuckitAPI` through a sandboxed, context-isolated preload.
Main validates each operation's input, sender, main frame and URL. Native dialogs
choose filesystem targets; renderer inputs contain domain IDs and opaque preview
tokens, never arbitrary paths, SQL, commands or credentials. Permissions, new
windows and external renderer navigation are denied.

`App` holds the fetched `AppState` in TanStack Query and passes command handlers to
views. Form drafts stay in component state; stale failures refresh the snapshot
while preserving entered values for explicit review. Components reuse the pure
engine for calculations and validation. Main remains authoritative for writes.

## Local mutation and storage

1. Main preempts background sync, then `BudgetService.execute` enters
   `Workspace.serial`. Callers serialize sync/recovery operations through this same
   queue; methods already holding it must not enter it again.
2. A command UUID and fingerprint make retries idempotent. Reusing an ID for
   different edits is rejected. The expected application revision must match.
3. `applyChanges` builds and validates the next snapshot. `Database.save` commits
   domain changes, the receipt, undo history and the revision guard in one SQL
   transaction. Undo/redo are commands and advance the revision too.
4. A Dolt checkpoint follows the durable save. Checkpoint failure leaves the save
   intact and reports that history needs retrying. Local-save status and remote
   status are independent fields.

A native process failure after a write does not establish rollback. Main checks the
command receipt before reporting the outcome: a matching receipt confirms the
committed edit; a readable absent receipt confirms that command was not saved. If
the receipt cannot be read, the result explicitly remains unconfirmed. A same-ID
retry returns current state, clears an earlier local error and retries its
checkpoint without applying the command again. A refresh failure after confirmed
commit is reported as saved with an unavailable view, rather than as a failed save.

The selected application-data root contains `active.json`, `budgets/<uuid>/`,
`runtime-state/`, backup storage and machine-local preferences. `sync.json` binds an
optional remote identity to a budget; `sync-review.json` identifies a retained
conflict candidate. These files stay outside source control. Development, demo and
test roots are isolated as described in the
[development skill](../.agents/skills/duckit-development/SKILL.md).

Main invokes the bundled Dolt CLI for SQL and history operations; it does not rely
on a developer database server. [runtime.ts](../src/main/storage/runtime.ts) owns
subprocess environments, bounded execution and private Dolt configuration.
Unsupported schemas fail validation before writes or merges. New schema migration
work must include a backup, candidate validation and safe activation; do not infer
an automatic migration from the presence of a schema-version field.

## Imports and recovery

Whole-budget imports retain the parsed candidate in main while the renderer reviews
an `ImportPreview`. Activation checks the reviewed revision, backs up the current
budget, writes a separate database and atomically switches `active.json`. A
replacement import disconnects the old remote binding. Legacy reconstruction
selects canonical metadata and causally replays revisions; ambiguous chains fail.
Keep the source archive intact and validate ledger calculations independently of
the production calculator. Cached legacy balances never justify adjustments.

Statement imports follow a different persistence path: an immutable preview binds
the selected account, source digest and captured budget revision. Each uncertain
row requires an explicit match, separate-import or skip choice. Bank IDs are scoped
to the account. [imports/commands.ts](../src/main/imports/commands.ts) converts the
accepted result into ordinary changes, including provenance, so the entire import
can be undone without replacing database history.

Portable `.duckit` archives carry versioned normalized data and checksums, excluding
credentials and active remote bindings. Native backups are verified in temporary
locations before promotion. New backup metadata uses `checksumVersion: 2`: unordered
SQL collections and reconciliation membership are canonicalized, while posted and
scheduled split positions remain checksum-significant. Missing or explicit version
1 retains the historical checksum for restoration; that older checksum cannot
verify split order. Legacy metadata is never relabeled as version 2, and a legacy
snapshot cannot suppress creation of a newly verified version 2 snapshot. Unknown
checksum versions are not offered for restoration. Restore validates a separate database, advances the
application revision and retires undo history from the older snapshot before
activation. A failed backup must retain the last good snapshot. A failure after a
successful save or activation must be reported as such. Detailed rules and tests
are linked from the [recovery skill](../.agents/skills/duckit-recovery/SKILL.md).

## Synchronization and lifecycle

Sync supports sequential use across computers. Every upload rechecks remote
privacy and immutable repository identity. Fast-forward state is validated in a
candidate before activation. Divergence preserves both histories: review both
complete snapshots and their hashes, choose one full domain state, union compatible
command receipts, retire undo history and make a normal two-parent merge commit.
Recheck reviewed hashes before applying the choice and verify upload by fresh Dolt
clone. Ordinary Git clone cannot recover a working Dolt budget.

`SyncIO` owns credential access, API requests and transport process groups. Explicit
connection may invoke browser sign-in; background credential retrieval stays
noninteractive. Credentials remain in Keychain/main memory and transient subprocess
environments. Cancellation is terminal for a manager instance. Sync-specific
database handles and backup callbacks carry its abort signal; active local handles
must remain usable after cancellation. A resumed operation creates a new manager.

Main owns open/focus/minute sync scheduling, periodic backups, resume catch-up and
shutdown. Quit drains local work and bounds the remote attempt. No helper continues
after the application exits. See [synchronization](sync.md) for exact transport,
candidate-retention and conflict semantics.
