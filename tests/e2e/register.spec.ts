import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.setTimeout(120000)

async function withDemo(run: (page: Page) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'duckit-register-e2e-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, DUCKIT_TEST_ROOT: root, DUCKIT_DEMO: '1' },
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: 'All accounts', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'All accounts', exact: true })).toBeVisible()
    await page.getByLabel('Account filter').selectOption('checking')
    await run(page)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

const budget = (page: Page) =>
  page.evaluate(async () => {
    const result = await window.duckit.getState()
    if (!result.ok || !result.value.budget) throw new Error('Expected a synthetic budget')
    return result.value.budget
  })

const closed = (page: Page) => page.getByRole('dialog').waitFor({ state: 'hidden' })

test('enters exact money, preserves stale fields, reconciles and undoes a bulk deletion', async () => {
  await withDemo(async (page) => {
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page.keyboard.press('Escape')
    await closed(page)
    await expect(page.getByRole('button', { name: 'Add transaction', exact: true })).toBeFocused()
    await page.keyboard.press('Meta+n')
    await page.getByLabel('Date', { exact: true }).fill('2026-09-04')
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('-12.34')
    await page.getByLabel('Payee', { exact: true }).selectOption('__new')
    await page.getByLabel('New payee name').fill('Synthetic QA Cafe')
    await page.getByLabel('Category or income', { exact: true }).selectOption('category:cat-0')
    await page.getByLabel('Cleared status').selectOption('cleared')
    await page.getByLabel('Memo', { exact: true }).fill('Synthetic payment')
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)
    const saved = (await budget(page)).transactions.find(
      (transaction) => transaction.memo === 'Synthetic payment',
    )!
    expect(saved.amount).toBe('-1234')
    expect(saved.payeeId).not.toBeNull()

    await page.keyboard.press('Meta+f')
    await expect(page.getByLabel('Search transactions')).toBeFocused()
    await page.getByLabel('Search transactions').fill('Synthetic payment')
    await page.getByRole('button', { name: /^Edit 2026-09-04/ }).click()
    await page.getByLabel('Memo', { exact: true }).fill('Preserved stale entry')
    await page.evaluate(async () => {
      const state = await window.duckit.getState()
      if (!state.ok || !state.value.budget) throw new Error('Missing demo budget')
      const current = state.value.budget
      const account = current.accounts.find((row) => row.id === 'checking')!
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: current.revision,
        changes: [
          { type: 'account.put', value: { ...account, note: 'Concurrent synthetic change' } },
        ],
      })
      if (!result.ok) throw new Error(result.message)
    })
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Use current revision and keep my entries' }),
    ).toBeEnabled()
    await expect(page.getByLabel('Memo', { exact: true })).toHaveValue('Preserved stale entry')
    await page.getByRole('button', { name: 'Use current revision and keep my entries' }).click()
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)
    expect(
      (await budget(page)).transactions.find((transaction) => transaction.id === saved.id)?.memo,
    ).toBe('Preserved stale entry')

    await page.getByRole('button', { name: 'Reconcile', exact: true }).click()
    await page.getByLabel('Statement date').fill('2026-09-30')
    await page.getByLabel('Statement balance').fill('4187.65')
    await expect(page.getByRole('button', { name: 'Finish reconciliation' })).toBeDisabled()
    await page.getByLabel('Statement balance').fill('4187.66')
    await page.getByRole('button', { name: 'Finish reconciliation' }).click()
    await closed(page)
    expect(
      (await budget(page)).transactions.find((transaction) => transaction.id === saved.id)?.cleared,
    ).toBe('reconciled')

    await page.getByLabel('Search transactions').fill('Preserved stale entry')
    await page.getByLabel('Select all matching transactions').check()
    await page.getByRole('button', { name: 'Categorize', exact: true }).click()
    await page.getByLabel('Category or income', { exact: true }).selectOption('category:cat-3')
    await page.getByRole('button', { name: 'Apply changes', exact: true }).click()
    await closed(page)
    expect(
      (await budget(page)).transactions.find((transaction) => transaction.id === saved.id)
        ?.splits[0]?.categoryId,
    ).toBe('cat-3')
    await page.getByLabel('Select all matching transactions').check()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('button', { name: 'Delete transactions', exact: true }).click()
    await closed(page)
    expect(
      (await budget(page)).transactions.some((transaction) => transaction.id === saved.id),
    ).toBe(false)
    await page.getByRole('button', { name: 'Undo last change' }).click()
    await expect
      .poll(async () =>
        (await budget(page)).transactions.some((transaction) => transaction.id === saved.id),
      )
      .toBe(true)
  })
})

