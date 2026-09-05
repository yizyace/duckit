# Contributor startup

1. Read `CONSTITUTION.md`, [architecture](architecture.md), and [capability status](capabilities.md).
2. Inspect the working tree before editing. Other contributors may be active.
3. Use Node 24, `npm ci`, and synthetic fixtures. Never develop against real budgets.
4. Keep shared contracts and cross-module integration under one owner.
5. Run focused tests, `npm run check`, and relevant Electron interaction tests.
6. Every implementation slice needs independent review and recorded QA before closure.
7. Commit atomic Conventional Commits; push only reviewed, passing batches.

Electron downloads its executable on first use. `npm run dev`, `npm run demo`, and
`npm start` first run the package's local `install-electron` command, which downloads
the pinned binary when missing and reuses an existing installation without network
access. Run `npm run electron:install` explicitly before invoking electron-vite
directly. The initial download needs network access or a populated Electron cache.

The [development runner](../scripts/development.ts) uses electron-vite's public
configuration API and Vite's build watchers and renderer server. Renderer edits use
Fast Refresh. Main-process edits restart Electron only after the outgoing process
closes, so two processes cannot compete for the same development storage lock.
Rebuilds received during shutdown coalesce into one launch of the latest output.
Preload edits rebuild and reload the current development document;
unrelated navigation stays blocked. Fast Refresh preserves component drafts when
React can retain the component, while a preload reload or main restart resets
renderer state. `npx playwright test tests/e2e/development.spec.ts` exercises all
three paths in a temporary source copy and isolated storage root.

A failed main/preload rebuild stays visible in the terminal and prevents launching
that output; correcting the source resumes watching and launches the successful
build when needed. Initial build or setup failures exit unsuccessfully. Quitting
Electron or interrupting the runner closes both build watchers and the renderer
server. The runner allows 15 seconds for Electron to close after SIGTERM, then logs
and attempts SIGKILL with a further two-second bound. It refuses to launch a
replacement if the old process's closure cannot be confirmed.

Use [agent work](agent-work.md) for module ownership, bounded delegation, useful
commands and evidence handoff. It points to the maintained source for each concern;
carry task-specific progress in the current handoff rather than copying it into
architecture or skills.

Use the project skill relevant to the work:

- [Development and storage isolation](../.agents/skills/duckit-development/SKILL.md)
- [Classic budgeting rules](../.agents/skills/duckit-budgeting/SKILL.md)
- [Migration and recovery](../.agents/skills/duckit-recovery/SKILL.md)
- [Verification and desktop QA](../.agents/skills/duckit-qa/SKILL.md)

[Capability status](capabilities.md) distinguishes usable behavior from pending acceptance gates.
