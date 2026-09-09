import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Change } from '../../src/shared/contracts'

test.setTimeout(120000)

async function launch() {
  const root = await mkdtemp(join(tmpdir(), 'duckit-sidebar-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
  return {
    app,
    page,
    close: async () => {
      await app.close()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    },
  }
}

const balance = (page: Page, id: string) =>
  page.locator(`[data-account-id="${id}"] .account-balance`)

async function drag(page: Page, delta: number) {
  const box = (await page.getByRole('separator', { name: 'Resize sidebar' }).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 160)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + 160, { steps: 12 })
  await page.mouse.up()
}

const width = (page: Page) =>
  page.locator('.app-sidebar').evaluate((element) => element.getBoundingClientRect().width)

test('shows exact working balances and refreshes historical edits, undo, redo and local midnight', async () => {
  const session = await launch()
  const { page } = session
  try {
    const midnight = await page.evaluate(() => new Date(2026, 8, 8, 23, 59, 58).getTime())
    await page.clock.install({ time: midnight - 12 * 60 * 60 * 1000 })
    await page.evaluate(async () => {
      const result = await window.duckit.getState()
      if (!result.ok || !result.value.budget) throw new Error('Missing synthetic budget')
      const b = result.value.budget
      const template = b.transactions[0]!
      const transaction = (
        id: string,
        amount: string,
        accountId = 'checking',
        date = '2026-09-08',
      ) => ({
        ...template,
        id,
        date,
        accountId,
        amount,
        cleared: 'uncleared' as const,
        splits: [{ id: `${id}-split`, amount, categoryId: 'cat-0', incomeMonth: null, memo: '' }],
      })
      const changes: Change[] = [
        { type: 'transaction.delete', ids: b.transactions.map((row) => row.id) },
        {
          type: 'account.put',
          value: {
            ...b.accounts[0]!,
            name: 'Household everyday checking with a deliberately long uninterruptednameforwrapping',
          },
        },
        {
          type: 'account.put',
          value: { ...b.accounts[1]!, id: 'negative', name: 'Credit balance', type: 'credit' },
        },
        { type: 'transaction.put', value: transaction('huge', '900719925474099300001') },
        { type: 'transaction.put', value: transaction('negative', '-12345', 'negative') },
        {
          type: 'transaction.put',
          value: transaction('future', '-10000', 'checking', '2026-09-09'),
        },
        {
          type: 'schedule.put',
          value: {
            id: 'unposted',
            nextDate: '2026-09-09',
            frequency: 'monthly',
            endDate: null,
            transaction: transaction('unposted-template', '-99900', 'checking', '2026-09-09'),
            enabled: true,
          },
        },
      ]
      for (const [id, amount] of [
        ['transfer-out', '-500'],
        ['transfer-in', '500'],
      ]) {
        changes.push(
          {
            type: 'account.put',
            value: { ...b.accounts[1]!, id: id!, name: id!, onBudget: false, closed: true },
          },
          {
            type: 'transaction.put',
            value: {
              ...transaction(id!, amount!, id!),
              transferId: 'sidebar-transfer',
              cleared: 'reconciled',
              splits: [
                {
                  id: `${id}-split`,
                  amount: amount!,
                  categoryId: null,
                  incomeMonth: null,
                  memo: '',
                },
              ],
            },
          },
        )
      }
      const saved = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: b.revision,
        changes,
      })
      if (!saved.ok) throw new Error(saved.message)
    })
    await page.reload()
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(balance(page, 'checking')).toHaveText('USD 9,007,199,254,740,993,000.01')
    await expect(balance(page, 'negative')).toHaveText('USD -123.45')
    await expect(balance(page, 'negative')).toHaveClass(/is-negative/)
    await expect(balance(page, 'savings')).toHaveText('USD 0.00')
    await expect(balance(page, 'savings')).toHaveClass(/is-zero/)
    await page.locator('.closed-accounts summary').click()
    await expect(balance(page, 'transfer-out')).toHaveText('USD -5.00')
    await expect(balance(page, 'transfer-in')).toHaveText('USD 5.00')

    await page.locator('[data-account-id="checking"]').click()
    await expect(page.locator('.stat-card').first()).toContainText(
      'USD 9,007,199,254,740,993,000.01',
    )
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
    await page.getByLabel('Date', { exact: true }).fill('2026-09-01')
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('-1.23')
    await page.getByLabel('Category or income', { exact: true }).selectOption('category:cat-0')
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(balance(page, 'checking')).toHaveText('USD 9,007,199,254,740,992,998.78')
    await page.getByRole('button', { name: 'Undo last change' }).click()
    await expect(balance(page, 'checking')).toHaveText('USD 9,007,199,254,740,993,000.01')
    await page.getByRole('button', { name: 'Redo last change' }).click()
    await expect(balance(page, 'checking')).toHaveText('USD 9,007,199,254,740,992,998.78')
    await page.getByRole('button', { name: 'Undo last change' }).click()
    await expect(balance(page, 'checking')).toHaveText('USD 9,007,199,254,740,993,000.01')
    await page.clock.setSystemTime(midnight)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.clock.runFor(3000)
    await expect(balance(page, 'checking')).toHaveText('USD 9,007,199,254,740,992,900.01')
    await expect(page.locator('.stat-card').first()).toContainText(
      'USD 9,007,199,254,740,992,900.01',
    )
  } finally {
    await session.close()
  }
})

