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

Renderer edits use Fast Refresh and main-process edits restart Electron with
`--watch`. Preload edits rebuild successfully, but the existing navigation guard
can block the automatic renderer reload; manually reload the window to use the new
preload output.

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
