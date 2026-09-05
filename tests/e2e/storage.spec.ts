import { test, expect, _electron as electron } from '@playwright/test'
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  realpath,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('test launches cannot open development or production storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root },
  })
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(await realpath(root))
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: 'Create a budget', exact: true })).toBeVisible()
    const api = await page.evaluate(() => Object.keys(window.duckit))
    expect(api).not.toContain('invoke')
    expect(api).not.toContain('readFile')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('finishes startup runtime work when quit arrives before the first window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-early-quit-')),
    application = join(root, 'application'),
    runtime = join(application, 'resources', 'runtime', process.arch),
    doltBin = join(runtime, 'dolt', 'bin'),
    runtimeState = join(root, 'runtime-state'),
    entered = join(runtimeState, 'startup-entered'),
    finished = join(runtimeState, 'startup-command-finished'),
    release = join(runtimeState, 'startup-continue'),
    quitRequested = join(root, 'quit-requested'),
    windowCount = join(root, 'window-count')
  await mkdir(doltBin, { recursive: true })
  await writeFile(
    join(application, 'package.json'),
    JSON.stringify({ main: join(process.cwd(), 'out', 'main', 'index.js') }),
  )
  await symlink(
    join(process.cwd(), 'resources', 'runtime', process.arch, 'git'),
    join(runtime, 'git'),
  )
  await symlink(
    join(process.cwd(), 'resources', 'runtime', process.arch, 'dolt', 'bin', 'dolt'),
    join(doltBin, 'dolt-real'),
  )
  // Hold the first native command: getPath() alone can run before whenReady/startup.
  await writeFile(
    join(doltBin, 'dolt'),
    `#!/bin/sh
if [ "$1" = config ] && [ "$4" = metrics.disabled ]; then
  : > "$DOLT_ROOT_PATH/startup-entered"
  while [ ! -f "$DOLT_ROOT_PATH/startup-continue" ]; do sleep 0.01; done
  "$(dirname "$0")/dolt-real" "$@"
  result=$?
  : > "$DOLT_ROOT_PATH/startup-command-finished"
  exit "$result"
fi
exec "$(dirname "$0")/dolt-real" "$@"
`,
    { mode: 0o700 },
  )
  const app = await electron.launch({
    args: [application],
    env: { ...process.env, DUCKIT_TEST_ROOT: root },
  })
  try {
    await expect
      .poll(() =>
        access(entered).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    expect(
      await app.evaluate(
        ({ app, BrowserWindow }, markers) => {
          let created = BrowserWindow.getAllWindows().length
          app.on('browser-window-created', () => created++)
          app.once('before-quit', () => {
            process.getBuiltinModule('node:fs').writeFileSync(markers.quitRequested, '')
          })
          app.once('will-quit', () => {
            process.getBuiltinModule('node:fs').writeFileSync(markers.windowCount, String(created))
          })
          return BrowserWindow.getAllWindows().length
        },
        { quitRequested, windowCount },
      ),
    ).toBe(0)
    const closed = app.close()
    await expect
      .poll(() =>
        access(quitRequested).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true)
    await writeFile(release, '')
    await closed
    const configuration = JSON.parse(
      await readFile(join(root, 'runtime-state', '.dolt', 'config_global.json'), 'utf8'),
    )
    expect(configuration['metrics.disabled']).toBe('true')
    expect(configuration['user.email']).toBe('local@duckit.invalid')
    expect(await readFile(windowCount, 'utf8')).toBe('0')
  } finally {
    await writeFile(release, '').catch(() => {})
    await app.close().catch(() => {})
    // A failing shutdown regression must not leave our detached gated command running.
    if (
      await access(entered).then(
        () => true,
        () => false,
      )
    ) {
      await expect
        .poll(() =>
          access(finished).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true)
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
