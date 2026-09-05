# Install Duckit on macOS

Choose the archive for your Mac: `arm64` for Apple Silicon or `x64` for Intel.
Open the DMG and drag Duckit to Applications, or unzip the ZIP and move Duckit.app
to Applications. Eject the DMG before opening the installed application.

Duckit contains its own Electron, Dolt, portable Git and Git Credential Manager.
You do not need Node, npm, Homebrew, developer tools, or a Duckit account. Budgeting
works offline. GitHub is optional and connects from Settings.

The initial local builds are unsigned and unnotarized because this machine has no
valid signing identity. macOS may block the first launch. After attempting to open
Duckit, use System Settings → Privacy & Security → Open Anyway for this application
and confirm the launch. Only do this for a build you obtained from this project.
Keep macOS security protections enabled. A managed Mac may require its administrator
to approve an unsigned application. See [Apple's instructions for opening an
unidentified application](https://support.apple.com/en-ie/102445).

Updates are manual: quit Duckit, replace the application in Applications with the
new build, and reopen it. Budgets and backups live separately in
`~/Library/Application Support/Duckit`; replacing the application preserves them.
Keep a recent verified backup before updating. Changing the backup folder in
Settings allows a destination on another disk.

## Build and verify locally

Development requires Node 24 and npm. Run from the source directory:

```sh
npm ci
npm run package:mac
npm run test:package -- --app="$PWD/release/mac-arm64/Duckit.app"
npm run test:package -- --app="$PWD/release/mac/Duckit.app"
```

The build creates `release/Duckit-<version>-arm64.{dmg,zip}` and
`release/Duckit-<version>-x64.{dmg,zip}`. Nothing is published automatically.
`CSC_IDENTITY_AUTO_DISCOVERY=false` can be supplied for an explicitly unsigned local
build. When valid signing credentials are provisioned, let electron-builder use
them and configure notarization before describing a distribution as notarized.
The current configuration does not notarize automatically. See the pinned builder's
[macOS signing guide](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/).

The packaged smoke test launches the actual bundled executable with only macOS
utility directories on PATH. It first verifies macOS home-directory isolation,
then checks the packaged application paths before creating a synthetic budget.
It exercises onboarding, account creation, an exact transaction save, backup,
clean exit, reopening and restoring the backup. It also executes bundled Dolt,
Git and GCM and compares their versions with the included runtime manifest.
Temporary storage is removed on completion. `--report=/absolute/path.json` saves
a small synthetic-only report.

The test harness itself uses development Node and Playwright to drive the installed
application; those tools are absent from the application's PATH. This verifies
bundled dependencies on this Mac. It does not replace testing on a fresh Mac.
Running the Intel package under Rosetta on Apple Silicon is recorded as translated
execution and does not claim testing on native Intel hardware. Browser sign-in,
Gatekeeper behavior after downloading a release, and notarization each require
their own acceptance checks.

For local storage inspection, see [diagnostics](diagnostics.md). For native GitHub
recovery, see [synchronization](sync.md); ordinary Git cloning cannot restore a
usable Dolt budget.
