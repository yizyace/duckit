# Capability status

This is an application under construction. Do not treat scaffolding or synthetic
fixtures as evidence of financial correctness or a production-ready migration.

| Capability                                           | Status                              |
| ---------------------------------------------------- | ----------------------------------- |
| Node 24, Electron/Vite, TypeScript/React build       | Verified: typecheck, build, contract tests, Electron launch |
| Named preload API and canonical money/date contracts | Verified: typecheck, build, contract tests, Electron launch |
| Classic engine and normalized Dolt persistence       | Pending                             |
| Import reconstruction and independent oracle         | Pending                             |
| Register, budget grid, reports                       | Pending                             |
| Private GitHub sync and automatic backup             | Pending                             |
| macOS packaged acceptance                            | Pending                             |

Record focused QA commands and practical limitations as each slice is verified.
Migration activation requires an independent ledger/category-month oracle and a
verified recovery path. Original-app display parity is a separate unverified claim.

Bootstrap QA: three contract tests and two real Electron tests passed. Independent
review additionally verified live development launch, preload isolation and temporary
storage. Development-only runtime tooling is verified separately before packaging.
