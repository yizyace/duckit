import { it, expect } from 'vitest'
import { normalize, denormalize } from '../src/main/storage/schema'
import { budgetSchema } from '../src/shared/contracts'
import { demoBudget } from '../src/shared/demo'
it('preserves entered split order regardless of database primary-key order', () => {
  const budget = demoBudget(),
    transaction = budget.transactions[0]!
  transaction.splits = [
    { ...transaction.splits[0]!, id: 'z-first', amount: '100' },
    { ...transaction.splits[0]!, id: 'a-second', amount: '200' },
  ]
  transaction.amount = '300'
  const rows = normalize(budget)
  rows.splits!.reverse()
  const actual = budgetSchema.parse(denormalize(rows))
  expect(actual.transactions.find((t) => t.id === transaction.id)!.splits.map((s) => s.id)).toEqual(
    ['z-first', 'a-second'],
  )
})
