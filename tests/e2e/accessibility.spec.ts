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
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
    // Enter through the real tab order after native activation. Document focus
    // alone does not establish which element will receive the arrow key.
    await page.getByRole('button', { name: 'Category', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(grid).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await expect(grid).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect.poll(() => grid.evaluate((element) => element.scrollLeft)).toBe(0)
    await expect(grid).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(grid.getByRole('button').first()).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(grid).toBeFocused()

    // Synthetic self-arrows make removal of the handler a deterministic failure.
    // Exclusions do not assert what the browser's own control defaults should do.
    const { intercepted, handled } = await grid.evaluate((element) => {
      const original = element.scrollBy
      let calls = 0
      element.scrollBy = (...args: unknown[]) => {
        calls++
        Reflect.apply(original, element, args)
      }
      const input = document.createElement('input')
      element.append(input)
      const button = element.querySelector('button')!
      const cases: Array<{
        name: string
        target: Element
        init: KeyboardEventInit
        canceled?: boolean
      }> = [
        ...['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].map((modifier) => ({
          name: modifier,
          target: element,
          init: { key: 'ArrowRight', [modifier]: true },
        })),
        ...['Tab', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Escape'].map((key) => ({
          name: key,
          target: element,
          init: { key },
        })),
        { name: 'composing', target: element, init: { key: 'ArrowRight', isComposing: true } },
        { name: 'already canceled', target: element, init: { key: 'ArrowRight' }, canceled: true },
        { name: 'nested button', target: button, init: { key: 'ArrowRight' } },
        { name: 'nested input', target: input, init: { key: 'ArrowLeft' } },
      ]
      try {
        const intercepted = cases.flatMap(({ name, target, init, canceled }) => {
          const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
          if (canceled) event.preventDefault()
          const before = element.scrollLeft
          calls = 0
          target.dispatchEvent(event)
          return event.defaultPrevented !== Boolean(canceled) ||
            calls !== 0 ||
            element.scrollLeft !== before
            ? [
                {
                  name,
                  prevented: event.defaultPrevented,
                  calls,
                  before,
                  after: element.scrollLeft,
                },
              ]
            : []
        })
        const handled = ['ArrowRight', 'ArrowLeft'].map((key) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
          element.dispatchEvent(event)
          return { prevented: event.defaultPrevented, offset: element.scrollLeft }
        })
        return { intercepted, handled }
      } finally {
        element.scrollBy = original
        input.remove()
      }
    })
    expect(intercepted).toEqual([])
    expect(handled[0]!.prevented).toBe(true)
    expect(handled[0]!.offset).toBeGreaterThan(0)
    expect(handled[1]).toEqual({ prevented: true, offset: 0 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
    await page.screenshot({ path: info.outputPath('budget-320.png') })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
