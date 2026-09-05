import { budgetSchema, type Account, type Budget, type Transaction } from '../shared/contracts'
import { addMonths } from './calendar'
import { transferLegs, type TransferLeg } from './transfers'

/** Structural and relational checks. Uncategorized entries are valid, unresolved data. */
export function validateBudget(input: unknown): string[] {
  const parsed = budgetSchema.safeParse(input)
  if (!parsed.success)
    return parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
  const budget = parsed.data
  const errors: string[] = []
  const ids = (rows: { id: string }[], name: string): Set<string> => {
    const found = new Set<string>()
    for (const row of rows) {
      if (found.has(row.id)) errors.push(`Duplicate ${name} ID: ${row.id}`)
      found.add(row.id)
    }
    return found
  }
  ids(budget.months ?? [], 'budget month')
  if (new Set((budget.months ?? []).map((m) => m.month)).size !== (budget.months ?? []).length)
    errors.push('Duplicate budget calendar month')
  const accounts = ids(budget.accounts, 'account')
  // First-wins on a duplicate id, matching the .find() semantics this replaces.
  const accountsById = new Map<string, Account>()
  for (const account of budget.accounts)
    if (!accountsById.has(account.id)) accountsById.set(account.id, account)
  const groups = ids(budget.groups, 'group')
  const categories = ids(budget.categories, 'category')
  const payees = ids(budget.payees, 'payee')
  const transactions = ids(budget.transactions, 'transaction')
  const splits = ids(
    budget.transactions.flatMap((transaction) => transaction.splits),
    'split',
  )
  const schedules = ids(budget.schedules, 'schedule')
  const reconciliations = ids(budget.reconciliations, 'reconciliation')
  const provenance = ids(budget.provenance, 'provenance')
  const liveByKind = new Map([
    ['account', accounts],
    ['group', groups],
    ['category', categories],
    ['payee', payees],
    ['transaction', transactions],
    ['split', splits],
    ['schedule', schedules],
    ['reconciliation', reconciliations],
    ['provenance', provenance],
  ])
  const tombstones = new Set<string>()
  for (const row of budget.tombstones) {
    const key = JSON.stringify([row.kind, row.id])
    if (tombstones.has(key)) errors.push(`Duplicate tombstone for ${row.kind} ${row.id}`)
    tombstones.add(key)
    if (liveByKind.get(row.kind)?.has(row.id))
      errors.push(`Live ${row.kind} ${row.id} is also tombstoned`)
  }
  const allocations = new Set<string>()
  for (const category of budget.categories) {
    if (!groups.has(category.groupId))
      errors.push(`Category ${category.id} refers to a missing group`)
  }
  for (const allocation of budget.allocations) {
    if (!categories.has(allocation.categoryId))
      errors.push(`Allocation refers to missing category ${allocation.categoryId}`)
    const key = JSON.stringify([allocation.categoryId, allocation.month])
    if (allocations.has(key))
      errors.push(`Duplicate allocation for ${allocation.categoryId} in ${allocation.month}`)
    allocations.add(key)
  }
  const checkTransaction = (transaction: Transaction): void => {
    if (transaction.transferId && transaction.splits.some((split) => split.transferId))
      errors.push(`Transaction ${transaction.id} cannot combine whole and split transfer links`)
    if (!accounts.has(transaction.accountId))
      errors.push(`Transaction ${transaction.id} refers to a missing account`)
    if (transaction.payeeId && !payees.has(transaction.payeeId))
      errors.push(`Transaction ${transaction.id} refers to a missing payee`)
    const sum = transaction.splits.reduce((total, split) => total + BigInt(split.amount), 0n)
    if (sum !== BigInt(transaction.amount))
      errors.push(`Splits do not equal transaction ${transaction.id} amount`)
    ids(transaction.splits, `split in ${transaction.id}`)
    for (const split of transaction.splits) {
      if (split.categoryId && !categories.has(split.categoryId))
        errors.push(`Split ${split.id} refers to a missing category`)
      if (split.categoryId && split.incomeMonth)
        errors.push(`Split ${split.id} cannot be both income and categorized`)
      if (split.incomeMonth) {
        const current = transaction.date.slice(0, 7)
        const next = current === '9999-12' ? null : addMonths(current, 1)
        if (split.incomeMonth !== current && split.incomeMonth !== next)
          errors.push(`Split ${split.id} income must belong to the current or next month`)
      }
      if (
        !accountsById.get(transaction.accountId)?.onBudget &&
        (split.categoryId || split.incomeMonth)
      )
        errors.push(`Off-budget split ${split.id} cannot affect categories or budget income`)
    }
  }
  for (const transaction of budget.transactions) checkTransaction(transaction)
  const checkTransfers = (rows: Transaction[], label: string): void => {
    const transfers = transferLegs(rows)
    for (const [id, pair] of transfers) {
      if (pair.length !== 2) {
        errors.push(`${label} transfer ${id} requires exactly two transactions`)
        continue
      }
      const [left, right] = pair as [TransferLeg, TransferLeg]
      if (left.transaction.accountId === right.transaction.accountId)
        errors.push(`${label} transfer ${id} requires two different accounts`)
      if (left.amount + right.amount !== 0n)
        errors.push(`${label} transfer ${id} amounts must cancel`)
      if (left.transaction.date !== right.transaction.date)
        errors.push(`${label} transfer ${id} dates must agree`)
      const budgetSides = pair.filter(
        (leg) => accountsById.get(leg.transaction.accountId)?.onBudget,
      )
      if (
        budgetSides.length === 2 &&
        pair.some((leg) => leg.splits.some((split) => split.categoryId || split.incomeMonth))
      )
        errors.push(
          `${label} transfer ${id} between budget accounts cannot have categories or income`,
        )
      if (
        budgetSides.length === 1 &&
        budgetSides[0]!.splits.some((split) => !split.categoryId && !split.incomeMonth)
      )
        errors.push(
          `${label} transfer ${id} requires category or income treatment on its budget side`,
        )
    }
  }
  checkTransfers(budget.transactions, 'Posted')
  for (const schedule of budget.schedules) {
    checkTransaction(schedule.transaction)
    const lastSplitIndex = schedule.transaction.splits.length - 1
    if (
      `scheduled:${schedule.id}:${schedule.nextDate}:${lastSplitIndex}`.length > 200 ||
      (schedule.transaction.transferId &&
        `scheduled:${schedule.transaction.transferId}:${schedule.nextDate}`.length > 200) ||
      schedule.transaction.splits.some(
        (split) =>
          split.transferId && `scheduled:${split.transferId}:${schedule.nextDate}`.length > 200,
      )
    )
      errors.push(`Schedule ${schedule.id} IDs are too long for generated occurrences`)
    // Exhausted schedules retain their end date and next unposted occurrence.
    if (schedule.enabled && schedule.endDate && schedule.nextDate > schedule.endDate)
      errors.push(`Schedule ${schedule.id} starts after its end date`)
  }
  const scheduleByTemplate = new Map(
    budget.schedules.map((schedule) => [schedule.transaction, schedule]),
  )
  for (const [id, legs] of transferLegs(budget.schedules.map((schedule) => schedule.transaction))) {
    const schedules = legs.map((leg) => scheduleByTemplate.get(leg.transaction)!)
    const first = schedules[0]!
    if (
      schedules.some(
        (other) =>
          other.frequency !== first.frequency ||
          other.nextDate !== first.nextDate ||
          other.endDate !== first.endDate ||
          other.enabled !== first.enabled ||
          other.transaction.date !== first.transaction.date,
      )
    )
      errors.push(`Recurring transfer ${id} schedules must share recurrence and anchor`)
  }
  checkTransfers(
    budget.schedules.map((schedule) => schedule.transaction),
    'Scheduled',
  )
  const deletedTransactions = new Set(
    budget.tombstones.filter((row) => row.kind === 'transaction').map((row) => row.id),
  )
  // First-wins on a duplicate id, matching the .find() semantics this replaces.
  const transactionsById = new Map<string, Transaction>()
  for (const transaction of budget.transactions)
    if (!transactionsById.has(transaction.id)) transactionsById.set(transaction.id, transaction)
  for (const reconciliation of budget.reconciliations) {
    if (!accounts.has(reconciliation.accountId))
      errors.push(`Reconciliation ${reconciliation.id} refers to a missing account`)
    if (new Set(reconciliation.transactionIds).size !== reconciliation.transactionIds.length)
      errors.push(`Reconciliation ${reconciliation.id} repeats a transaction`)
    for (const id of reconciliation.transactionIds) {
      if (!transactions.has(id) && !deletedTransactions.has(id))
        errors.push(`Reconciliation ${reconciliation.id} refers to a missing transaction`)
      const transaction = transactionsById.get(id)
      if (transaction && transaction.accountId !== reconciliation.accountId)
        errors.push(
          `Reconciliation ${reconciliation.id} includes a transaction from another account`,
        )
      if (transaction && transaction.date > reconciliation.date)
        errors.push(
          `Reconciliation ${reconciliation.id} includes a transaction after its statement date`,
        )
    }
  }
  return [...new Set(errors)]
}

export function assertValidBudget(budget: unknown): asserts budget is Budget {
  const errors = validateBudget(budget)
  if (errors.length) throw new Error(errors.join('\n'))
}
