# Working across agents

Use this map when starting or delegating work. Keep durable behavior in the linked
architecture and skills; task-specific progress belongs in the current handoff.
The [startup guide](development.md) lists the project's review and commit rules.

## Read only what the task needs

| Question                                                       | Maintained source                                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What owns this behavior, and which invariants cross modules?   | [Architecture](architecture.md)                                                                                                                                            |
| What data and operations can cross the preload boundary?       | [Shared contracts](../src/shared/contracts.ts)                                                                                                                             |
| How do Classic balances, income and carryover work?            | [Budgeting skill](../.agents/skills/duckit-budgeting/SKILL.md) and [engine tests](../tests/engine.test.ts)                                                                 |
| How do candidates, imports, backups and remote history behave? | [Recovery skill](../.agents/skills/duckit-recovery/SKILL.md), [statements](statements.md), [sync](sync.md)                                                                 |
| Where can development and tests safely store data?             | [Development skill](../.agents/skills/duckit-development/SKILL.md)                                                                                                         |
| What is implemented and what has been verified?                | [Capability status](capabilities.md), with the matching run/artifact evidence                                                                                              |
| Which checks and packaging commands exist now?                 | [package.json](../package.json), [CI and release](ci.md), [workflows](../.github/workflows/), [installation](install.md), [QA skill](../.agents/skills/duckit-qa/SKILL.md) |

## Choose bounded ownership

The integrating agent owns shared contracts, main/preload wiring and final
integration. Agree on the operation signature, validation errors and expected
domain changes before parallel consumers depend on a new API. Assign each worker
specific files and tests, with explicit exclusions where modules meet.

| Workstream                 | Useful ownership boundary                                                  | Coordinate at                                                  |
| -------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Budgeting engine           | `src/engine/` and focused financial tests                                  | Shared schemas and renderer consumers                          |
| Persistence                | `src/main/storage/` and schema/storage tests                               | Service queue, schema compatibility, sync and recovery         |
| Legacy reconstruction      | `src/main/imports/ynab*.ts`, related scripts and synthetic tests           | Main preview/activation and private independent validation     |
| Statement parsing/matching | `src/main/imports/statement*.ts` and statement tests                       | `imports/commands.ts`, preview contracts and import dialog     |
| Sync/recovery              | A named subset of `src/main/sync/` or `src/main/recovery/`, with its tests | Workspace activation, runtime signals and lifecycle scheduling |
| Renderer feature           | Named views and their styles/Electron tests                                | `App.tsx`, shared controls, formatting and command handlers    |
| Runtime/build/CI           | Named scripts, runtime manifest, build config or workflows                 | Dependency lockfile, native runner checks and release evidence |
| Independent review         | The completed diff and relevant QA evidence                                | Findings returned to the owner before closure                  |

These are boundaries to adapt, not permission to edit every listed file. Workers
share a checkout: inspect existing changes, retain others' work, and report needed
cross-owner edits instead of reverting them. Avoid simultaneous mutation, restore
or sync against one acceptance workspace. Synthetic workers use separate temporary
roots; production acceptance has one coordinator.

## Commands and focused evidence

Use Node 24 and the committed lockfile. Run commands from the repository root.

| Purpose                                            | Command or entry point                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Install dependencies                               | `npm ci`                                                                                       |
| Prepare pinned local runtimes                      | `npm run runtime:fetch`; see [runtime notes](runtime.md) for architecture selection            |
| Hot reload / synthetic demo                        | `npm run dev` / `npm run demo`                                                                 |
| Focused financial tests                            | `npx vitest run tests/engine.test.ts`                                                          |
| Focused persistence/import/recovery tests          | `npx vitest run` followed by the relevant files in [tests/](../tests/)                         |
| Types, unit/integration tests and production build | `npm run check`                                                                                |
| Full Electron interaction suite                    | `npm run test:e2e`                                                                             |
| Focused Electron checks after building             | `npx playwright test tests/e2e/register.spec.ts` or another owned spec                         |
| Formatting                                         | `npm run format:check`; explicitly check edited `.agents/skills/` Markdown as well             |
| Selected local database inspection                 | `npm run diagnostics -- --help`, then [diagnostics](diagnostics.md) with an explicit root      |
| Packaging and installed-app checks                 | [Installation](install.md) and the current [package smoke script](../scripts/package-smoke.ts) |

The [QA skill](../.agents/skills/duckit-qa/SKILL.md) maps failure scenarios to tests.
Keep real-budget archives, databases, screenshots, logs and oracle outputs outside
the repository. Public fixtures and uploaded reports contain only synthetic data.

## Keep a reviewable handoff

Send the integrating agent the changed paths, observable behavior, any contract
change, commands actually run, outcomes, and unresolved findings. Include the source
revision or identify the uncommitted diff reviewed. State which runtime architecture
executed the test. An independent reviewer checks the finished slice before closure;
the coordinator combines the slices and verifies their integration.

Keep evidence at the appropriate boundary:

- Synthetic local and CI reports use ignored `reports/`, `playwright-report/` and
  `test-results/`. CI run URLs and artifact names identify the tested revision.
- Local build output lives in ignored `out/` and `release/`. Record artifact hashes
  and the source revision for a release; a later passing source run verifies a
  package only when the relevant application inputs still match.
- Private acceptance evidence and task tracking stay outside public source. Their
  locations come from the coordinator's current handoff. Public docs describe the
  method and limits without copying private paths, remote identities or data.

Workflow definitions, local checks and live CI/package runs are separate evidence.
Record pending runs as pending. Keep native Intel versus Rosetta, a minimal PATH
versus a fresh Mac, reused credentials versus a fresh browser grant, and automated
accessibility versus auditory VoiceOver checks distinct. Ledger comparison to an
independent oracle does not establish original-application display parity.

Update [architecture](architecture.md) when a module boundary or invariant changes,
[capabilities](capabilities.md) when evidence changes, and the relevant project
skill when future decisions should change. Prefer one maintained explanation with
links from other entry points. Validate edited skill metadata, resolve its links,
and preserve managed agent-file content outside the custom sections.
