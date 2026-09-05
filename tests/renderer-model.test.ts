import { describe, expect, it } from 'vitest'
import { demoBudget } from '../src/shared/demo'
import { type Transaction } from '../src/shared/contracts'
import { validateBudget } from '../src/engine/validation'
import {
  money,
  prepareRegister,
  registerBalances,
  selectRegisterRows,
} from '../src/renderer/src/views/register-model'

function fixture() {
  const budget = demoBudget()
  const transaction = (
    id: string,
    amount: string,
    patch: Partial<Transaction> = {},
  ): Transaction => ({
    ...budget.transactions[1]!,
    id,
    amount,
    splits: [{ id: id + '-split', amount, categoryId: 'cat-0', incomeMonth: null, memo: '' }],
    ...patch,
  })
  budget.transactions.push(
    transaction('same-b', '-8642'),
    transaction('same-a', '-8642'),
    transaction('split', '-1000', {
      memo: 'Shared trip',
      splits: [
        { id: 'split-food', amount: '-600', categoryId: 'cat-0', incomeMonth: null, memo: 'Lunch' },
        {
          id: 'split-fuel',
          amount: '-400',
          categoryId: 'cat-2',
          incomeMonth: null,
          memo: 'Fuel receipt',
        },
      ],
    }),
    transaction('uncategorized', '-10', {
      payeeId: null,
      splits: [{ id: 'unassigned', amount: '-10', categoryId: null, incomeMonth: null, memo: '' }],
    }),
    ...['checking', 'savings'].map((accountId, i) =>
      transaction('transfer-' + i, i ? '1000' : '-1000', {
        accountId,
        transferId: 'transfer',
        splits: [
          {
            id: 'transfer-split-' + i,
            amount: i ? '1000' : '-1000',
            categoryId: null,
            incomeMonth: null,
            memo: '',
          },
        ],
      }),
    ),
  )
  expect(validateBudget(budget)).toEqual([])
  return budget
}

describe('prepared register data', () => {
  it('searches visible names, exact currency amounts, income, memo and split details', () => {
    const budget = fixture()
    const before = structuredClone(budget)
    const prepared = prepareRegister(budget)
    const ids = (query: string, account = '') =>
      selectRegisterRows(prepared, account, query, { key: 'date', ascending: true }).map(
        (row) => row.transaction.id,
      )
    expect(ids(' Employer ')).toEqual(['income'])
    expect(ids('income: 2026-09')).toEqual(['income'])
    expect(ids('USD -86.42')).toEqual(['groceries', 'same-a', 'same-b'])
    expect(ids('shared TRIP')).toEqual(['split'])
    expect(ids('fuel receipt')).toEqual(['split'])
    expect(ids('Transport')).toEqual(['split'])
    expect(ids('Uncategorized')).toEqual(['uncategorized'])
    expect(ids('No payee')).toEqual(['uncategorized'])
    expect(ids('Transfer: Savings')).toEqual(['transfer-0'])
    expect(ids('Transfer:', 'savings')).toEqual(['transfer-1'])
    expect(ids('', 'missing-account')).toEqual([])
    expect(prepared.find((row) => row.transaction.id === 'split')?.category).toBe(
      'Split transaction',
    )
    expect(budget).toEqual(before)
  })

  it('sorts exact amounts beyond safe integers and uses ascending IDs for ties in either direction', () => {
    const budget = demoBudget()
    const template = budget.transactions[1]!
    budget.transactions = [
      ['huge', '900719925474099300001'],
      ['small', '900719925474099300000'],
      ['tie-b', '-100'],
      ['tie-a', '-100'],
    ].map(([id, amount]) => ({
      ...template,
      id: id!,
      amount: amount!,
      splits: [{ ...template.splits[0]!, id: 'split-' + id, amount: amount! }],
    }))
    const rows = prepareRegister(budget)
    const ids = (key: 'amount' | 'date' | 'payee', ascending: boolean) =>
      selectRegisterRows(rows, '', '', { key, ascending }).map((row) => row.transaction.id)
    expect(ids('amount', true)).toEqual(['tie-a', 'tie-b', 'small', 'huge'])
    expect(ids('amount', false)).toEqual(['huge', 'small', 'tie-a', 'tie-b'])
    expect(ids('date', false)).toEqual(['huge', 'small', 'tie-a', 'tie-b'])
    expect(ids('payee', true)).toEqual(['huge', 'small', 'tie-a', 'tie-b'])
    expect(rows.map((row) => row.transaction.id)).toEqual(['huge', 'small', 'tie-b', 'tie-a'])
    expect(money('900719925474099300001', 'USD')).toBe('USD 9,007,199,254,740,993,000.01')
  })

  it('refreshes indexed names and transactions from the new budget without changing an older prepared snapshot', () => {
    const budget = fixture()
    const original = prepareRegister(budget)
    const next = structuredClone(budget)
    next.payees[1]!.name = 'Renamed shop'
    next.categories[2]!.name = 'Driving'
    next.accounts[1]!.name = 'Reserve'
    next.transactions = next.transactions.filter((transaction) => transaction.id !== 'same-a')
    const rows = prepareRegister(next)
    const select = (query: string) =>
      selectRegisterRows(rows, '', query, { key: 'date', ascending: false })
    expect(select('Renamed shop').map((row) => row.transaction.id)).toEqual([
      'groceries',
      'same-b',
      'split',
    ])
    expect(select('Neighborhood Market')).toEqual([])
    expect(select('Driving').map((row) => row.transaction.id)).toEqual(['split'])
    expect(select('Transfer: Reserve').map((row) => row.transaction.id)).toEqual(['transfer-0'])
    expect(original.find((row) => row.transaction.id === 'same-a')?.payee).toBe(
      'Neighborhood Market',
    )
  })
})

it('accumulates exact cleared and total balances through the date, including closed tracking accounts', () => {
  const budget = demoBudget()
  budget.accounts[1] = { ...budget.accounts[1]!, onBudget: false, closed: true }
  budget.transactions.push(
    {
      ...budget.transactions[1]!,
      id: 'future',
      date: '2026-10-01',
      amount: '-100',
      splits: [
        { id: 'future-split', amount: '-100', categoryId: 'cat-0', incomeMonth: null, memo: '' },
      ],
    },
    {
      ...budget.transactions[0]!,
      id: 'tracking',
      accountId: 'savings',
      cleared: 'reconciled',
      amount: '900719925474099300001',
      splits: [
        {
          id: 'tracking-split',
          amount: '900719925474099300001',
          categoryId: null,
          incomeMonth: null,
          memo: '',
        },
      ],
    },
  )
  expect(validateBudget(budget)).toEqual([])
  const early = registerBalances(budget, '2026-09-01')
  expect(early.get('checking')).toEqual({ balance: 420000n, cleared: 420000n })
  const september = registerBalances(budget, '2026-09-30')
  expect(september.get('checking')).toEqual({ balance: 411358n, cleared: 420000n })
  expect(september.get('savings')).toEqual({
    balance: 900719925474099300001n,
    cleared: 900719925474099300001n,
  })
  expect(registerBalances(budget, '2026-10-01').get('checking')?.balance).toBe(411258n)
  expect(() => registerBalances(budget, '2026-02-30')).toThrow()
})
