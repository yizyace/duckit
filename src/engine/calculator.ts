import {
  dateSchema,
  monthSchema,
  type Allocation,
  type Budget,
  type Transaction,
} from '../shared/contracts'
import { monthsBetween } from './calendar'
import { transferLegs } from './transfers'

export type OverspendingRule = NonNullable<Allocation['overspending']>
export type CategoryMonth = {
  categoryId: string
  budgeted: bigint
  activity: bigint
  carryIn: bigint
  balance: bigint
  overspending: OverspendingRule
}
export type BudgetMonth = {
  month: string
  /** Income assigned to this budget month, including deferred prior-month income. */
  income: bigint
  budgeted: bigint
  available: bigint
  availableBeforeBudget: bigint
  /** Positive amount charged from the preceding month's red categories. */
  overspending: bigint
  /** On-budget uncategorized activity, which must remain visibly unresolved. */
  uncategorized: bigint
  categories: CategoryMonth[]
}

export function accountBalance(
  budget: Budget,
  accountId: string,
  through?: string,
  clearedOnly = false,
): bigint {
  if (!budget.accounts.some((account) => account.id === accountId))
    throw new Error('Account does not exist')
  if (through) dateSchema.parse(through)
  return budget.transactions.reduce(
    (sum, transaction) =>
      transaction.accountId === accountId &&
      (!through || transaction.date <= through) &&
      (!clearedOnly || transaction.cleared !== 'uncleared')
        ? sum + BigInt(transaction.amount)
        : sum,
    0n,
  )
}

/** Internal transfers have no category activity or income. */
export function internalTransferIds(budget: Budget): Set<string> {
  const onBudget = new Set(
    budget.accounts.filter((account) => account.onBudget).map((account) => account.id),
  )
  const pairs = transferLegs(budget.transactions)
  return new Set(
    [...pairs]
      .filter(
        ([, pair]) =>
          pair.length === 2 && pair.every((leg) => onBudget.has(leg.transaction.accountId)),
      )
      .map(([id]) => id),
  )
}

/** Recompute from the earliest stored event, never from cached legacy balances. */
export function calculateBudget(budget: Budget, from: string, to: string): BudgetMonth[] {
  monthSchema.parse(from)
  monthSchema.parse(to)
  if (from > to) throw new Error('Start month must not follow end month')
  let first = from < budget.startMonth ? from : budget.startMonth
  const income = new Map<string, bigint>()
  const activity = new Map<string, Map<string, bigint>>()
  const uncategorized = new Map<string, bigint>()
  const allocations = new Map<string, Map<string, Allocation>>()
  const onBudget = new Set(
    budget.accounts.filter((account) => account.onBudget).map((account) => account.id),
  )
  const internal = internalTransferIds(budget)
  for (const allocation of budget.allocations) {
    if (allocation.month < first) first = allocation.month
    const rows = allocations.get(allocation.month) ?? new Map<string, Allocation>()
    rows.set(allocation.categoryId, allocation)
    allocations.set(allocation.month, rows)
  }
  for (const transaction of budget.transactions) {
    if (
      !onBudget.has(transaction.accountId) ||
      (transaction.transferId && internal.has(transaction.transferId))
    )
      continue
    const month = transaction.date.slice(0, 7)
    if (month < first) first = month
    for (const split of transaction.splits) {
      if (split.transferId && internal.has(split.transferId)) continue
      const amount = BigInt(split.amount)
      if (split.incomeMonth) {
        if (split.incomeMonth < first) first = split.incomeMonth
        income.set(split.incomeMonth, (income.get(split.incomeMonth) ?? 0n) + amount)
      } else if (split.categoryId) {
        const rows = activity.get(month) ?? new Map<string, bigint>()
        rows.set(split.categoryId, (rows.get(split.categoryId) ?? 0n) + amount)
        activity.set(month, rows)
      } else {
        uncategorized.set(month, (uncategorized.get(month) ?? 0n) + amount)
      }
    }
  }

  let available = 0n
  let previousCharge = 0n
  const carry = new Map<string, bigint>()
  const rules = new Map<string, OverspendingRule>()
  const result: BudgetMonth[] = []
  for (const month of monthsBetween(first, to)) {
    const monthIncome = income.get(month) ?? 0n
    const availableBeforeBudget = available + monthIncome - previousCharge
    let budgeted = 0n
    let nextCharge = 0n
    const categories = budget.categories.map((category): CategoryMonth => {
      const allocation = allocations.get(month)?.get(category.id)
      const rule = allocation?.overspending ?? rules.get(category.id) ?? 'AffectsBuffer'
      rules.set(category.id, rule)
      const categoryBudgeted = BigInt(allocation?.amount ?? '0')
      const categoryActivity = activity.get(month)?.get(category.id) ?? 0n
      const carryIn = carry.get(category.id) ?? 0n
      const balance = carryIn + categoryBudgeted + categoryActivity
      budgeted += categoryBudgeted
      if (balance < 0n && rule === 'AffectsBuffer') {
        nextCharge -= balance
        carry.set(category.id, 0n)
      } else carry.set(category.id, balance)
      return {
        categoryId: category.id,
        budgeted: categoryBudgeted,
        activity: categoryActivity,
        carryIn,
        balance,
        overspending: rule,
      }
    })
    available = availableBeforeBudget - budgeted
    if (month >= from)
      result.push({
        month,
        income: monthIncome,
        budgeted,
        available,
        availableBeforeBudget,
        overspending: previousCharge,
        uncategorized: uncategorized.get(month) ?? 0n,
        categories,
      })
    previousCharge = nextCharge
  }
  return result
}

