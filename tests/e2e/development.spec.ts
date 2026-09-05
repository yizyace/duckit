import { test, expect, chromium, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('refreshes renderer drafts and reloads preload and main without competing processes', async ({}, testInfo) => {
  test.setTimeout(120_000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'duckit-development-')))
  const application = join(root, 'application'),
    storage = join(root, 'storage')
  await mkdir(application)
  await mkdir(storage)
  for (const path of ['src', 'scripts', 'package.json', 'tsconfig.json', 'electron.vite.config.ts'])
    await cp(join(process.cwd(), path), join(application, path), { recursive: true })
  await symlink(join(process.cwd(), 'node_modules'), join(application, 'node_modules'))
  await mkdir(join(application, 'resources'))
  await symlink(
    join(process.cwd(), 'resources', 'runtime'),
    join(application, 'resources', 'runtime'),
  )
  const mainPath = join(application, 'src/main/index.ts')
  const preloadPath = join(application, 'src/preload/index.ts')
  const rendererPath = join(application, 'src/renderer/src/views/SettingsView.tsx')
  const main = await readFile(mainPath, 'utf8'),
    preload = await readFile(preloadPath, 'utf8')
  const mainSource = (version: number) =>
    `${main}
console.log('DUCKIT_DEVELOPMENT_TEST:' + JSON.stringify({ pid: process.pid, version: ${version}, root: app.getPath('userData') }));
ipcMain.on('duckit-development-test:quit', () => app.quit());
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', event => queueMicrotask(() => console.log('DUCKIT_DEVELOPMENT_NAV:' + JSON.stringify({ path: new URL(event.url).pathname, prevented: event.defaultPrevented }))));
});
`
  const preloadSource = (version: number) => `${preload}
contextBridge.exposeInMainWorld('__duckitDevelopmentTest', { version: ${version}, quit: () => ipcRenderer.send('duckit-development-test:quit') });
`
  await writeFile(mainPath, mainSource(0))
  await writeFile(preloadPath, preloadSource(0))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DUCKIT_TEST_ROOT: storage,
    DUCKIT_DEMO: '',
    REMOTE_DEBUGGING_PORT: '0',
  }
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_CLI_ARGS',
    'ELECTRON_ENTRY',
    'ELECTRON_EXEC_PATH',
    'ELECTRON_RENDERER_URL',
    'V8_INSPECTOR_PORT',
    'V8_INSPECTOR_BRK_PORT',
    'NO_SANDBOX',
  ])
    delete env[key]
  const child = spawn(process.execPath, [join(application, 'scripts/development.ts')], {
    cwd: application,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logPath = testInfo.outputPath('development.log')
  await mkdir(testInfo.outputDir, { recursive: true })
  await writeFile(logPath, '')
  let output = '',
    page: Page | undefined
  let spawnError: Error | undefined
  const exited = once(child, 'close').catch((error: Error) => {
    spawnError = error
  })
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (bytes: Buffer) => {
      output += bytes.toString()
      appendFileSync(logPath, bytes)
    })
  const starts = () =>
    [...output.matchAll(/DUCKIT_DEVELOPMENT_TEST:(\{[^\r\n]+\})/g)].map(
      (match) => JSON.parse(match[1]!) as { pid: number; version: number; root: string },
    )
  async function attach(after = 0) {
    let endpoint = ''
    await expect
      .poll(
        () => {
          if (spawnError) throw spawnError
          expect(child.exitCode, 'development server exited').toBeNull()
          endpoint =
            [
              ...output
                .slice(after)
                .matchAll(
                  /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/g,
                ),
            ].at(-1)?.[1] ?? ''
          return endpoint
        },
        { timeout: 30_000 },
      )
      .not.toBe('')
    const browser = await chromium.connectOverCDP(endpoint)
    await expect
      .poll(
        () => {
          page = browser
            .contexts()
            .flatMap((context) => context.pages())
            .find((candidate) => !candidate.url().startsWith('devtools:'))
          return Boolean(page)
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    await expect(page!.getByLabel('Budget name', { exact: true })).toBeVisible({ timeout: 30_000 })
    expect(
      await page!.evaluate(async () => ({
        state: await window.duckit.getState(),
        node: typeof Reflect.get(window, 'require'),
      })),
    ).toMatchObject({ state: { ok: true, value: { budget: null } }, node: 'undefined' })
    expect(starts().at(-1)?.root).toBe(storage)
    return page!
  }
  try {
    page = await attach()
    await page.getByLabel('Budget name', { exact: true }).fill('Unsaved renderer draft')
    await writeFile(
      rendererPath,
      (await readFile(rendererPath, 'utf8')).replace(
        'Welcome to your next chapter',
        'Renderer refresh completed',
      ),
    )
    await expect(page.getByRole('heading', { name: 'Renderer refresh completed' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByLabel('Budget name', { exact: true })).toHaveValue(
      'Unsaved renderer draft',
    )

    await writeFile(preloadPath, preloadSource(1))
    await expect
      .poll(
        () =>
          page!
            .evaluate(() => Reflect.get(window, '__duckitDevelopmentTest')?.version)
            .catch(() => undefined),
        { timeout: 15_000 },
      )
      .toBe(1)
    await expect(page.getByLabel('Budget name', { exact: true })).toHaveValue('My budget')
    const beforePreloadError = output.length
    await page.getByLabel('Budget name', { exact: true }).fill('Draft survives a failed build')
    await writeFile(preloadPath, `${preloadSource(1)}\nconst broken = ;`)
    await expect.poll(() => output.slice(beforePreloadError)).toContain('preload build failed:')
    await expect(page.getByLabel('Budget name', { exact: true })).toHaveValue(
      'Draft survives a failed build',
    )
    await writeFile(preloadPath, preloadSource(1))
    await expect(page.getByLabel('Budget name', { exact: true })).toHaveValue('My budget')
    const rendererDocument = page.url()
    await page.evaluate(() => {
      location.href = new URL('/outside-application', location.href).href
    })
    await expect.poll(() => output).toContain('"path":"/outside-application","prevented":true')
    // Canceled Electron navigation leaves Playwright's navigation waiter pending.
    // Read the retained document directly after observing the prevention event.
    expect(
      await page.evaluate(() => ({
        url: location.href,
        ready: document.querySelector('input')?.isConnected,
        version: Reflect.get(window, '__duckitDevelopmentTest')?.version,
      })),
    ).toEqual({ url: rendererDocument, ready: true, version: 1 })

    for (let version = 1; version <= 3; version++) {
      const previous = starts().at(-1)!,
        after = output.length
      if (version === 2) {
        await writeFile(mainPath, `${mainSource(version)}\nconst broken = ;`)
        await expect.poll(() => output.slice(after)).toContain('main build failed:')
        expect(starts().at(-1)).toEqual(previous)
        expect(await page.evaluate(async () => (await window.duckit.getState()).ok)).toBe(true)
      }
      if (version === 1) {
        // Keep the old instance alive long enough to expose an eager replacement.
        // The runner must wait for its close even when termination is delayed.
        process.kill(previous.pid, 'SIGSTOP')
        const resume = setTimeout(() => {
          try {
            process.kill(previous.pid, 'SIGCONT')
          } catch {}
        }, 1500)
        try {
          await writeFile(mainPath, mainSource(version))
          await expect.poll(() => starts().at(-1)?.version, { timeout: 15_000 }).toBe(version)
        } finally {
          clearTimeout(resume)
          try {
            process.kill(previous.pid, 'SIGCONT')
          } catch {}
        }
      } else await writeFile(mainPath, mainSource(version))
      await expect.poll(() => starts().at(-1)?.version, { timeout: 15_000 }).toBe(version)
      page = await attach(after)
      expect(starts().at(-1)?.pid).not.toBe(previous.pid)
      await expect
        .poll(() => {
          try {
            process.kill(previous.pid, 0)
            return false
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
            throw error
          }
        })
        .toBe(true)
      expect(
        await page.evaluate(() => Reflect.get(window, '__duckitDevelopmentTest')?.version),
      ).toBe(1)
    }
    expect(starts()).toHaveLength(4)
  } finally {
    const stop = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGTERM')
      } catch {}
    }, 5000)
    const force = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
    }, 10_000)
    // A failed reload can leave renderer evaluation pending. The process-group
    // fallback must not depend on receiving an IPC reply from that renderer.
    void page
      ?.evaluate(() => Reflect.get(window, '__duckitDevelopmentTest')?.quit())
      .catch(() => {})
    try {
      await exited
    } finally {
      clearTimeout(stop)
      clearTimeout(force)
    }
    await testInfo.attach('development.log', { path: logPath, contentType: 'text/plain' })
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
