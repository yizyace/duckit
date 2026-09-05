import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
test.setTimeout(120000)
test('previews, cancels, matches and retries a statement without losing legitimate repeats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'duckit-import-e2e-')),
    file = join(root, 'statement.csv')
  await writeFile(
    file,
    'Date,Payee,Amount,FITID\n2026-09-04,Neighborhood Market,-86.42,bank-groceries\n2026-09-05,Repeated cafe,-12.34,cafe-one\n2026-09-05,Repeated cafe,-12.34,cafe-two\n',
  )
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, file)
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'All accounts', exact: true }).click()
    await page.getByLabel('Account filter').selectOption('checking')
    const state = () =>
      page.evaluate(async () => {
        const r = await window.duckit.getState()
        if (!r.ok || !r.value.budget) throw Error('No budget')
        return r.value
      })
    const before = await state()
    await page.getByRole('button', { name: 'Import statement', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import approved transactions' })).toBeDisabled()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await state()).budget!.transactions).toEqual(before.budget!.transactions)
    await page.getByRole('button', { name: 'Import statement', exact: true }).click()
    await page.getByRole('radio', { name: /Match 2026-09-03/ }).check()
    await page.getByRole('button', { name: 'Import approved transactions' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const imported = await state(),
      grocery = imported.budget!.transactions.find((t) => t.id === 'groceries')!
    expect(grocery.bankId).toBe('bank-groceries')
    expect(grocery.cleared).toBe('cleared')
    expect(grocery.splits[0]!.categoryId).toBe('cat-0')
    expect(imported.budget!.transactions).toHaveLength(4)
    await page.getByRole('button', { name: 'All accounts', exact: true }).click()
    await page.getByLabel('Account filter').selectOption('checking')
    await page.getByRole('button', { name: 'Import statement', exact: true }).click()
    await page.getByRole('button', { name: 'Import approved transactions' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await state()).budget!.revision).toBe(imported.budget!.revision)
    await page.getByRole('button', { name: 'Undo last change' }).click()
    await expect.poll(async () => (await state()).budget!.transactions.length).toBe(2)
    expect((await state()).budget!.provenance).toHaveLength(0)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
