import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Change } from '../../src/shared/contracts'
import { chooseMonth } from './month-picker'

test.setTimeout(120000)
test('reports explore all months, exact amounts, series and category refunds in both themes', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-report-charts-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const state = await window.duckit.getState()
      if (!state.ok || !state.value.budget) throw Error('Missing synthetic budget')
      const budget = state.value.budget,
        template = budget.transactions[0]!
      const changes: Change[] = [
        { type: 'transaction.delete', ids: budget.transactions.map((row) => row.id) },
      ]
      for (let index = 0; index < 33; index++) {
        const month = `${2024 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
        for (const [suffix, amount, categoryId] of [
          ['income', String(350000 + index * 2000), null],
          ['groceries', String(-42000 - (index % 5) * 6000), 'cat-0'],
          ['rent', '-160000', 'cat-1'],
          ['transport', String(-12000 - (index % 3) * 3000), 'cat-2'],
        ] as const) {
          changes.push({
            type: 'transaction.put',
            value: {
              ...template,
              id: `${month}-${suffix}`,
              date: `${month}-01`,
              amount,
              splits: [
                {
                  id: `${month}-${suffix}-split`,
                  amount,
                  categoryId,
                  incomeMonth: categoryId ? null : month,
                  memo: '',
                },
              ],
            },
          })
        }
      }
      changes.push({
        type: 'transaction.put',
        value: {
          ...template,
          id: 'refund',
          date: '2026-09-01',
          amount: '12345',
          splits: [
            {
              id: 'refund-split',
              amount: '12345',
              categoryId: 'cat-5',
              incomeMonth: null,
              memo: '',
            },
          ],
        },
      })
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: budget.revision,
        changes,
      })
      if (!result.ok) throw Error(result.message)
    })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    await page.keyboard.press('Meta+3')
    await chooseMonth(page, 'From', '2024-01')
    await chooseMonth(page, 'Through', '2026-09')
    await expect(page.locator('[data-report-month]')).toHaveCount(33)
    await expect(
      page.getByRole('region', { name: 'Historical report' }).getByRole('row'),
    ).toHaveCount(34)
    await page.locator('[data-report-month="2024-01"] .report-hit-target').hover()
    await expect(page.getByTestId('report-point-details')).toContainText('January 2024')
    await page.getByLabel('Inspect month', { exact: true }).selectOption('2024-01')
    await expect(page.getByTestId('report-point-details')).toContainText('$3,500.00')
    await expect(page.getByTestId('report-point-details')).toContainText('$2,140.00')
    await page.getByRole('button', { name: 'Income', exact: true }).click()
    await expect(page.locator('svg rect.report-income')).toHaveCount(0)
    await expect(page.getByTestId('report-point-details')).not.toContainText('Income')
    await page.getByRole('button', { name: 'Spending', exact: true }).click()
    await expect(page.getByText('Choose Income or Spending to show a series.')).toBeVisible()
    await page.getByRole('button', { name: 'Income', exact: true }).click()
    await page.getByRole('button', { name: 'Spending', exact: true }).click()
    await page.getByRole('button', { name: 'Net worth', exact: true }).click()
    await expect(page.locator('.report-worth-line')).toHaveCount(1)
    await expect(page.getByTestId('report-point-details')).toContainText('$1,360.00')
    await page.getByRole('button', { name: 'Spending by category', exact: true }).click()
    await page.getByLabel('Filter categories').fill('Travel')
    await expect(page.locator('.report-category-row')).toHaveCount(1)
    await expect(page.locator('.report-category-row')).toContainText('−$123.45')
    await page.locator('.report-category-row').click()
    await expect(page.getByRole('heading', { name: 'Travel over time' })).toBeVisible()
    await expect(page.locator('.report-category-trend svg rect.report-income')).toHaveCount(0)
    await page.getByLabel('Inspect month', { exact: true }).selectOption('2026-09')
    await expect(page.getByTestId('report-point-details')).toContainText('−$123.45')
    await page.getByRole('button', { name: 'Close category' }).click()
    await page.getByLabel('Filter categories').fill('not-a-category')
    await expect(
      page.getByText('No matching categories with spending in this period.'),
    ).toBeVisible()
    await page.getByLabel('Filter categories').fill('')
    await page.getByRole('button', { name: 'Last 12 months', exact: true }).click()
    await page.getByRole('button', { name: 'Income & spending', exact: true }).click()
    await expect(page.locator('[data-report-month]')).toHaveCount(12)
    await page.getByRole('button', { name: 'Last 6 months', exact: true }).click()
    await expect(page.locator('[data-report-month]')).toHaveCount(6)
    await chooseMonth(page, 'From', '2026-04')
    await chooseMonth(page, 'Through', '2026-09')
    for (const [width, height] of [
      [960, 640],
      [1440, 940],
    ] as const) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        const toggle = page.getByRole('button', { name: `Use ${theme} theme` })
        if (await toggle.count()) await toggle.click()
        for (const [name, file] of [
          ['Income & spending', 'income'],
          ['Net worth', 'worth'],
          ['Spending by category', 'categories'],
        ] as const) {
          await page.getByRole('button', { name, exact: true }).click()
          await page.locator('.report-visual-panel').scrollIntoViewIfNeeded()
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true)
          await page.screenshot({
            path: info.outputPath(`reports-${file}-${theme}-${width}.png`),
            animations: 'disabled',
          })
        }
      }
    }
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
