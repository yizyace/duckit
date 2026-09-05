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

test('trusts operations across the content fragment but not another document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-e2e-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${root}`],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  const frameURL = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.mainFrame.url)
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Skip to budget content' }).press('Enter')
    await expect(page.locator('#main-content')).toBeFocused()
    await page.evaluate(() => {
      location.hash = '#main-content'
    })
    await expect.poll(frameURL).toContain('/index.html#main-content')
    expect((await page.evaluate(() => window.duckit.getState())).ok).toBe(true)
    await page.evaluate(() => history.pushState({}, '', 'other.html'))
    await expect.poll(frameURL).toContain('/other.html')
    expect((await page.evaluate(() => window.duckit.getState())).ok).toBe(false)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
