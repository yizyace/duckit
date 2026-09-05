# Capability status

Duckit implements the Classic budgeting, register, import and recovery workflows
below. Public verification uses synthetic data; private migration evidence stays
outside this repository. The original application's historical display totals are
not a verified oracle.

| Capability               | Verified behavior                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop boundary         | Sandboxed Electron renderer, named validated IPC, isolated development/demo/test roots                                                                     |
| Exact-money engine       | Income timing, inherited negative carryover, Classic debt categories, splits/transfers, future allocations and historical recomputation                    |
| Persistence              | Normalized Dolt tables, entered split ordering, revision guards, retry receipts, undo/redo and durable writes before checkpoints                           |
| Register                 | Account/payee entry, search, bulk edits, cleared/reconciled distinctions, mixed transfers and paired recurrence                                            |
| Budget and reports       | One to three visible months, category and carryover editing, historical income/spending/net-worth reports                                                  |
| Legacy reconstruction    | Canonical generation, dominant full snapshot, causal incremental replay, preserved month identities and private independent oracle workflow                |
| Bank statements          | CSV and OFX/QFX, declared encoding, exact amounts, account-scoped bank IDs, explicit uncertain matches and preview cancellation                            |
| Archives and backups     | Checksummed Duckit archives, native verified backups, retention union, separate restore candidates and failure-boundary tests                              |
| Optional synchronization | Private repository identity checks, native clone recovery, fast-forward integration, complete two-parent conflict choices and cancellation                 |
| Accessibility            | Automated light/dark/modal checks and keyboard/focus tests; auditory VoiceOver testing remains unverified                                                  |
| Packaged runtime         | Unsigned Apple Silicon launch and Intel launch under Rosetta with bundled tools; native Intel hardware and fresh-Mac Gatekeeper behavior remain unverified |

The integrated release gate includes the final rebuilt application, original-archive
reconciliation, representative desktop workflows, backup restore and a fresh native
Dolt clone of the private budget remote. Do not equate isolated module tests with
completion of that gate. Browser credential connection and actual remote transport
are recorded separately from synthetic network tests.

Run `npm run check`, `npm run test:e2e`, and the packaged smoke commands in
[installation](install.md). [Runtime notes](runtime.md), [statement imports](statements.md),
[synchronization](sync.md), and [diagnostics](diagnostics.md) describe behavior and
practical limits. No background helper runs after the application exits.
