import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test'
import type { AppState, OperationResult } from '../src/shared/contracts'
import {
  binaryArchitectures,
  macHostArchitecture,
  runtimeBinaries,
  verifyNativeTree,
} from './runtime.ts'

const unwrap = <T>(result: OperationResult<T>): T => {
  if (!result.ok) throw new Error(result.message)
  return result.value
}
async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(
      'Usage: npm run test:package -- --app=/absolute/Duckit.app [--report=/absolute/report.json]',
    )
    return
  }
  const options = new Map<string, string>()
  for (const arg of args) {
    const match = /^--(app|report)=(.+)$/.exec(arg)
    if (!match || options.has(match[1]!)) throw new Error('Use --app= and optional --report= only')
    options.set(match[1]!, match[2]!)
  }
  const requested = options.get('app')
  if (!requested || !isAbsolute(requested) || !requested.endsWith('.app'))
    throw new Error('Pass an absolute --app=/path/Duckit.app')
  const bundle = await realpath(requested)
  const reportPath = options.get('report')
  if (reportPath && !isAbsolute(reportPath)) throw new Error('Report path must be absolute')
  const executablePath = join(bundle, 'Contents', 'MacOS', 'Duckit')
  const runtime = join(bundle, 'Contents', 'Resources', 'runtime')
  const nativeArchitecture = await macHostArchitecture()
  if (process.arch !== nativeArchitecture)
    throw new Error(
      `Run package smoke with native ${nativeArchitecture} Node; translation is not accepted`,
    )
  if (!(await binaryArchitectures(executablePath))?.includes(nativeArchitecture))
    throw new Error(
      `Package does not support this ${nativeArchitecture} Mac natively. Use a matching native runner; no app was launched.`,
    )
  const nativeCode = await verifyNativeTree(bundle, nativeArchitecture, [
    'Contents/MacOS/Duckit',
    ...runtimeBinaries.map((file) => `Contents/Resources/runtime/${file}`),
  ])
  const root = await mkdtemp(join(tmpdir(), 'duckit-packaged-'))
  const home = join(root, 'home')
  await mkdir(home)
  const appData = join(home, 'Library', 'Application Support')
  const userData = join(appData, 'Duckit')
  const env = {
    HOME: home,
    // macOS Foundation ignores HOME alone. CFFIXED_USER_HOME is verified below
    // before launching the packaged application, which ignores DUCKIT_TEST_ROOT.
    CFFIXED_USER_HOME: home,
    PATH: '/usr/bin:/bin',
    TMPDIR: root,
    LANG: 'en_US.UTF-8',
  }
  const exec = promisify(execFile)
  let app: ElectronApplication | undefined
  try {
    // Probe Foundation with the development Electron before the production entry
    // point can access storage. Do not launch a package if macOS ignores isolation.
    const probe = join(root, 'probe.cjs')
    await writeFile(probe, "const{app}=require('electron');app.whenReady().then(()=>{});")
    const preflight = await electron.launch({ args: [probe], env })
    try {
      assert.deepEqual(
        await preflight.evaluate(({ app }) => [app.getPath('home'), app.getPath('appData')]),
        [home, appData],
      )
    } finally {
      await preflight.close()
    }
    const launch = async () => {
      app = await electron.launch({ executablePath, env, timeout: 60000 })
      const paths = await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        home: app.getPath('home'),
        appData: app.getPath('appData'),
        userData: app.getPath('userData'),
        executable: process.execPath,
        arch: process.arch,
      }))
      assert.equal(paths.packaged, true)
      assert.equal(paths.home, home)
      assert.equal(paths.appData, appData)
      assert.equal(paths.userData, userData)
      assert.equal(paths.executable, executablePath)
      assert.equal(paths.arch, nativeArchitecture)
      const page = await app.firstWindow()
      await page.waitForFunction(() => typeof window.duckit?.getState === 'function')
      return { page, paths }
    }
    let { page, paths } = await launch()
    const initial = unwrap(await page.evaluate(() => window.duckit.getState()))
    assert.equal(initial.budget, null)
    assert.equal(initial.demo, false)
    await expect(page.getByRole('heading', { name: 'Welcome to your next chapter' })).toBeVisible()
    await page.getByLabel('Budget name', { exact: true }).fill('Packaged synthetic smoke')
    await page.getByRole('button', { name: 'Create a budget', exact: true }).click()
    await page.getByRole('button', { name: 'All accounts', exact: true }).click()
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    await page.getByLabel('Account name', { exact: true }).fill('Synthetic checking')
    await page.getByRole('button', { name: 'Save account', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    const accountState = unwrap(await page.evaluate(() => window.duckit.getState()))
    const account = accountState.budget!.accounts[0]!
    const saved = unwrap(
      await page.evaluate(
        async ({ accountId, revision }) =>
          window.duckit.command({
            id: crypto.randomUUID(),
            expectedRevision: revision,
            changes: [
              {
                type: 'transaction.put',
                value: {
                  id: 'packaged-smoke-income',
                  accountId,
                  date: '2026-09-04',
                  payeeId: null,
                  memo: 'Synthetic package acceptance',
                  amount: '12345',
                  cleared: 'cleared',
                  transferId: null,
                  bankId: null,
                  legacyId: null,
                  splits: [
                    {
                      id: 'packaged-smoke-split',
                      categoryId: null,
                      incomeMonth: '2026-09',
                      amount: '12345',
                      memo: '',
                    },
                  ],
                },
              },
            ],
          }),
        { accountId: account.id, revision: accountState.budget!.revision },
      ),
    )
    assert.equal(saved.budget!.transactions[0]!.amount, '12345')
    unwrap(await page.evaluate(() => window.duckit.backupNow()))
    const backups = unwrap(await page.evaluate(() => window.duckit.listBackups()))
    assert(backups.length > 0)
    const backup = backups[0]!
    const snapshot = saved.budget!
    const runtimeEnv = {
      ...env,
      PATH: [
        join(runtime, 'git/bin'),
        join(runtime, 'git/libexec/git-core'),
        join(runtime, 'dolt/bin'),
        '/usr/bin',
        '/bin',
      ].join(':'),
      GIT_EXEC_PATH: join(runtime, 'git/libexec/git-core'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      DOLT_ROOT_PATH: join(userData, 'runtime-state'),
      DOLT_DISABLE_EVENT_FLUSH: '1',
    }
    const versions = {
      dolt: (
        await exec(join(runtime, 'dolt/bin/dolt'), ['version'], { env: runtimeEnv, timeout: 15000 })
      ).stdout.trim(),
      git: (
        await exec(join(runtime, 'git/bin/git'), ['--version'], { env: runtimeEnv, timeout: 15000 })
      ).stdout.trim(),
      gcm: (
        await exec(join(runtime, 'git/libexec/git-core/git-credential-manager'), ['--version'], {
          env: runtimeEnv,
          timeout: 15000,
        })
      ).stdout.trim(),
    }
    const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'))
    assert(versions.dolt.includes(manifest.doltVersion))
    assert(versions.git.includes(manifest.gitVersion))
    assert(versions.gcm.includes(manifest.gcmVersion))
    await app!.close()
    app = undefined
    ;({ page, paths } = await launch())
    const reopened: AppState = unwrap(await page.evaluate(() => window.duckit.getState()))
    assert.deepEqual(reopened.budget, snapshot)
    const restored = unwrap(
      await page.evaluate(
        ({ id, expectedRevision }) => window.duckit.restoreBackup({ id, expectedRevision }),
        { id: backup.id, expectedRevision: reopened.budget!.revision },
      ),
    )
    assert.deepEqual({ ...restored.budget, revision: snapshot.revision }, snapshot)
    const report = {
      package: bundle,
      architecture: paths.arch,
      hostArchitecture: nativeArchitecture,
      execution: 'native architecture',
      nativeCode,
      packaged: true,
      storageIsolation: 'verified before synthetic mutations',
      path: env.PATH,
      workflows: [
        'onboarding',
        'account creation',
        'exact transaction save',
        'backup',
        'clean quit',
        'reopen parity',
        'backup restore parity',
      ],
      versions,
      result: 'passed',
    }
    if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (app) await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Packaged smoke failed')
  process.exitCode = 1
})