test('resizes within limits, preserves local preference and keeps full labels in both themes', async ({}, info) => {
  const session = await launch()
  const { page } = session
  try {
    await page.evaluate(async () => {
      const state = await window.duckit.getState()
      if (!state.ok || !state.value.budget) throw new Error('Missing synthetic budget')
      const b = state.value.budget
      const source = b.transactions[0]!
      const amount = '900719925474099300001'
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: b.revision,
        changes: [
          {
            type: 'account.put',
            value: {
              ...b.accounts[0]!,
              name: 'Household checking with a deliberately long uninterruptednameforwrapping',
            },
          },
          {
            type: 'transaction.put',
            value: { ...source, amount, splits: [{ ...source.splits[0]!, amount }] },
          },
        ],
      })
      if (!result.ok) throw new Error(result.message)
      localStorage.removeItem('duckit.sidebarWidth')
    })
    await page.reload()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect.poll(() => width(page)).toBe(320)
    await drag(page, 500)
    await expect.poll(() => width(page)).toBe(480)
    await page.setViewportSize({ width: 1000, height: 760 })
    await expect.poll(() => width(page)).toBe(400)
    await page.setViewportSize({ width: 700, height: 760 })
    await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('duckit.sidebarWidth'))).toBe('480')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await expect.poll(() => width(page)).toBe(480)
    await page.reload()
    await expect.poll(() => width(page)).toBe(480)
    await drag(page, -900)
    await expect.poll(() => width(page)).toBe(240)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
        theme,
      )
      for (const size of [240, 480]) {
        await drag(page, size === 240 ? -500 : 500)
        const visibility = await page
          .locator('[data-account-id="checking"]')
          .evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            return Array.from(element.querySelectorAll('.account-name, .account-balance')).every(
              (label) => {
                const rect = label.getBoundingClientRect()
                return (
                  label.scrollWidth <= label.clientWidth + 1 &&
                  rect.right <= bounds.right &&
                  rect.left >= bounds.left &&
                  rect.bottom <= bounds.bottom
                )
              },
            )
          })
        expect(visibility).toBe(true)
        await page.screenshot({ path: info.outputPath(`sidebar-${theme}-${size}.png`) })
      }
    }
    await page.getByRole('separator', { name: 'Resize sidebar' }).dblclick()
    await expect.poll(() => width(page)).toBe(320)
    await page.reload()
    await expect.poll(() => width(page)).toBe(320)
  } finally {
    await session.close()
  }
})

test('does not rescan a 20000-entry ledger while resizing or switching register accounts', async () => {
  const session = await launch()
  const { page, app } = session
  try {
    const result = await page.evaluate(() => window.duckit.getState())
    if (!result.ok || !result.value.budget) throw new Error('Missing synthetic budget')
    const state = result.value
    const template = state.budget!.transactions[0]!
    state.budget!.transactions = Array.from({ length: 20000 }, (_, index) => ({
      ...template,
      id: `large-${index}`,
      amount: '123',
      splits: [{ ...template.splits[0]!, id: `large-split-${index}`, amount: '123' }],
    }))
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('duckit:getState')
      ipcMain.handle('duckit:getState', () => ({ ok: true, value }))
    }, state)
    await page.reload()
    await page.locator('[data-account-id="checking"]').click()
    await expect(balance(page, 'checking')).toHaveText('USD 24,600.00')
    await expect(page.locator('.stat-card').first()).toContainText('USD 24,600.00')
    await page.evaluate(() => {
      Object.defineProperty(window, '__sidebarBigIntCalls', { value: 0, writable: true })
      window.BigInt = new Proxy(window.BigInt, {
        apply(target, thisArg, args) {
          const counts = window as unknown as { __sidebarBigIntCalls: number }
          counts.__sidebarBigIntCalls++
          return Reflect.apply(target, thisArg, args)
        },
      })
    })
    await drag(page, 100)
    await drag(page, -100)
    expect(
      await page.evaluate(
        () => (window as unknown as { __sidebarBigIntCalls: number }).__sidebarBigIntCalls,
      ),
    ).toBe(0)
    await page.locator('[data-account-id="savings"]').click()
    await expect(page.locator('.stat-card').first()).toContainText('USD 0.00')
    await page.locator('[data-account-id="checking"]').click()
    await expect(page.locator('.stat-card').first()).toContainText('USD 24,600.00')
    expect(
      await page.evaluate(
        () => (window as unknown as { __sidebarBigIntCalls: number }).__sidebarBigIntCalls,
      ),
      // Repainting the small set of virtualized rows formats their amounts again.
      // A single full ledger scan would require at least 20,000 conversions.
    ).toBeLessThan(1000)
  } finally {
    await session.close()
  }
})
