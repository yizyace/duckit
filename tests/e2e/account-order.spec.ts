import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.setTimeout(120000)
const ids = (page: Page) =>
  page
    .getByRole('list', { name: 'Budget accounts', exact: true })
    .locator('[data-account-id]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-account-id')))
const account = (page: Page, id: string) => page.locator(`[data-account-id="${id}"]`)

async function move(page: Page, source: string, target: string, edge: 'before' | 'after') {
  const from = (await account(page, source).boundingBox())!,
    to = (await account(page, target).boundingBox())!
  await page.mouse.move(from.x + 20, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + 25, from.y + from.height / 2 + 8, { steps: 3 })
  await page.mouse.move(to.x + 30, to.y + (edge === 'before' ? 4 : to.height - 4), { steps: 8 })
  await page.mouse.up()
}

test('drags accounts up and down, saves positions, undoes and reopens without local preferences', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-account-order-'))
  let app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: 'Budget', exact: true })).toBeVisible()
    await page.evaluate(async () => {
      const state = await window.duckit.getState()
      if (!state.ok || !state.value.budget) throw new Error('Missing synthetic budget')
      const b = state.value.budget,
        { position: _, ...template } = b.accounts[0]!
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: b.revision,
        changes: [
          { type: 'account.put', value: { ...template, id: 'third', name: 'Travel cash' } },
          {
            type: 'account.put',
            value: { ...template, id: 'tracking', name: 'Investments', onBudget: false },
          },
        ],
      })
      if (!result.ok) throw new Error(result.message)
    })
    await page.reload()
    await expect.poll(() => ids(page)).toEqual(['checking', 'savings', 'third'])
    await account(page, 'checking').click()
    await move(page, 'third', 'checking', 'before')
    await expect.poll(() => ids(page)).toEqual(['third', 'checking', 'savings'])
    await expect(account(page, 'checking')).toHaveAttribute('aria-current', 'page')
    await move(page, 'third', 'savings', 'after')
    await expect.poll(() => ids(page)).toEqual(['checking', 'savings', 'third'])
    await page.getByRole('button', { name: 'Undo last change' }).click()
    await expect.poll(() => ids(page)).toEqual(['third', 'checking', 'savings'])
    await page.getByRole('button', { name: 'Redo last change' }).click()
    await expect.poll(() => ids(page)).toEqual(['checking', 'savings', 'third'])
    await move(page, 'savings', 'checking', 'before')
    await expect.poll(() => ids(page)).toEqual(['savings', 'checking', 'third'])
    const result = await page.evaluate(() => window.duckit.getState())
    expect(
      result.ok &&
        result.value.budget?.accounts
          .filter((a) => a.onBudget)
          .map((a) => [a.id, a.position])
          .sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      ['savings', 0],
      ['checking', 1],
      ['third', 2],
    ])
    await move(page, 'savings', 'tracking', 'before')
    await expect.poll(() => ids(page)).toEqual(['savings', 'checking', 'third'])
    await page.evaluate(() => localStorage.clear())
    await app.close()
    app = await electron.launch({
      args: ['.'],
      env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
    })
    page = await app.firstWindow()
    await expect.poll(() => ids(page)).toEqual(['savings', 'checking', 'third'])
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
        theme,
      )
      await page.setViewportSize({ width: 960, height: 640 })
      await page.screenshot({
        path: info.outputPath(`account-order-${theme}.png`),
        animations: 'disabled',
      })
    }
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('failed and stale reorder commands leave the saved order visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-account-reject-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect.poll(() => ids(page)).toEqual(['checking', 'savings'])
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('duckit:command')
      ipcMain.handle('duckit:command', () => ({
        ok: false,
        code: 'io',
        message: 'Synthetic write failed',
      }))
    })
    await move(page, 'savings', 'checking', 'before')
    await expect(page.getByRole('alert')).toContainText('Synthetic write failed')
    await expect.poll(() => ids(page)).toEqual(['checking', 'savings'])
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('duckit:command')
      ipcMain.handle('duckit:command', () => ({
        ok: false,
        code: 'stale',
        message: 'Synthetic stale order',
      }))
    })
    await move(page, 'savings', 'checking', 'before')
    await expect(page.getByRole('alert')).toContainText('Synthetic stale order')
    await expect.poll(() => ids(page)).toEqual(['checking', 'savings'])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
