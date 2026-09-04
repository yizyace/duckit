# Contributor startup

1. Read `CONSTITUTION.md`, `docs/architecture.md`, and `docs/capabilities.md`.
2. Inspect the working tree before editing. Other contributors may be active.
3. Use Node 24, `npm ci`, and synthetic fixtures. Never develop against real budgets.
4. Keep shared contracts and cross-module integration under one owner.
5. Run focused tests, `npm run check`, and relevant Electron interaction tests.
6. Every implementation slice needs independent review and recorded QA before closure.
7. Commit atomic Conventional Commits; push only reviewed, passing batches.

Project guides in `docs/skills/` cover development, budgeting rules, recovery and QA.
Capability status distinguishes usable behavior from pending acceptance gates.
