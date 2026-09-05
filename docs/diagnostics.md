# Read-only diagnostics

Run diagnostics from the development source directory with Node 24. The command
requires an explicit absolute application-data root, so it never selects a real
budget by default:

```sh
npm run diagnostics -- --root="$HOME/Library/Application Support/Duckit Development"
npm run diagnostics -- --root="$HOME/Library/Application Support/Duckit Demo" --table=transactions
```

Use a root created by a synthetic test when investigating tests. Production storage
is `~/Library/Application Support/Duckit`; inspect it only when that is your intended
target. Quit Duckit before collecting a consistent diagnostic report.

The JSON report includes bundled runtime versions, whether an active budget exists,
schema version, application revision, currency, and row counts for recognized
tables. `--table=<name>` limits the count to one recognized table and includes its
column definitions. It does not print account names, payees, transaction memos,
amounts, credentials, or arbitrary rows. There is no SQL argument and no write,
repair, checkpoint, restore, or remote synchronization mode.

By default the command uses `resources/runtime/<current architecture>`. To inspect
with an installed application's own runtime, supply its directory explicitly:

```sh
npm run diagnostics -- \
  --root="$HOME/Library/Application Support/Duckit" \
  --runtime="/Applications/Duckit.app/Contents/Resources/runtime" \
  --table=accounts
```

Recognized tables are `budget_meta`, `budget_months`, `accounts`, `category_groups`,
`categories`, `payees`, `transactions`, `splits`, `allocations`, `schedules`,
`reconciliations`, `reconciliation_items`, `provenance`, `tombstones`,
`command_receipts`, `undo_history`, and `write_guard`. The command refuses unknown
table names and prints only tables present in the selected database.

The tool creates and deletes its own temporary runtime configuration. Budget access
uses SELECT/SHOW statements with automatic Dolt garbage collection disabled. It
does not migrate an older schema. An invalid active pointer or unavailable runtime
causes a visible failure while leaving the original budget in place.

Reports still reveal local paths and the size of a budget. Keep reports from real
budgets private; use synthetic reports and fixtures in public issues or CI.
