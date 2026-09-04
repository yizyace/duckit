# Duckit

An offline, macOS-first Classic envelope budget. Built with Electron, TypeScript and
React. Budgets belong on your computer; GitHub synchronization will be optional.

Development requires Node 24 and npm. Production packages bundle their runtime tools.

```sh
npm ci
npm run dev          # Electron with renderer and main-process hot reload
npm run demo         # isolated synthetic demonstration budget
npm run check        # types, focused unit tests and production build
npm run test:watch   # focused tests; append a test filename
npm run test:e2e     # real Electron interaction with temporary test storage
npm run package:mac # Apple Silicon and Intel artifacts, no publishing
```

See [architecture](docs/architecture.md), [capability status](docs/capabilities.md),
and [contributor startup](docs/development.md). Financial archives and budgets must
never be committed. Manual updates are the initial distribution model.
