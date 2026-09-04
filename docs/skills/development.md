# Development guide

Renderer access stops at `DuckitAPI`. Validate operation inputs and sender/frame in
main. Never forward arbitrary IPC channel names, SQL, shell commands, paths or
credentials. Use explicit account/category identifiers and exact money strings.
Main owns a single serialized mutation queue. Native dialogs select files.

Run `npm run check` and focused Electron tests. Test roots must be temporary and
separate from production application data. Ship a lockfile and pinned binaries.
