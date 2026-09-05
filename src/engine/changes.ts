import {
  budgetSchema,
  changeSchema,
  type Budget,
  type Change,
  type Schedule,
  type Transaction,
} from '../shared/contracts'
import { addMonths, nextOccurrence } from './calendar'
import { accountBalance } from './calculator'
import { assertValidBudget } from './validation'
import { transferLegs } from './transfers'

function upsert<T extends { id: string }>(rows: T[], value: T): void {
  const index = rows.findIndex((row) => row.id === value.id)
  if (index < 0) rows.push(value)
  else rows[index] = value
}

function postScheduled(schedule: Schedule, date: string): Transaction {
  const template = schedule.transaction
  const id = `scheduled:${schedule.id}:${date}`
  if (id.length > 200) throw new Error('Schedule ID is too long for generated transaction IDs')
  return {
    ...template,
    id,
    date,
    cleared: 'uncleared',
    bankId: null,
    legacyId: null,
    transferId: template.transferId ? `scheduled:${template.transferId}:${date}` : null,
    splits: template.splits.map((split, index) => ({
      ...split,
      id: `${id}:${index}`,
      ...(split.transferId ? { transferId: `scheduled:${split.transferId}:${date}` } : {}),
      incomeMonth: split.incomeMonth
        ? addMonths(date.slice(0, 7), split.incomeMonth === template.date.slice(0, 7) ? 0 : 1)
        : null,
    })),
  }
}

/** Remove linked legs while retaining unrelated splits on the counterpart transaction. */
function deleteTransactions(
  budget: Budget,
  selected: string[],
  tombstone: (kind: string, id: string) => void,
): void {
  const rows = new Map(budget.transactions.map((transaction) => [transaction.id, transaction]))
  const transfers = transferLegs(budget.transactions)
  const deleted = new Set(selected)
  const removedSplits = new Set<string>()
  for (const id of deleted) {
    const transaction = rows.get(id)
    if (!transaction) throw new Error(`Transaction ${id} does not exist`)
    const linked = [transaction.transferId, ...transaction.splits.map((split) => split.transferId)]
    for (const transferId of linked) {
      if (!transferId) continue
      for (const leg of transfers.get(transferId) ?? []) {
        if (leg.transaction.id === id || deleted.has(leg.transaction.id)) continue
        if (!leg.split) deleted.add(leg.transaction.id)
        else {
          removedSplits.add(leg.split.id)
          if (leg.transaction.splits.every((split) => removedSplits.has(split.id)))
            deleted.add(leg.transaction.id)
        }
      }
    }
  }
  budget.transactions = budget.transactions.filter((transaction) => {
    if (deleted.has(transaction.id)) {
      tombstone('transaction', transaction.id)
      for (const split of transaction.splits) tombstone('split', split.id)
      return false
    }
    const kept = transaction.splits.filter((split) => {
      if (!removedSplits.has(split.id)) return true
      tombstone('split', split.id)
      return false
    })
    if (kept.length !== transaction.splits.length) {
      transaction.splits = kept
      transaction.amount = kept.reduce((sum, split) => sum + BigInt(split.amount), 0n).toString()
    }
    return true
  })
}

/**
 * Atomic pure domain changes. Persistence owns revision increments, retries and undo.
 * Schedule IDs derive from schedule/date so rerunning cannot create duplicate entries.
 */
