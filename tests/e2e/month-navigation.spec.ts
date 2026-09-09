import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseMonth } from './month-picker'
import { currentMonth, monthLabel } from '../../src/renderer/src/views/format'
import { visibleMonthsKey } from '../../src/renderer/src/lib/budget-navigation'

test.setTimeout(120000)
test('month chooser handles year drafts, bounds, session navigation and local count persistence', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-month-navigation-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    await chooseMonth(page, 'Budget months', '2026-12')
    const trigger = page.getByRole('button', { name: /^Budget months:/ })
    await expect(trigger).toContainText('December 2026 – February 2027')
    await page.getByRole('button', { name: 'Next', exact: true }).click()
    await expect(trigger).toContainText('January 2027 – March 2027')
    await page.getByRole('button', { name: 'Previous', exact: true }).click()
    await expect(trigger).toContainText('December 2026 – February 2027')
    await trigger.click()
    const chooser = page.getByRole('dialog', { name: 'Choose budget months' })
    await expect(chooser.locator('.month-picker-grid button')).toHaveCount(12)
    await chooser.getByRole('button', { name: 'Next year' }).click()
    await expect(chooser.getByLabel('Year', { exact: true })).toHaveValue('2027')
    await chooser.getByRole('button', { name: 'Previous year' }).click()
    await expect(chooser.getByLabel('Year', { exact: true })).toHaveValue('2026')
    await chooser.getByLabel('Year', { exact: true }).fill('99999')
    await expect(chooser.getByText('Enter a year from 1 to 9999.')).toBeVisible()
    await expect(chooser.getByRole('button', { name: 'January', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(trigger).toContainText('December 2026 – February 2027')
    await trigger.click()
    await expect(chooser.getByLabel('Year', { exact: true })).toHaveValue('2026')
    await chooser.getByLabel('Year', { exact: true }).fill('1990')
    await chooser.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(trigger).toContainText('December 2026 – February 2027')
    await trigger.click()
    await chooser.getByLabel('Year', { exact: true }).fill('1980')
    await page.getByRole('heading', { name: 'Budget', exact: true }).click()
    await expect(chooser).toHaveCount(0)
    await expect(trigger).toContainText('December 2026 – February 2027')
    await chooseMonth(page, 'Budget months', '0001-01')
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
    await trigger.click()
    await expect(chooser.getByRole('button', { name: 'Previous year' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await chooseMonth(page, 'Budget months', '9999-12')
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
    await expect(
      page.getByText('The calendar ends at December 9999. Showing 1 month.'),
    ).toBeVisible()
    await trigger.click()
    await expect(chooser.getByRole('button', { name: 'Next year' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await chooseMonth(page, 'Budget months', '2026-09')
    await page.getByRole('button', { name: '2 months', exact: true }).click()
    await page.keyboard.press('Meta+3')
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible()
    await page.keyboard.press('Meta+1')
    await expect(trigger).toContainText('September 2026 – October 2026')
    await expect(page.getByRole('button', { name: '2 months', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const budgetId = await page.evaluate(async () => {
      const result = await window.duckit.getState()
      if (!result.ok || !result.value.budget) throw Error('Missing synthetic budget')
      return result.value.budget.id
    })
    expect(
      await page.evaluate((key) => localStorage.getItem(key), visibleMonthsKey(budgetId)),
    ).toBe('2')
    await page.reload()
    await expect(trigger).toContainText(monthLabel(currentMonth()))
    await expect(page.getByRole('button', { name: '2 months', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await chooseMonth(page, 'Budget months', '2026-09')
    await page.getByRole('button', { name: 'This month', exact: true }).click()
    await expect(trigger).toContainText(monthLabel(currentMonth()))
    await page.getByRole('button', { name: '3 months', exact: true }).click()
    await page.setViewportSize({ width: 960, height: 640 })
    const region = page.getByRole('region', {
      name: 'Budget grid; scroll horizontally for more months',
    })
    const category = region.getByRole('button', { name: 'Groceries', exact: true })
    const before = await category.boundingBox()
    await region.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
    })
    const after = await category.boundingBox()
    expect(before && after).toBeTruthy()
    expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1)
    for (const [width, height] of [
      [960, 640],
      [1440, 940],
    ] as const) {
      await page.setViewportSize({ width, height })
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
        .toEqual([width, height])
      for (const theme of ['light', 'dark']) {
        const themeButton = page.getByRole('button', { name: `Use ${theme} theme` })
        if (await themeButton.count()) await themeButton.click()
        await trigger.click()
        await expect(async () => {
          const bounds = await chooser.boundingBox()
          const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
          expect(bounds).not.toBeNull()
          expect(bounds!.x).toBeGreaterThanOrEqual(0)
          expect(bounds!.y).toBeGreaterThanOrEqual(0)
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
        }).toPass({ timeout: 5000 })
        expect(await chooser.evaluate((element) => !element.closest('.page-stack'))).toBe(true)
        await page.screenshot({ path: info.outputPath(`month-picker-${theme}-${width}.png`) })
        await page.keyboard.press('Escape')
      }
    }
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('reports reuse the chooser and preserve reversed and 600-month range limits', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-report-months-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 960, height: 640 })
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    await page.keyboard.press('Meta+3')
    await chooseMonth(page, 'From', '2026-12')
    await chooseMonth(page, 'Through', '2027-01')
    const region = page.getByRole('region', { name: 'Historical report' })
    await expect(region.getByRole('row')).toHaveCount(3)
    await expect(region).toContainText('December 2026')
    await expect(region).toContainText('January 2027')
    await chooseMonth(page, 'From', '2027-02')
    await expect(page.getByRole('alert')).toHaveText('Start month must be before the end month.')
    await chooseMonth(page, 'From', '1977-02')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(region.getByRole('row')).toHaveCount(601)
    await chooseMonth(page, 'From', '1977-01')
    await expect(page.getByRole('alert')).toHaveText('Choose at most 600 months per report.')
    await chooseMonth(page, 'Through', '0001-01')
    await chooseMonth(page, 'From', '0001-01')
    await expect(region).toContainText('January 0001')
    await chooseMonth(page, 'From', '9999-12')
    await chooseMonth(page, 'Through', '9999-12')
    await expect(region).toContainText('December 9999')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: /^Through:/ }).click()
    const chooser = page.getByRole('dialog', { name: 'Choose through' })
    await expect(async () => {
      const bounds = await chooser.boundingBox()
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      expect(bounds).not.toBeNull()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.y).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)
    }).toPass({ timeout: 5000 })
    await page.screenshot({ path: info.outputPath('report-month-picker-960.png') })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