test('keeps mixed transfers balanced and posts linked recurring schedules together', async () => {
  await withDemo(async (page) => {
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
    await page.getByLabel('Date', { exact: true }).fill('2026-09-04')
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('-15')
    await page.getByLabel('Transaction type').selectOption('split')
    await page.getByLabel('Split 1 amount').fill('-10')
    await page.getByLabel('Transfer to another account (optional)').selectOption('savings')
    await page.getByRole('button', { name: 'Add split', exact: true }).click()
    await page.getByLabel('Split 2 amount').fill('-5')
    await page
      .getByLabel('Category or income', { exact: true })
      .nth(1)
      .selectOption('category:cat-0')
    await page.getByLabel('Memo', { exact: true }).fill('Synthetic mixed transfer')
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)
    const current = await budget(page)
    const source = current.transactions.find(
      (transaction) =>
        transaction.accountId === 'checking' && transaction.memo === 'Synthetic mixed transfer',
    )!
    const partner = current.transactions.find(
      (transaction) =>
        transaction.transferId === source.splits.find((split) => split.transferId)?.transferId,
    )!
    expect(partner.amount).toBe('1000')
    expect(source.splits.find((split) => split.categoryId === 'cat-0')?.amount).toBe('-500')

    await page.getByLabel('Account filter').selectOption('savings')
    await page.getByLabel('Search transactions').fill('Synthetic mixed transfer')
    await page.getByRole('button', { name: /^Edit 2026-09-04/ }).click()
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('12')
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)
    const edited = await budget(page)
    expect(
      edited.transactions.find((transaction) => transaction.id === source.id)?.splits,
    ).toHaveLength(2)
    expect(edited.transactions.find((transaction) => transaction.id === source.id)?.amount).toBe(
      '-1700',
    )
    const editedPartner = edited.transactions.find((transaction) => transaction.id === partner.id)!
    expect(editedPartner.amount).toBe('1200')
    expect(
      edited.transactions.some(
        (transaction) =>
          transaction.id !== partner.id &&
          transaction.splits.some(
            (split) => split.transferId === editedPartner.transferId && split.amount === '-1200',
          ),
      ),
    ).toBe(true)

    await page.getByLabel('Account filter').selectOption('checking')
    await page.getByLabel('Search transactions').fill('')
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
    // Choose a past date so this remains a due-schedule test on later CI dates.
    await page.getByLabel('Date', { exact: true }).fill('2026-09-04')
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('-20')
    await page.getByLabel('Transaction type').selectOption('transfer')
    await page.getByLabel('Other transfer account').selectOption('savings')
    await page.getByLabel('Memo', { exact: true }).fill('Synthetic recurring transfer')
    await page.getByLabel('Save as a scheduled transaction').check()
    await page.getByLabel('End date (optional)').fill('2026-09-04')
    await page.getByRole('button', { name: 'Save schedule', exact: true }).click()
    await closed(page)
    expect((await budget(page)).schedules).toHaveLength(2)
    await page.getByRole('button', { name: 'Scheduled', exact: true }).click()
    await page.getByRole('button', { name: /^Edit schedule/ }).click()
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('-25')
    await page.getByRole('button', { name: 'Save schedule', exact: true }).click()
    await closed(page)
    expect(
      (await budget(page)).schedules.map((schedule) => schedule.transaction.amount).sort(),
    ).toEqual(['-2500', '2500'])
    await page.getByRole('button', { name: /^Post due schedules/ }).click()
    await page.getByRole('button', { name: 'Post all due transactions', exact: true }).click()
    await closed(page)
    const posted = (await budget(page)).transactions.filter(
      (transaction) => transaction.memo === 'Synthetic recurring transfer',
    )
    expect(posted).toHaveLength(2)
    expect(posted.reduce((sum, transaction) => sum + BigInt(transaction.amount), 0n)).toBe(0n)
    expect((await budget(page)).schedules.every((schedule) => !schedule.enabled)).toBe(true)
  })
})

