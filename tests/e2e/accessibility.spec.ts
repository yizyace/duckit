import { test, expect, _electron as electron } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('exposes visible transaction text and selected-state contrast in both themes', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-a11y-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: 'All accounts', exact: true }).click()
    const edit = page.getByRole('button', { name: /^Edit 2026-09-01/ })
    await expect(edit).toContainText('September income')
    await expect(edit).toHaveAccessibleName(/Employer September income/)
    await page.getByLabel('Select all matching transactions').check()
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByRole('button', { name: 'Use dark theme' }).click()
      await expect(page.locator('tr[data-selected]')).toHaveCount(2)
      expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([])
      expect(
        (
          await new AxeBuilder({ page })
            .setLegacyMode(true)
            .withRules(['label-content-name-mismatch'])
            .analyze()
        ).violations,
      ).toEqual([])
      await page.screenshot({ path: info.outputPath(`selected-register-${theme}.png`) })
    }
    await edit.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(edit).toBeFocused()
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('contains budget labels while keeping the narrow grid keyboard-scrollable', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-reflow-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    // 320 CSS pixels also represents a desktop viewport under magnification.
    await page.setViewportSize({ width: 320, height: 900 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    const grid = page.getByRole('region', {
      name: 'Budget grid; scroll horizontally for more months',
    })
    expect(await grid.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!
      window.show()
      window.focus()
    })
    await grid.focus()
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await expect(grid).toBeFocused()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    await page.screenshot({ path: info.outputPath('budget-320.png') })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
