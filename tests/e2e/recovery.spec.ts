import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importArchive } from '../../src/main/recovery/archive'
import AxeBuilder from '@axe-core/playwright'
import type { Conflict } from '../../src/shared/contracts'

test.setTimeout(180000)

async function state(page: Page) {
  return page.evaluate(async () => {
    const result = await window.duckit.getState()
    if (!result.ok) throw new Error(result.message)
    return result.value
  })
}

test('creates an offline budget and completes pending local writes before clean quit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-onboarding-e2e-'))
  let app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '' },
  })
  try {
    let page = await app.firstWindow()
    await page.getByLabel('Budget name', { exact: true }).fill('Synthetic offline budget')
    await page.getByLabel('Currency', { exact: true }).fill('EUR')
    await page.getByRole('button', { name: 'Create a budget', exact: true }).click()
    await expect.poll(async () => (await state(page)).budget?.name).toBe('Synthetic offline budget')
    expect((await state(page)).status.remote).toBe('disconnected')
    expect((await state(page)).budget?.currency).toBe('EUR')
    await page.evaluate(async () => {
      const current = await window.duckit.getState()
      if (!current.ok || !current.value.budget) throw new Error('Missing synthetic budget')
      const revision = current.value.budget.revision
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = window.duckit.onStatus((status) => {
          if (status.local === 'saving') {
            unsubscribe()
            resolve()
          }
        })
        void window.duckit
          .command({
            id: crypto.randomUUID(),
            expectedRevision: revision,
            changes: [
              {
                type: 'account.put',
                value: {
                  id: 'offline-checking',
                  name: 'Offline checking',
                  type: 'checking',
                  onBudget: true,
                  closed: false,
                  note: 'Persist after quit',
                  legacyId: null,
                },
              },
            ],
          })
          .then((result) => {
            if (!result.ok) {
              unsubscribe()
              reject(new Error(result.message))
            }
          }, reject)
      })
    })
    await app.close()
    app = await electron.launch({
      args: ['.'],
      env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '' },
    })
    page = await app.firstWindow()
    await expect
      .poll(async () => (await state(page)).budget?.accounts[0]?.note)
      .toBe('Persist after quit')
    const backups = await page.evaluate(() => window.duckit.listBackups())
    expect(backups.ok && backups.value.length).toBeGreaterThan(0)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('exports, cancels import, restores a verified backup and activates a currency relabelled archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-recovery-e2e-'))
  const archivePath = join(root, 'synthetic.duckit')
  const backupPath = join(root, 'chosen-backups')
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.archivePath })
        dialog.showOpenDialog = async (...args: unknown[]) => ({
          canceled: false,
          filePaths: [
            (args.at(-1) as { properties?: string[] }).properties?.includes('openDirectory')
              ? paths.backupPath
              : paths.archivePath,
          ],
        })
      },
      { archivePath, backupPath },
    )
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const original = (await state(page)).budget!
    await page.getByRole('button', { name: 'Export Duckit archive', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Your Duckit archive was exported.' }),
    ).toBeVisible()
    const exported = importArchive(await readFile(archivePath))
    expect(exported.transactions).toEqual(original.transactions)
    expect(exported.accounts).toEqual(original.accounts)

    await page.getByRole('button', { name: 'Import Duckit archive', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Review budget import' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await state(page)).budget).toEqual(original)

    await page.getByRole('button', { name: 'Choose backup folder', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Backup destination updated and verified.' }),
    ).toBeVisible()
    const available = await page.evaluate(() => window.duckit.listBackups())
    if (!available.ok) throw new Error(available.message)
    expect(available.value).toHaveLength(1)
    await page.evaluate(async () => {
      const current = await window.duckit.getState()
      if (!current.ok || !current.value.budget) throw new Error('Missing synthetic budget')
      const account = current.value.budget.accounts.find((row) => row.id === 'checking')!
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: current.value.budget.revision,
        changes: [
          { type: 'account.put', value: { ...account, note: 'Synthetic post-backup edit' } },
        ],
      })
      if (!result.ok) throw new Error(result.message)
    })
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page
      .getByRole('button', { name: /^Restore backup from/ })
      .first()
      .click()
    await page.evaluate(async () => {
      const current = await window.duckit.getState()
      if (!current.ok || !current.value.budget) throw new Error('Missing synthetic budget')
      const account = current.value.budget.accounts.find((row) => row.id === 'checking')!
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: current.value.budget.revision,
        changes: [
          { type: 'account.put', value: { ...account, note: 'Edit after restore review' } },
        ],
      })
      if (!result.ok) throw new Error(result.message)
    })
    await page.getByRole('button', { name: 'Restore verified backup', exact: true }).click()
    const restoreDialog = page.getByRole('dialog', { name: 'Restore this backup?' })
    await expect(restoreDialog.getByRole('alert')).toContainText('review the latest budget')
    expect((await state(page)).budget?.accounts.find((a) => a.id === 'checking')?.note).toBe(
      'Edit after restore review',
    )
    await restoreDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page
      .getByRole('button', { name: /^Restore backup from/ })
      .first()
      .click()
    await page.getByRole('button', { name: 'Restore verified backup', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.getByRole('status').filter({ hasText: 'Backup restored and validated.' }),
    ).toBeVisible()
    expect((await state(page)).budget?.accounts).toEqual(original.accounts)
    expect((await state(page)).budget?.transactions).toEqual(original.transactions)

    await page.getByRole('button', { name: 'Import Duckit archive', exact: true }).click()
    await page.getByLabel('Currency', { exact: true }).fill('EUR')
    await page.getByRole('button', { name: 'Activate imported budget', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const imported = await state(page)
    expect(imported.budget?.currency).toBe('EUR')
    expect(imported.budget?.transactions).toEqual(original.transactions)
    expect(imported.status.remote).toBe('disconnected')
    expect(errors).toEqual([])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('reviews complete conflict details and refreshes a stale choice without an automatic retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-conflict-review-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    const original = (await state(page)).budget!
    const local = structuredClone(original)
    const remote = structuredClone(original)
    const localPurchase = local.transactions.find((t) => t.id === 'groceries')!
    localPurchase.cleared = 'reconciled'
    localPurchase.bankId = 'synthetic-bank-reference'
    localPurchase.splits[0]!.memo = 'Weekly produce'
    remote.transactions.find((t) => t.id === 'groceries')!.splits[0]!.categoryId = 'cat-3'
    local.schedules.push({
      id: 'synthetic-schedule',
      frequency: 'monthly',
      nextDate: '2026-10-03',
      endDate: '2026-12-03',
      enabled: true,
      transaction: {
        ...structuredClone(localPurchase),
        id: 'synthetic-template',
        cleared: 'uncleared',
        bankId: null,
        splits: [{ ...localPurchase.splits[0]!, id: 'synthetic-template-split' }],
      },
    })
    local.allocations[0]!.overspending = 'Confined'
    // A long unbroken reference makes overflow independent of platform font metrics.
    local.allocations[0]!.note = `Synthetic carryover choice ${'SYNTHETIC_REFERENCE_'.repeat(12)}`
    const conflict: Conflict = {
      localRevision: 'synthetic-local-v1',
      remoteRevision: 'synthetic-remote-v1',
      local,
      remote,
    }
    await app.evaluate(({ ipcMain }, review) => {
      ipcMain.removeHandler('duckit:getConflict')
      ipcMain.handle('duckit:getConflict', () => ({ ok: true, value: review }))
      ipcMain.removeHandler('duckit:resolveConflict')
      ipcMain.handle('duckit:resolveConflict', (_event, input) => {
        const scope = globalThis as { duckitReviewChoices?: unknown[] }
        scope.duckitReviewChoices ??= []
        scope.duckitReviewChoices.push(input)
        review.localRevision = 'synthetic-local-v2'
        review.local.payees.push({
          id: 'added-after-review',
          name: 'Added after review',
          legacyId: null,
        })
        return { ok: false, code: 'stale', message: 'Snapshot changed; review both budgets again.' }
      })
    }, conflict)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const mac = page
      .locator('.conflict-snapshot')
      .filter({ has: page.getByRole('heading', { name: 'This Mac', exact: true }) })
    const github = page
      .locator('.conflict-snapshot')
      .filter({ has: page.getByRole('heading', { name: 'GitHub', exact: true }) })
    await mac.getByText('Review transactions', { exact: true }).click()
    await github.getByText('Review transactions', { exact: true }).click()
    const macPurchase = mac.getByRole('row').filter({ hasText: 'Neighborhood Market' })
    const githubPurchase = github.getByRole('row').filter({ hasText: 'Neighborhood Market' })
    await expect(macPurchase).toContainText('Groceries')
    await expect(githubPurchase).toContainText('Coffee & dining')
    await macPurchase.getByText('Full transaction', { exact: true }).click()
    await expect(macPurchase).toContainText('reconciled')
    await expect(macPurchase).toContainText('Weekly produce')
    await macPurchase.getByText('Transaction references', { exact: true }).click()
    await expect(macPurchase).toContainText('synthetic-bank-reference')
    await mac.getByText('Recurring transactions (1)', { exact: true }).click()
    await expect(
      mac.getByRole('heading', { name: 'Enabled · monthly · Next 2026-10-03' }),
    ).toBeVisible()
    await expect(mac.getByText('Ends 2026-12-03', { exact: true })).toBeVisible()
    await mac.getByText('Review every allocation', { exact: true }).click()
    await expect(
      mac.getByRole('row').filter({ hasText: 'Synthetic carryover choice' }),
    ).toContainText('Carry deficits')
    const allocationRegion = mac.getByRole('region', { name: 'This Mac snapshot allocations' })
    await expect
      .poll(() => allocationRegion.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeGreaterThan(200)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.show()
      window.focus()
    })
    await mac.getByText('Review every allocation', { exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(allocationRegion).toBeFocused()
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => allocationRegion.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0)
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => allocationRegion.evaluate((element) => element.scrollLeft)).toBe(0)
    const audit = await new AxeBuilder({ page }).setLegacyMode(true).analyze()
    expect(audit.violations).toEqual([])
    await page.screenshot({ path: join(tmpdir(), 'duckit-conflict-review.png'), fullPage: true })
    await mac.getByRole('button', { name: 'Use complete Mac budget', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('review both budgets again')
    await expect(mac.getByText('Revision synthetic-local-v2', { exact: true })).toBeVisible()
    const choices = await app.evaluate(
      () => (globalThis as { duckitReviewChoices?: unknown[] }).duckitReviewChoices,
    )
    expect(choices).toEqual([
      {
        choice: 'local',
        localRevision: 'synthetic-local-v1',
        remoteRevision: 'synthetic-remote-v1',
      },
    ])
    expect((await state(page)).budget).toEqual(original)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
