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

Use [real Electron tests](../../../tests/e2e/) for keyboard, focus, labels and
navigation. Inspect rendered screenshots and run an accessibility audit.
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