export function applyChanges(
  input: Budget,
  changes: Change[],
  options: { commandId: string },
): Budget {
  assertValidBudget(input)
  if (!options.commandId || options.commandId.length > 150)
    throw new Error('A bounded command ID is required')
  const budget = budgetSchema.parse(input)
  const revive = (kind: string, id: string): void => {
    budget.tombstones = budget.tombstones.filter((row) => row.kind !== kind || row.id !== id)
  }
  const tombstone = (kind: string, id: string): void => {
    revive(kind, id)
    budget.tombstones.push({ kind, id, revision: String(input.revision + 1) })
  }
  const parsedChanges = changes.map((change) => changeSchema.parse(change))
  for (const [index, change] of parsedChanges.entries()) {
    switch (change.type) {
      case 'account.put':
        upsert(budget.accounts, change.value)
        revive('account', change.value.id)
        break
      case 'category.put':
        upsert(budget.categories, change.value)
        revive('category', change.value.id)
        break
      case 'group.put':
        upsert(budget.groups, change.value)
        revive('group', change.value.id)
        break
      case 'payee.put':
        upsert(budget.payees, change.value)
        revive('payee', change.value.id)
        break
      case 'transaction.put': {
        const previous = budget.transactions.find(
          (transaction) => transaction.id === change.value.id,
        )
        const newSplits = new Set(change.value.splits.map((split) => split.id))
        for (const split of previous?.splits ?? [])
          if (!newSplits.has(split.id)) tombstone('split', split.id)
        upsert(budget.transactions, change.value)
        revive('transaction', change.value.id)
        for (const split of change.value.splits) revive('split', split.id)
        break
      }
      case 'transaction.delete': {
        deleteTransactions(budget, change.ids, tombstone)
        break
      }
      case 'transaction.clear':
        for (const id of new Set(change.ids)) {
          const transaction = budget.transactions.find((row) => row.id === id)
          if (!transaction) throw new Error(`Transaction ${id} does not exist`)
          transaction.cleared = change.cleared
        }
        break
      case 'allocation.put': {
        budget.months ??= []
        if (!budget.months.some((m) => m.month === change.value.month))
          budget.months.push({
            id: `month:${change.value.month}`,
            month: change.value.month,
            legacyId: null,
          })
        const index = budget.allocations.findIndex(
          (row) => row.categoryId === change.value.categoryId && row.month === change.value.month,
        )
        if (index < 0) budget.allocations.push(change.value)
        else budget.allocations[index] = change.value
        break
      }
      case 'provenance.put':
        upsert(budget.provenance, change.value)
        break
      case 'schedule.put':
        upsert(budget.schedules, change.value)
        revive('schedule', change.value.id)
        break
      case 'schedule.run': {
        let posted = 0
        for (const schedule of budget.schedules) {
          if (!schedule.enabled) continue
          while (
            schedule.nextDate <= change.through &&
            (!schedule.endDate || schedule.nextDate <= schedule.endDate)
          ) {
            if (++posted > 10000)
              throw new Error(
                'Schedule catch-up exceeds 10,000 occurrences; choose an earlier date',
              )
            const transaction = postScheduled(schedule, schedule.nextDate)
            if (
              budget.transactions.some((row) => row.id === transaction.id) ||
              budget.tombstones.some(
                (row) => row.kind === 'transaction' && row.id === transaction.id,
              )
            )
              throw new Error(`Schedule occurrence ${transaction.id} already exists or was deleted`)
            budget.transactions.push(transaction)
            if (schedule.endDate && schedule.nextDate === schedule.endDate) {
              schedule.enabled = false
              break
            }
            schedule.nextDate = nextOccurrence(
              schedule.nextDate,
              schedule.frequency,
              schedule.transaction.date,
            )
            if (schedule.endDate && schedule.nextDate > schedule.endDate) schedule.enabled = false
          }
        }
        break
      }
      case 'reconcile': {
        if (accountBalance(budget, change.accountId, change.date, true) !== BigInt(change.balance))
          throw new Error('Cleared balance does not match the statement; no adjustment was created')
        const transactions = budget.transactions.filter(
          (transaction) =>
            transaction.accountId === change.accountId &&
            transaction.date <= change.date &&
            transaction.cleared !== 'uncleared',
        )
        for (const transaction of transactions) transaction.cleared = 'reconciled'
        budget.reconciliations.push({
          id: `${options.commandId}:reconcile:${index}`,
          accountId: change.accountId,
          date: change.date,
          balance: change.balance,
          transactionIds: transactions.map((transaction) => transaction.id),
        })
        break
      }
      case 'undo':
      case 'redo':
        throw new Error('Undo and redo are persistence operations')
    }
  }
  assertValidBudget(budget)
  return budget
}
