---
name: duckit-qa
description: Verify Duckit financial behavior, persistence, imports, recovery, and desktop interactions with synthetic tests, Electron interaction checks, and independent migration evidence.
---

# Duckit QA

Pair financial changes with hand-computed examples: income timing, negative carry,
inheritance, debt, splits, transfers, historical edits and future allocations.
Mutation QA includes retry IDs, stale forms, failed writes and checkpoint crashes.
Recovery QA includes interrupted snapshots, backup retention and restore parity.
Import QA includes preview/cancellation, repeated legitimate purchases and bank IDs
scoped to accounts. Uncertain statement matches require explicit selection.

- [Engine tests](../../../tests/engine.test.ts) cover financial scenarios;
  [service tests](../../../tests/service.test.ts) cover mutation behavior.
- [Statement tests](../../../tests/statement.test.ts) and
  [YNAB tests](../../../tests/ynab.test.ts) cover import behavior. Private migration
  oracle comparisons must be independent of the production calculator.
- [Recovery boundary tests](../../../tests/recovery-boundaries.test.ts) and
  [sync tests](../../../tests/sync.test.ts) exercise interruption and recovery.
  Run focused files with `npx vitest run` and their repository-relative paths.

Use [real Electron tests](../../../tests/e2e/) for requested workflows, keyboard
input and navigation. Inspect rendered screenshots for relevant product changes.
Follow the [owner's scope](../../../docs/development.md): do not perform VoiceOver
testing or accessibility work, or create acceptance gates for either.
`npm run test:e2e` builds before running these tests; after a current build,
`npx playwright test tests/e2e/recovery.spec.ts` targets the recovery flows.

Use the [development skill's storage isolation](../duckit-development/SKILL.md) for
unpackaged tests. For packaged launch verification, follow
[installation checks](../../../docs/install.md) and
[package-smoke](../../../scripts/package-smoke.ts): packaged builds ignore test-root
overrides, so the script verifies an isolated macOS home before opening the app and
uses a minimal `PATH`.

Public CI, fixtures, and artifacts contain only synthetic data. Record focused QA
and its limits; [capability status](../../../docs/capabilities.md) distinguishes
module checks from the integrated release gate. Follow
[contributor startup](../../../docs/development.md) for independent review before closure.
Use the [evidence handoff conventions](../../../docs/agent-work.md#keep-a-reviewable-handoff)
to identify the tested revision, artifact and execution architecture. Record local,
live CI and packaged results separately; a newly written workflow is still awaiting
run evidence.

Renderer navigation QA includes full account names and exact positive, negative,
zero and large working balances; future/scheduled exclusions, transfers, historical
edits, undo/redo and local date rollover. Exercise the sidebar at its minimum,
default, maximum and viewport cap, then reload and switch through the stacked
layout to check preference retention. Confirm resizing does not rescan the ledger.

Month chooser QA includes year edits and arrows, December/January transitions,
years 0001 and 9999, cancellation, one–three visible months, session view switching
and fresh-launch behavior. Reports retain reversed-range and 600-month validation.
Inspect light/dark synthetic screenshots at 960×640 and 1440×940 with open popovers,
dialogs and horizontally scrolled tables. Verify dialog actions remain reachable
by scrolling, and use a large synthetic ledger for responsiveness checks.

After `npm run build`, run these interactions and pure preference/balance checks:

```sh
npx playwright test tests/e2e/sidebar.spec.ts tests/e2e/month-navigation.spec.ts tests/e2e/budget.spec.ts
npx vitest run tests/sidebar.test.ts tests/budget-navigation.test.ts tests/renderer-model.test.ts
```

Use a distinct Playwright `--output=/tmp/duckit-<task>-qa` directory for concurrent
agents' sequential UI runs so one run cannot erase another's screenshots. The
20,000-entry sidebar test isolates renderer work using synthetic read-only IPC;
it does not measure database throughput.

Account-order QA covers upward/downward drops, rejected cross-section drops,
selection retention, failed/stale saves, undo/redo and reopening after clearing local
preferences. Verify explicit positions in native storage, archives, backups and a
fresh sync clone; legacy migration must preserve its source and checksum evidence.
Activity QA observes real save events plus synthetic fast sync/refresh outcomes;
completion cues must survive batched events and errors must remain truthful.
Report QA covers series toggles, exact hovered/selected values, negative net worth,
refunds, category drilldown, presets and all months in long scrollable ranges.

```sh
npx vitest run tests/account-order.test.ts tests/account-order-storage.test.ts tests/activity-feedback.test.ts tests/report-model.test.ts
npx playwright test tests/e2e/account-order.spec.ts tests/e2e/activity-feedback.spec.ts tests/e2e/reports.spec.ts
```
