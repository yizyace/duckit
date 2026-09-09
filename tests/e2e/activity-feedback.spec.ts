import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Status } from '../../src/shared/contracts'

test('shows real saves, fast sync completion, background refresh and errors without hiding the budget', async ({}, testInfo) => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'duckit-activity-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    const indicator = page.locator('.activity-indicator')
    const initial = await page.evaluate(async () => {
      const result = await window.duckit.getState()
      if (!result.ok || !result.value.budget) throw new Error('Missing synthetic budget')
      return result.value
    })
    // This is a real local database write; the renderer sees the service's IPC events.
    const save = page.evaluate(async () => {
      const current = await window.duckit.getState()
      if (!current.ok || !current.value.budget) throw new Error('Missing synthetic budget')
      const budget = current.value.budget
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: budget.revision,
        changes: [
          { type: 'account.put', value: { ...budget.accounts[0]!, name: 'Activity checking' } },
        ],
      })
      if (!result.ok) throw new Error(result.message)
    })
    await expect(indicator).toHaveAttribute('data-activity', 'save')
    await expect(indicator).toHaveAttribute('data-phase', 'success')
    await expect(indicator).toHaveText('Saved just now')
    await save
    await expect(indicator).toHaveAttribute('data-phase', 'idle')

    const syncedState = await page.evaluate(async () => {
      const result = await window.duckit.getState()
      if (!result.ok) throw new Error(result.message)
      return { ...result.value, status: { ...result.value.status, remote: 'synced' as const } }
    })
    await app.evaluate(({ ipcMain }, state) => {
      ipcMain.removeHandler('duckit:getState')
      ipcMain.handle('duckit:getState', async () => ({ ok: true, value: state }))
    }, syncedState)

    // Synthetic transport events exercise an instant completion and error without
    // connecting CI to a real private repository. Sync transport has separate tests.
    const send = async (statuses: Status[]) =>
      app.evaluate(({ BrowserWindow }, values) => {
        const window = BrowserWindow.getAllWindows()[0]!
        for (const status of values) window.webContents.send('duckit:status', status)
      }, statuses)
    await send([
      { ...initial.status, remote: 'syncing', message: 'Checking private GitHub history' },
    ])
    await expect(indicator).toHaveAttribute('data-phase', 'running')
    await expect(indicator).toHaveText('Syncing…')
    await send([
      { ...initial.status, remote: 'synced', message: 'Synthetic sync complete' },
      { ...initial.status, remote: 'syncing', message: 'Checking private GitHub history' },
      { ...initial.status, remote: 'synced', message: 'Synthetic sync complete' },
    ])
    await expect(indicator).toHaveText('Synced just now')
    await page.waitForTimeout(700)
    await expect(indicator).toHaveText('Synced just now')
    await expect(indicator).toHaveAttribute('data-phase', 'idle')

    const latest = await page.evaluate(async () => {
      const result = await window.duckit.getState()
      if (!result.ok) throw new Error(result.message)
      return result.value
    })
    await app.evaluate(({ ipcMain }, state) => {
      ipcMain.removeHandler('duckit:getState')
      ipcMain.handle('duckit:getState', async () => {
        await new Promise((resolve) => setTimeout(resolve, 450))
        return { ok: true, value: state }
      })
    }, latest)
    const refresh = () =>
      page.evaluate(() => {
        window.dispatchEvent(new Event('offline'))
        window.dispatchEvent(new Event('online'))
      })
    await refresh()
    await expect(indicator).toHaveText('Refreshing…')
    await expect(indicator).toHaveText('Refreshed just now')
    await expect(indicator).toHaveAttribute('data-phase', 'idle')
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('duckit:getState')
      ipcMain.handle('duckit:getState', async () => ({
        ok: false,
        code: 'io',
        message: 'Synthetic refresh failure',
      }))
    })
    await refresh()
    await expect(indicator).toHaveText('Refresh failed')
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()

    // Clear the synthetic refresh error and inspect both themes with ongoing sync.
    await app.evaluate(({ ipcMain }, state) => {
      ipcMain.removeHandler('duckit:getState')
      ipcMain.handle('duckit:getState', async () => ({ ok: true, value: state }))
    }, latest)
    await refresh()
    await send([
      { ...latest.status, remote: 'syncing', message: 'Checking private GitHub history' },
    ])
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
        theme,
      )
      for (const size of [
        { width: 960, height: 640 },
        { width: 1440, height: 940 },
      ]) {
        await page.setViewportSize(size)
        await page.screenshot({
          path: testInfo.outputPath(`activity-${theme}-${size.width}.png`),
          animations: 'disabled',
        })
        const box = await indicator.boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
      }
    }
    await send([
      {
        ...latest.status,
        remote: 'offline',
        message: 'Synthetic connection unavailable. Your budget is saved locally.',
      },
    ])
    await expect(indicator).toHaveText('Sync needs attention')
    await expect(page.locator('.save-status')).toContainText('Saved on this Mac')
    await expect(page.locator('.save-status')).toContainText('Synthetic connection unavailable')

    await send([{ ...latest.status, remote: 'disconnected', message: 'Saved on this Mac' }])
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(indicator).toHaveText('Refreshed just now')
    await page.getByRole('button', { name: 'Back up now', exact: true }).click()
    await expect(indicator).toHaveText('Backing up…')
    await expect(indicator).toHaveText('Backup checked', { timeout: 30000 })
    await expect(page.getByText('Backup verified and saved.', { exact: true })).toBeVisible()
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