test('preserves whole transfer identities and counterpart metadata while editing categorized splits', async () => {
  await withDemo(async (page) => {
    await page.evaluate(async () => {
      const current = await window.duckit.getState()
      if (!current.ok || !current.value.budget) throw new Error('Missing synthetic budget')
      const common = {
        date: '2026-09-04',
        payeeId: null,
        memo: 'Synthetic reviewed counterpart',
        cleared: 'reconciled' as const,
        transferId: 'reviewed-pair',
        bankId: null,
        legacyId: null,
      }
      const result = await window.duckit.command({
        id: crypto.randomUUID(),
        expectedRevision: current.value.budget.revision,
        changes: [
          {
            type: 'account.put',
            value: {
              id: 'review-tracking',
              name: 'Review tracking',
              type: 'asset',
              onBudget: false,
              closed: false,
              note: '',
              legacyId: null,
            },
          },
          {
            type: 'transaction.put',
            value: {
              ...common,
              id: 'reviewed-budget-side',
              accountId: 'checking',
              amount: '-3000',
              bankId: 'reviewed-bank-id',
              legacyId: 'reviewed-legacy-id',
              splits: [
                {
                  id: 'reviewed-food',
                  amount: '-1000',
                  categoryId: 'cat-0',
                  incomeMonth: null,
                  memo: 'Original grocery detail',
                },
                {
                  id: 'reviewed-dining',
                  amount: '-2000',
                  categoryId: 'cat-3',
                  incomeMonth: null,
                  memo: 'Original dining detail',
                },
              ],
            },
          },
          {
            type: 'transaction.put',
            value: {
              ...common,
              id: 'reviewed-tracking-side',
              accountId: 'review-tracking',
              amount: '3000',
              splits: [
                {
                  id: 'reviewed-tracking-split',
                  amount: '3000',
                  categoryId: null,
                  incomeMonth: null,
                  memo: 'Original tracking detail',
                },
              ],
            },
          },
        ],
      })
      if (!result.ok) throw new Error(result.message)
    })
    await page.reload()
    await page.getByRole('button', { name: 'All accounts', exact: true }).click()
    await page.getByLabel('Account filter').selectOption('review-tracking')
    const before = (await budget(page)).transactions.filter((row) => row.id.startsWith('reviewed-'))
    await page.getByRole('button', { name: /^Edit 2026-09-04/ }).click()
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)
    expect(
      (await budget(page)).transactions.filter((row) => row.id.startsWith('reviewed-')),
    ).toEqual(before)

    await page.getByRole('button', { name: /^Edit 2026-09-04/ }).click()
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('35')
    await page.getByLabel('Split 1 amount').fill('15')
    await page.getByLabel('Memo', { exact: true }).fill('Edited tracking memo')
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)
    const after = await budget(page)
    const counterpart = after.transactions.find((row) => row.id === 'reviewed-budget-side')!
    expect(counterpart).toMatchObject({
      amount: '-3500',
      cleared: 'reconciled',
      bankId: 'reviewed-bank-id',
      legacyId: 'reviewed-legacy-id',
      memo: 'Synthetic reviewed counterpart',
    })
    expect(counterpart.splits).toMatchObject([
      {
        id: 'reviewed-food',
        amount: '-1500',
        categoryId: 'cat-0',
        incomeMonth: null,
        memo: 'Original grocery detail',
      },
      {
        id: 'reviewed-dining',
        amount: '-2000',
        categoryId: 'cat-3',
        incomeMonth: null,
        memo: 'Original dining detail',
      },
    ])
    const source = after.transactions.find((row) => row.id === 'reviewed-tracking-side')!
    expect(source).toMatchObject({
      amount: '3500',
      cleared: 'reconciled',
      memo: 'Edited tracking memo',
      transferId: counterpart.transferId,
    })
    expect(source.splits).toHaveLength(1)
    expect(after.transactions.filter((row) => row.transferId === 'reviewed-pair')).toHaveLength(2)
  })
})

test('converts a whole transfer to a mixed split without moving the unrelated expense', async () => {
  await withDemo(async (page) => {
    await page.getByRole('button', { name: 'Add transaction', exact: true }).click()
    await page.getByLabel('Date', { exact: true }).fill('2026-09-04')
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('-10')
    await page.getByLabel('Transaction type').selectOption('transfer')
    await page.getByLabel('Other transfer account').selectOption('savings')
    await page.getByLabel('Memo', { exact: true }).fill('Whole to mixed review')
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)
    const before = await budget(page)
    const source = before.transactions.find(
      (row) => row.accountId === 'checking' && row.memo === 'Whole to mixed review',
    )!
    const partner = before.transactions.find(
      (row) => row.id !== source.id && row.transferId === source.transferId,
    )!

    await page.getByLabel('Search transactions').fill('Whole to mixed review')
    await page.getByRole('button', { name: /^Edit 2026-09-04/ }).click()
    await page.getByLabel('Transaction type').selectOption('split')
    await page.getByLabel('Amount (negative for outflow)', { exact: true }).fill('-15')
    await page.getByRole('button', { name: 'Add split', exact: true }).click()
    await page.getByLabel('Split 2 amount').fill('-5')
    await page
      .getByLabel('Category or income', { exact: true })
      .nth(1)
      .selectOption('category:cat-0')
    await page.getByRole('button', { name: 'Save transaction', exact: true }).click()
    await closed(page)

    const after = await budget(page)
    const mixed = after.transactions.find((row) => row.id === source.id)!
    expect(after.transactions).toHaveLength(before.transactions.length)
    expect(after.transactions.find((row) => row.id === partner.id)).toEqual(partner)
    expect(mixed).toMatchObject({ amount: '-1500', transferId: null })
    expect(mixed.splits).toMatchObject([
      {
        id: source.splits[0]!.id,
        amount: '-1000',
        transferId: source.transferId,
        categoryId: null,
      },
      { amount: '-500', transferId: null, categoryId: 'cat-0' },
    ])

    await page.getByRole('button', { name: 'Undo last change' }).click()
    await expect
      .poll(async () => (await budget(page)).transactions.find((row) => row.id === source.id))
      .toEqual(source)
    expect((await budget(page)).transactions.find((row) => row.id === partner.id)).toEqual(partner)
  })
})
