import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('opens an isolated and sandboxed desktop window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-e2e-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${root}`],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    ).toBe('undefined')
    expect(await page.evaluate(() => typeof window.duckit.getState)).toBe('function')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
test('refuses to navigate before a budget exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-onboarding-nav-e2e-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${root}`],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '' },
  })
  try {
    const page = await app.firstWindow()
    const welcome = page.getByRole('heading', { name: 'Welcome', exact: true, level: 1 })
    await expect(welcome).toBeVisible()
    await expect(page).toHaveTitle('Welcome · Duckit')
    await page.keyboard.press('Meta+3')
    await expect(welcome).toBeVisible()
    await expect(page).toHaveTitle('Welcome · Duckit')
    await page.getByRole('button', { name: 'Reports', exact: true }).click({ force: true })
    await expect(welcome).toBeVisible()
    await expect(page).toHaveTitle('Welcome · Duckit')
    for (const name of ['Budget', 'All accounts', 'Reports', 'Settings'])
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
    await expect(page.locator('[aria-current="page"]')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
