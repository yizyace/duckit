import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Status } from '../../src/shared/contracts'

test('keeps save, backup and synchronization explanations visible across views', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-status-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    const initial = await page.evaluate(() => window.duckit.getState())
    if (!initial.ok) throw new Error(initial.message)
    // Exercise presentation via actual status IPC. No disk/network failures are simulated here.
    const cases: { status: Status; localLabel: string }[] = [
      {
        status: {
          local: 'saving',
          remote: 'disconnected',
          message: 'Saving local changes.',
          lastBackup: null,
        },
        localLabel: 'Saving on this Mac…',
      },
      {
        status: {
          local: 'error',
          remote: 'disconnected',
          message: 'Local save failed. Your entries are still here.',
          lastBackup: null,
        },
        localLabel: 'Local save needs attention',
      },
      {
        status: {
          local: 'saved',
          remote: 'disconnected',
          message: 'Saved locally; checkpoint will be retried.',
          lastBackup: null,
        },
        localLabel: 'Saved on this Mac',
      },
      {
        status: {
          local: 'saved',
          remote: 'disconnected',
          message: 'Saved locally; backup destination is not writable.',
          lastBackup: null,
        },
        localLabel: 'Saved on this Mac',
      },
      {
        status: {
          local: 'saved',
          remote: 'offline',
          message: 'Repository privacy could not be verified. Upload stopped.',
          lastBackup: null,
        },
        localLabel: 'Saved on this Mac',
      },
      {
        status: {
          local: 'saved',
          remote: 'conflict',
          message: 'Review both changed budgets in Settings.',
          lastBackup: null,
        },
        localLabel: 'Saved on this Mac',
      },
      {
        status: {
          local: 'saved',
          remote: 'synced',
          message: 'Remote history verified.',
          lastBackup: null,
        },
        localLabel: 'Saved on this Mac',
      },
    ]
    for (const route of ['Budget', 'All accounts', 'Reports', 'Settings']) {
      await page.getByRole('button', { name: route, exact: true }).click()
      for (const { status, localLabel } of cases) {
        await app.evaluate(
          ({ ipcMain, BrowserWindow }, value) => {
            ipcMain.removeHandler('duckit:getState')
            ipcMain.handle('duckit:getState', () => ({ ok: true, value }))
            BrowserWindow.getAllWindows()[0]!.webContents.send('duckit:status', value.status)
          },
          { ...initial.value, status },
        )
        const summary = page.locator('.save-status')
        await expect(summary).toHaveAttribute('role', 'status')
        await expect(summary).toHaveAttribute('aria-live', 'polite')
        await expect(summary).toContainText(localLabel)
        await expect(summary.getByText(status.message, { exact: true })).toBeVisible()
      }
    }
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
