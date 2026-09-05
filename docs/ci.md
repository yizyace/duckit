# Continuous integration and delivery

[CI](../.github/workflows/ci.yml) checks pushes to branches, pull requests, manual
runs, and a weekly Monday run at 09:23 UTC. It is also reused by the
[draft release workflow](../.github/workflows/release.yml).

| Check                           | Runner                 | What must pass                                                                                                                    |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Formatting, types and workflows | Ubuntu 24.04           | Committed Prettier rules, TypeScript, checksum-pinned actionlint                                                                  |
| Desktop (arm64)                 | macOS 15 Apple Silicon | Native architecture assertion, verified runtime downloads, unit/integration tests, production build, Electron/accessibility tests |
| Desktop (x64)                   | macOS 15 Intel         | The same checks on native Intel hardware                                                                                          |
| CI passed                       | Ubuntu 24.04           | Every required job succeeded, including optional packaging when requested                                                         |

The runner labels are explicit: `macos-15` is arm64 and `macos-15-intel` is x64.
The workflow asserts Node's architecture rather than relying on the label alone.
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Steps within each desktop job run sequentially and Playwright uses one worker.
Vitest can run independent test files in parallel.
The matrix continues on the other architecture after a failure. New commits cancel
obsolete branch/PR runs; version-tag release runs are not cancelled automatically.

The stable `CI passed` job can be selected as a required check in repository branch
rules. The workflows do not change branch protection or merge policy.

## Reports and failures

Each desktop job retains synthetic JUnit, Playwright HTML and test-output files for
seven days as `test-reports-arm64` or `test-reports-x64`, including when tests fail.
Download them from the Actions run. Open the HTML report locally with
`npx playwright show-report /path/to/playwright-report`.

The existing Electron tests launch their own app contexts. Reports include the
screenshots emitted into the uploaded test-output directories; the conflict review
test's temporary-directory screenshot is not uploaded. This does not claim automatic
trace/video capture for those contexts. `forbidOnly` rejects accidentally focused tests in CI.
No retries hide a failing test. Job timeouts bound stuck processes, and a failed,
cancelled or skipped prerequisite cannot produce a green `CI passed` result.

Run local equivalents with `npm run format:check`, `npm run check`, and
`npm run test:e2e`. Workflow validation uses actionlint 1.7.12; its download checksum
is pinned directly in the workflow. Update that version and checksum together.

## Verified installers on demand

Select **Actions → CI → Run workflow**, choose a branch, and enable **Build and
verify downloadable Mac installers**, or run:

```sh
gh workflow run ci.yml --ref main -f package=true
```

After tests pass, each native runner uses [ci-package](../scripts/ci-package.ts) to
build its DMG and ZIP and run [package smoke](../scripts/package-smoke.ts). Before
launching, smoke verifies the host, Node, app and every Mach-O file agree on native
architecture. An Intel app is rejected on an Apple Silicon smoke-test host before
Electron launches. Runtime preparation also checks all bundled native code.

Smoke first proves isolated macOS application data, then exercises onboarding,
exact saves, backup, clean exit, reopen and restore using a synthetic budget and
minimal PATH. DMG/ZIP integrity is checked after smoke. Each `installers-<arch>`
artifact contains the installers, SHA-256 sums, source/runtime manifest provenance,
and native smoke report. Only verified outputs are uploaded; retention is seven days.
The ordinary push/PR and weekly runs save test reports without packaging installers.

## Version tags and draft releases

After a reviewed version change in both `package.json` and `package-lock.json` has
been pushed to `main`, push a tag exactly matching `v<package version>`. The tag
workflow checks version equality and membership in main's history, then reruns
all checks and builds both architectures. A final isolated job downloads those
same-run artifacts, checks both checksum manifests, and creates a **draft** GitHub
release with installers and verification metadata.

The workflow does not publish the draft, force-update tags, replace an existing
release, or enable automatic application updates. Review the draft before publishing
it manually. If an upload interruption leaves a partial draft, inspect and remove
that incomplete draft before rerunning; existing releases are never overwritten.
Manual CI runs create Actions artifacts only, even if launched against a tag.

Builds are unsigned and unnotarized. Follow [installation](install.md); signed
distribution requires separately provisioned signing/notarization credentials and
configuration. No signing or financial credential is supplied to these workflows.

## Workflow and dependency maintenance

Actions use full commit SHA pins with release-version comments. Check publisher
releases when updating pins. [GitHub's pinning guidance](https://docs.github.com/en/actions/reference/security/secure-use).
[Dependabot](../.github/dependabot.yml) checks Actions and npm weekly on Tuesday at
09:00 UTC. Compatible npm minor/patch updates are grouped separately for production
and development; major npm updates remain separate. Updates open reviewed PRs and
run the same CI. There is no automatic merge.

All ordinary jobs have read-only repository access and checkout does not persist
credentials. Only the final draft-release job has `contents: write`; it does not
check out or run the application. Pull requests use `pull_request`, including forks,
without private secrets or `pull_request_target`. npm downloads are cached; runtime
downloads are always checksum-verified. Public artifacts are allowlisted test/build
outputs. Real budgets, archives, backups, migration reports and screenshots never
belong in CI inputs or uploads.
