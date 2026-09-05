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

The 0.1.0 integrated release gate passed with the rebuilt packaged application:
authorized original-archive activation, representative budgeting and register edits
with undo, historical reports, backup restoration, portable export parity, and a
fresh native Dolt clone of the private budget remote. A separately implemented oracle
reconstructed the original archive and matched every account, category-month and
monthly calculation. The original archive remained unchanged. Private evidence is
retained outside this repository; this establishes ledger correctness, without
claiming historical display parity with the original application.

The source passed 103 unit/integration tests and 12 real Electron tests locally and
in GitHub CI. Both packaged architectures passed launch and recovery checks with
developer tools absent from the application's PATH. Actual GitHub HTTPS transport
and reuse of existing Keychain credentials through bundled GCM passed separately
from synthetic network tests. A fresh browser credential grant, a fresh Mac,
native Intel hardware and auditory VoiceOver testing remain unverified.

Run `npm run check`, `npm run test:e2e`, and the packaged smoke commands in
[installation](install.md). [Runtime notes](runtime.md), [statement imports](statements.md),
[synchronization](sync.md), and [diagnostics](diagnostics.md) describe behavior and
practical limits. No background helper runs after the application exits.
