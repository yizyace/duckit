import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, realpath, readFile } from 'node:fs/promises'
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
  const root = await mkdtemp(join(tmpdir(), 'duckit-early-quit-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root },
  })
  try {
    await app.evaluate(({ app }) => app.getPath('userData'))
    await app.close()
    const configuration = JSON.parse(
      await readFile(join(root, 'runtime-state', '.dolt', 'config_global.json'), 'utf8'),
    )
    expect(configuration['metrics.disabled']).toBe('true')
    expect(configuration['user.email']).toBe('local@duckit.invalid')
  } finally {
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
