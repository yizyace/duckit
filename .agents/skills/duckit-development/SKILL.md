---
name: duckit-development
description: Implement or review Duckit's Electron main, preload, renderer, and storage boundaries using the validated API and isolated development workflow.
---

# Duckit development

Follow [contributor startup](../../../docs/development.md) for shared ownership,
review, and verification conventions. Consult [architecture](../../../docs/architecture.md)
for the application boundaries and [capability status](../../../docs/capabilities.md)
for remaining acceptance limits.
Use [agent work](../../../docs/agent-work.md) to assign files, coordinate shared
contracts, and hand off evidence when work spans modules or agents.

Renderer access stops at `DuckitAPI`. Validate operation inputs and sender/frame in
main. Never forward arbitrary IPC channel names, SQL, shell commands, paths or
credentials. Use explicit account/category identifiers and exact money strings.
Main owns a single serialized mutation queue. Native dialogs select files.

- API changes connect [shared contracts](../../../src/shared/contracts.ts),
  [main handlers](../../../src/main/index.ts), and [preload](../../../src/preload/index.ts).
- Durable operations belong in [BudgetService](../../../src/main/service.ts) and
  [Workspace](../../../src/main/storage/workspace.ts); renderer integration starts in
  [App](../../../src/renderer/src/App.tsx).

Development and demo storage use separate `Duckit Development` and `Duckit Demo`
application-data directories. Packaged builds use `Duckit` and ignore
`DUCKIT_TEST_ROOT` and `DUCKIT_DEMO`. For unpackaged tests, create an existing
temporary directory whose canonical path is within a `duckit-*` subtree of
`os.tmpdir()`. The main-process guard rejects relative paths and escapes through
traversal or symlinks. [Storage Electron tests](../../../tests/e2e/storage.spec.ts)
exercise this boundary. Never develop against real budgets.

Run `npm run check` and focused Electron tests. Ship the committed
[lockfile](../../../package-lock.json) and binaries pinned by the
[runtime manifest](../../../resources/runtime-manifest.json). Use
[read-only diagnostics](../../../docs/diagnostics.md) when inspecting a selected
development or synthetic test root.

Keep UI preferences in renderer-local storage, outside financial snapshots and
sync. Account positions are explicitly budget data: use `account.reorder` through
the revision-guarded command path; preserve section membership and undo/redo.
Legacy schemas upgrade through verified native copies, never active-database DDL.
See [architecture](../../../docs/architecture.md) for migration and activity rules. `App` owns session budget navigation and the single memoized working-balance
map shared by sidebar and register. Reuse the existing exact-money register helper;
do not scan the ledger separately for every account or while dragging the sidebar.
Use the local-date hook for quiet midnight/foreground refreshes. Month-only inputs
use the shared portaled chooser; preserve day-date semantics in transaction forms.
See [architecture](../../../docs/architecture.md) for preference and cutoff rules.
