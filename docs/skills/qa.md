# QA guide

Pair financial changes with hand-computed examples: income timing, negative carry,
inheritance, debt, splits, transfers, historical edits and future allocations.
Mutation QA includes retry IDs, stale forms, failed writes and checkpoint crashes.
Recovery QA includes interrupted snapshots, backup retention and restore parity.
Import QA includes preview/cancellation, repeated legitimate purchases and bank IDs
scoped to accounts. Uncertain statement matches require explicit selection.

Use real Electron tests for keyboard, focus, labels and navigation. Inspect rendered
screenshots, run an accessibility audit, and launch packaged builds with a minimal
PATH. Public CI and artifacts contain only synthetic data. Private migration oracle
comparisons must be independent of the production calculator.
