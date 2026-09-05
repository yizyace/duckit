import { dateSchema, type Budget, type Transaction } from '../../../shared/contracts'
import { formatMoney } from '../../../engine/money'
import { transferLegs } from '../../../engine/transfers'

export function money(amount: string | bigint, currency: string): string {
  const [whole, fraction] = formatMoney(amount).split('.')
  return `${currency} ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
}

export type RegisterRow = {
  transaction: Transaction
  date: string
  account: string
  payee: string
  category: string
  amount: string
  amountValue: bigint
  searchText: string
}
export type RegisterSort = { key: 'date' | 'payee' | 'amount'; ascending: boolean }

function byId<T extends { id: string }>(rows: T[]): Map<string, T> {
  const index = new Map<string, T>()
  // Valid budgets have unique IDs; first-wins also preserves the previous find semantics.
  for (const row of rows) if (!index.has(row.id)) index.set(row.id, row)
  return index
}

/** Budget-derived work is independent of the user's current search, filter and sort. */
export function prepareRegister(budget: Budget): RegisterRow[] {
  const accounts = byId(budget.accounts)
  const categories = byId(budget.categories)
  const payees = byId(budget.payees)
  const links = transferLegs(budget.transactions)
  return budget.transactions.map((transaction) => {
    const link =
      transaction.transferId ?? transaction.splits.find((split) => split.transferId)?.transferId
    const partner = link
      ? links.get(link)?.find((leg) => leg.transaction.id !== transaction.id)
      : undefined
    const category =
      transaction.splits.length > 1
        ? 'Split transaction'
        : transaction.splits[0]?.categoryId
          ? (categories.get(transaction.splits[0].categoryId)?.name ?? 'Uncategorized')
          : transaction.splits[0]?.incomeMonth
            ? `Income: ${transaction.splits[0].incomeMonth}`
            : link
              ? 'Transfer'
              : 'Uncategorized'
    const account = accounts.get(transaction.accountId)?.name ?? ''
    const payee = partner
      ? `Transfer: ${accounts.get(partner.transaction.accountId)?.name ?? 'Account'}`
      : (payees.get(transaction.payeeId ?? '')?.name ?? 'No payee')
    return {
      transaction,
      date: transaction.date,
      account,
      payee,
      category,
      amount: transaction.amount,
      amountValue: BigInt(transaction.amount),
      searchText:
        `${transaction.date} ${account} ${payee} ${category} ${transaction.memo} ${money(transaction.amount, budget.currency)} ${transaction.splits.map((split) => `${split.memo} ${categories.get(split.categoryId ?? '')?.name ?? ''}`).join(' ')}`.toLocaleLowerCase(),
    }
  })
}

export function selectRegisterRows(
  prepared: RegisterRow[],
  accountId: string,
  query: string,
  sort: RegisterSort,
): RegisterRow[] {
  const text = query.trim().toLocaleLowerCase()
  return prepared
    .filter(
      (row) =>
        (!accountId || row.transaction.accountId === accountId) &&
        (!text || row.searchText.includes(text)),
    )
    .sort((left, right) => {
      const comparison =
        sort.key === 'amount'
          ? left.amountValue < right.amountValue
            ? -1
            : left.amountValue > right.amountValue
              ? 1
              : 0
          : left[sort.key].localeCompare(right[sort.key])
      return (
        (sort.ascending ? comparison : -comparison) ||
        left.transaction.id.localeCompare(right.transaction.id)
      )
    })
}

export type AccountTotal = { balance: bigint; cleared: bigint }

/** Includes tracking/closed accounts and reconciled entries, matching accountBalance. */
export function registerBalances(budget: Budget, through: string): Map<string, AccountTotal> {
  dateSchema.parse(through)
  const totals = new Map(
    budget.accounts.map((account) => [account.id, { balance: 0n, cleared: 0n }]),
  )
  for (const transaction of budget.transactions) {
    if (transaction.date > through) continue
    const total = totals.get(transaction.accountId)
    if (!total) continue
    const amount = BigInt(transaction.amount)
    total.balance += amount
    if (transaction.cleared !== 'uncleared') total.cleared += amount
  }
  return totals
}
