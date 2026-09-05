import { demoBudget } from '../../src/shared/demo'
import { assertValidBudget } from '../../src/engine'
export function splitBudget() {
  const budget = demoBudget()
  budget.transactions[1]!.splits = [
    { id: 'first', amount: '-4000', categoryId: 'cat-0', incomeMonth: null, memo: 'entered first' },
    {
      id: 'second',
      amount: '-4642',
      categoryId: 'cat-2',
      incomeMonth: null,
      memo: 'entered second',
    },
  ]
  const template = structuredClone(budget.transactions[1]!)
  template.id = 'schedule-template'
  template.splits.forEach((s) => {
    s.id = `scheduled-${s.id}`
  })
  budget.schedules = [
    {
      id: 'schedule',
      nextDate: '2026-10-03',
      endDate: null,
      frequency: 'monthly',
      enabled: true,
      transaction: template,
    },
  ]
  assertValidBudget(budget)
  return budget
}
