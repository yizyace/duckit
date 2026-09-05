---
name: duckit-recovery
description: Implement or verify Duckit migration, portable archives, backups, restoration, and GitHub synchronization while preserving validated candidates and complete budget history.
---

# Duckit migration and recovery

Use a candidate database, validation report, consistent backup, and atomic active
pointer for whole-budget import/restore/migration. Keep the original archive intact. Preserve
legacy IDs and relevant tombstones. Never create balance adjustments based on
legacy cached totals. Reject ambiguous revision chains and unsupported schemas.

Complete legacy parent arrays establish split order separately from current child revisions.
Changed-child-only arrays must not reorder unchanged splits; reject unresolved new
positions instead of guessing. Read the reconstruction compatibility rule and tests
before changing this behavior; it is not an upstream incremental-format specification.

Statement imports retain an immutable main-owned preview and enter the ordinary
undoable command path with provenance. Use the
[import boundaries](../../../docs/architecture.md#imports-and-recovery) and
[statement guide](../../../docs/statements.md); replacing a database would lose the
intended command history.

`.duckit` exports contain versioned normalized data and checksums, without machine
credentials or activated remotes. GitHub recovery requires Dolt clone, not git clone.
Preserve both diverged histories and verify reviewed hashes before resolution.
Sync cancellation must leave the active local database usable; carry abort signals
only on sync-owned handles/callbacks and create a new manager to resume. Local-save
success remains distinct from later checkpoint, backup or upload failure.

Use [semantic domain comparison](../../../src/main/storage/canonical-budget.ts) for
native budget snapshot equality and backup checksums. Only unordered collections may be sorted; posted
and scheduled splits remain ordered. A changed backup checksum encoding needs an
explicit version and a reader for existing snapshots.

- Legacy reconstruction starts in [YNAB import](../../../src/main/imports/ynab.ts),
  with [causal reconstruction](../../../src/main/imports/ynab-reconstruction.ts) and
  [normalization](../../../src/main/imports/ynab-normalize.ts).
- [Archives](../../../src/main/recovery/archive.ts) and
  [backups](../../../src/main/recovery/backups.ts) use
  [Workspace](../../../src/main/storage/workspace.ts) for candidate activation and
  [atomic-file operations](../../../src/main/storage/atomic-file.ts) for durable pointers.
- [SyncManager](../../../src/main/sync/manager.ts) owns remote integration. Read
  [synchronization behavior](../../../docs/sync.md) and
  [runtime notes](../../../docs/runtime.md) when changing transport or conflict handling.

Relevant regression evidence lives in [YNAB tests](../../../tests/ynab.test.ts),
[archive tests](../../../tests/recovery.test.ts), [backup tests](../../../tests/backups.test.ts),
[failure-boundary tests](../../../tests/recovery-boundaries.test.ts), and
[sync tests](../../../tests/sync.test.ts). Follow the
[QA skill](../duckit-qa/SKILL.md) for independent migration comparison and desktop
recovery checks; keep real-budget evidence outside public source and artifacts.
