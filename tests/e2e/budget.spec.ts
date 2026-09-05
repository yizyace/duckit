import { test, expect, _electron as electron } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test.setTimeout(120000)
test('budgets across months, preserves stale category edits, and reviews historical reports', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-budget-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    await page.getByLabel('First budget month').fill('2026-09')
    const opener = page.getByRole('button', { name: 'Budget Groceries 2026-09', exact: true })
    await opener.click()
    await page.getByLabel('Budgeted amount').fill('321.09')
    await page.getByLabel('If this category is overspent').selectOption('Confined')
    await page.getByRole('button', { name: 'Save budget', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(opener).toBeFocused()
    const state = await page.evaluate(() => window.duckit.getState())
    if (!state.ok) throw Error(state.message)
    expect(
      state.value.budget!.allocations.find((a) => a.month === '2026-09' && a.categoryId === 'cat-0')
        ?.amount,
    ).toBe('32109')
    await page.getByRole('button', { name: 'Category', exact: true }).click()
    await page.getByLabel('Name', { exact: true }).fill('Preserved category')
    await page.evaluate(async () => {
      const r = await window.duckit.getState()
      if (!r.ok || !r.value.budget) throw Error('No budget')
      const b = r.value.budget
      const x = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: b.revision,
        changes: [
          { type: 'account.put', value: { ...b.accounts[0]!, note: 'Concurrent test edit' } },
        ],
      })
      if (!x.ok) throw Error(x.message)
    })
    await page.getByRole('button', { name: 'Save category', exact: true }).click()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Preserved category')
    await page.getByRole('button', { name: 'Use latest revision for this edit' }).click()
    await page.getByRole('button', { name: 'Save category', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('budget-light.png'), animations: 'disabled' })
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: 'Use dark theme' }).click()
    await page.screenshot({ path: info.outputPath('budget-dark.png'), animations: 'disabled' })
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([])
    await page.keyboard.press('Meta+3')
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeFocused()
    await page.getByLabel('From', { exact: true }).fill('2026-08')
    await page.getByLabel('Through', { exact: true }).fill('2026-09')
    await expect(page.getByRole('region', { name: 'Historical report' })).toContainText(
      'September 2026',
    )
    await page.getByLabel('From', { exact: true }).fill('1900-01')
    await expect(page.getByRole('alert')).toHaveText('Choose at most 600 months per report.')
    await page.getByLabel('From', { exact: true }).fill('2026-08')
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