export type ReportMonth = {
  month: string
  /** Cash-date income and categorized outflow; refunds reduce spending. */
  income: bigint
  spending: bigint
  uncategorized: bigint
  netWorth: bigint
  accounts: { accountId: string; balance: bigint }[]
  categories: { categoryId: string; spending: bigint }[]
}

export function reports(budget: Budget, from: string, to: string): ReportMonth[] {
  const months = monthsBetween(from, to)
  const internal = internalTransferIds(budget)
  const onBudget = new Set(
    budget.accounts.filter((account) => account.onBudget).map((account) => account.id),
  )
  const transactions = new Map<string, Transaction[]>()
  for (const transaction of budget.transactions) {
    const month = transaction.date.slice(0, 7)
    const rows = transactions.get(month) ?? []
    rows.push(transaction)
    transactions.set(month, rows)
  }
  const balances = new Map(budget.accounts.map((account) => [account.id, 0n]))
  for (const transaction of budget.transactions) {
    if (transaction.date < `${from}-01`)
      balances.set(
        transaction.accountId,
        (balances.get(transaction.accountId) ?? 0n) + BigInt(transaction.amount),
      )
  }
  return months.map((month): ReportMonth => {
    let income = 0n
    let uncategorized = 0n
    const categorySpending = new Map<string, bigint>()
    for (const transaction of transactions.get(month) ?? []) {
      balances.set(
        transaction.accountId,
        (balances.get(transaction.accountId) ?? 0n) + BigInt(transaction.amount),
      )
      if (
        !onBudget.has(transaction.accountId) ||
        (transaction.transferId && internal.has(transaction.transferId))
      )
        continue
      for (const split of transaction.splits) {
        if (split.transferId && internal.has(split.transferId)) continue
        const amount = BigInt(split.amount)
        if (split.incomeMonth) income += amount
        else if (split.categoryId)
          categorySpending.set(
            split.categoryId,
            (categorySpending.get(split.categoryId) ?? 0n) - amount,
          )
        else uncategorized += amount
      }
    }
    const categories = budget.categories.map((category) => ({
      categoryId: category.id,
      spending: categorySpending.get(category.id) ?? 0n,
    }))
    const accounts = budget.accounts.map((account) => ({
      accountId: account.id,
      balance: balances.get(account.id) ?? 0n,
    }))
    return {
      month,
      income,
      spending: categories.reduce((sum, category) => sum + category.spending, 0n),
      uncategorized,
      netWorth: accounts.reduce((sum, account) => sum + account.balance, 0n),
      accounts,
      categories,
    }
  })
}
