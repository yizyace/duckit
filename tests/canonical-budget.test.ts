import { expect, it } from 'vitest'
import { budgetSchema } from '../src/shared/contracts'
import { canonicalBudget } from '../src/main/storage/canonical-budget'
import { normalize, denormalize } from '../src/main/storage/schema'
import { splitBudget } from './helpers/split-budget'

it('ignores SQL collection order and reconciliation membership order without mutating input', () => {
  const budget = splitBudget()
  budget.reconciliations = [
    {
      id: 'review',
      accountId: 'checking',
      date: '2026-09-03',
      balance: '411358',
      transactionIds: ['income', 'groceries'],
    },
  ]
  const before = structuredClone(budget),
    reordered = structuredClone(budget)
  for (const value of Object.values(reordered)) if (Array.isArray(value)) value.reverse()
  reordered.reconciliations[0]!.transactionIds.reverse()
  expect(canonicalBudget(reordered)).toBe(canonicalBudget(budget))
  expect(budget).toEqual(before)
})

it.each(['posted', 'scheduled'] as const)('retains %s split positions', (kind) => {
  const budget = splitBudget(),
    reordered = structuredClone(budget)
  const transaction =
    kind === 'posted' ? reordered.transactions[1]! : reordered.schedules[0]!.transaction
  transaction.splits.reverse()
  expect(canonicalBudget(reordered)).not.toBe(canonicalBudget(budget))
})

it('matches normalized SQL rows with optional fields, imported months, legacy IDs and exact decimals', () => {
  const budget = splitBudget()
  delete budget.months
  budget.accounts[0]!.legacyId = 'legacy-checking'
  budget.transactions[0]!.amount = '900719925474099312345678901234567890'
  budget.transactions[0]!.splits[0]!.amount = budget.transactions[0]!.amount
  const rows = normalize(budget)
  for (const entries of Object.values(rows)) entries.reverse()
  const read = budgetSchema.parse(denormalize(rows))
  expect(canonicalBudget(read)).toBe(canonicalBudget(budget))
  budget.months = [{ id: 'legacy-month', month: '2030-01', legacyId: 'legacy-month-id' }]
  expect(canonicalBudget(budgetSchema.parse(denormalize(normalize(budget))))).toBe(
    canonicalBudget(budget),
  )
})

it('preserves duplicate collection members and exact content changes for validation to assess', () => {
  const budget = splitBudget(),
    changed = structuredClone(budget)
  changed.accounts.push(structuredClone(changed.accounts[0]!))
  expect(canonicalBudget(changed)).not.toBe(canonicalBudget(budget))
  changed.accounts.pop()
  changed.transactions[1]!.splits[0]!.memo = 'changed'
  expect(canonicalBudget(changed)).not.toBe(canonicalBudget(budget))
})
