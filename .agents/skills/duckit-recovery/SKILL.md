---
name: duckit-recovery
description: Implement or verify Duckit migration, portable archives, backups, restoration, and GitHub synchronization while preserving validated candidates and complete budget history.
---

# Duckit migration and recovery

Use a candidate database, validation report, consistent backup, and atomic active
pointer for import/restore/migration. Keep the original archive intact. Preserve
legacy IDs and relevant tombstones. Never create balance adjustments based on
legacy cached totals. Reject ambiguous revision chains and unsupported schemas.

`.duckit` exports contain versioned normalized data and checksums, without machine
credentials or activated remotes. GitHub recovery requires Dolt clone, not git clone.
Preserve both diverged histories and verify reviewed hashes before resolution.

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
