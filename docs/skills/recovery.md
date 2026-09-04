# Migration and recovery guide

Use a candidate database, validation report, consistent backup, and atomic active
pointer for import/restore/migration. Keep the original archive intact. Preserve
legacy IDs and relevant tombstones. Never create balance adjustments based on
legacy cached totals. Reject ambiguous revision chains and unsupported schemas.

`.duckit` exports contain versioned normalized data and checksums, without machine
credentials or activated remotes. GitHub recovery requires Dolt clone, not git clone.
Preserve both diverged histories and verify reviewed hashes before resolution.
