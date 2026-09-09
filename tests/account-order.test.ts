import { expect, it } from 'vitest'
import { demoBudget } from '../src/shared/demo'
import { applyChanges } from '../src/engine/changes'
import { moveAccount, orderedAccounts } from '../src/engine/account-order'

function fixture() {
  const budget = demoBudget()
  budget.schemaVersion = 2
  const account = budget.accounts[0]!
  budget.accounts = ['a', 'b', 'c', 'd'].map((id, position) => ({ ...account, id, position }))
  budget.transactions = []
  budget.schedules = []
  budget.reconciliations = []
  return budget
}

it('moves an account above or below a target while ignoring cancelled and cross-section drops', () => {
  const budget = fixture()
  expect(moveAccount(budget.accounts, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
  expect(moveAccount(budget.accounts, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
  expect(moveAccount(budget.accounts, 'a', 'b', 'before')).toBeNull()
  expect(moveAccount(budget.accounts, 'a', 'a', 'after')).toBeNull()
  budget.accounts[3]!.onBudget = false
  expect(moveAccount(budget.accounts, 'a', 'd', 'before')).toBeNull()
})

it('saves explicit positions atomically and rejects incomplete, duplicate, unknown and mixed orders', () => {
  const budget = fixture()
  budget.accounts[3]!.closed = true
  const apply = (accountIds: string[]) =>
    applyChanges(budget, [{ type: 'account.reorder', accountIds }], { commandId: 'reorder' })
  const after = apply(['c', 'a', 'b'])
  expect(
    orderedAccounts(after.accounts.filter((a) => !a.closed)).map((a) => [a.id, a.position]),
  ).toEqual([
    ['c', 0],
    ['a', 1],
    ['b', 2],
  ])
  expect(after.accounts.find((a) => a.id === 'd')).toEqual(budget.accounts[3])
  expect(budget.accounts[0]!.position).toBe(0)
  for (const ids of [['a'], ['a', 'a', 'b'], ['a', 'b', 'x'], ['a', 'b', 'd']])
    expect(() => apply(ids)).toThrow()
})

it('preserves a position when editing and appends newly created accounts', () => {
  const budget = fixture(),
    { position: _, ...account } = budget.accounts[1]!
  const after = applyChanges(
    budget,
    [
      { type: 'account.put', value: { ...account, name: 'Renamed' } },
      { type: 'account.put', value: { ...account, id: 'new' } },
    ],
    { commandId: 'edit' },
  )
  expect(after.accounts.find((a) => a.id === 'b')!.position).toBe(1)
  expect(after.accounts.find((a) => a.id === 'new')!.position).toBe(4)
})
