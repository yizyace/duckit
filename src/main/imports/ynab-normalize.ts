import { createHash } from 'node:crypto'
import {
  budgetSchema,
  dateSchema,
  minorSchema,
  type Account,
  type Budget,
  type Schedule,
  type Split,
  type Transaction,
} from '../../shared/contracts'
import { addMonths, validateBudget } from '../../engine'
import { string, type YnabEntity, type YnabReconstruction } from './ynab-reconstruction'

export type YnabMigrationReport = {
  sourceDigest: string
  generation: string
  fullKnowledge: string
  finalKnowledge: string
  replayedFiles: number
  accounts: number
  transactions: number
  months: number
  categories: number
  uncategorized: number
  tombstones: number
  warnings: string[]
  errors: string[]
}

function text(value: unknown, fallback = ''): string {
  return value == null ? fallback : string(value, 'Legacy text')
}
function flag(value: unknown, fallback = false): boolean {
  if (value == null) return fallback
  if (typeof value !== 'boolean') throw new Error('Legacy flag must be boolean')
  return value
}
function sortIndex(entity: YnabEntity): number {
  const value = Number(entity.sortableIndex ?? '0')
  if (!Number.isSafeInteger(value)) throw new Error('Unsupported legacy sorting index')
  return value
}
function date(value: unknown): string {
  return dateSchema.parse(string(value, 'Legacy date'))
}
function linkedId(id: string, target: string): string {
  return `ynab-transfer:${createHash('sha256')
    .update(JSON.stringify([id, target].sort()))
    .digest('hex')
    .slice(0, 40)}`
}

/** Exact decimal/exponent conversion. Reject sub-cent values instead of rounding. */
export function ynabMinor(value: unknown): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(string(value, 'Legacy amount'))
  if (!match) throw new Error('Malformed legacy monetary amount')
  const exponent = Number(match[4] ?? '0')
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100)
    throw new Error('Legacy amount exponent exceeds supported precision')
  const fraction = match[3] ?? ''
  let digits = match[2]! + fraction
  const shift = exponent + 2 - fraction.length
  if (shift >= 0) digits += '0'.repeat(shift)
  else {
    const cut = Math.max(0, digits.length + shift)
    if (/[1-9]/.test(digits.slice(cut)))
      throw new Error('Legacy amount has nonzero sub-cent precision')
    digits = digits.slice(0, cut) || '0'
  }
  return minorSchema.parse((BigInt(digits) * (match[1] === '-' ? -1n : 1n)).toString())
}

export function normalizeYnab(
  raw: YnabReconstruction,
  currency: string,
): { budget: Budget; report: YnabMigrationReport } {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter ISO code')
  const types = new Map<string, YnabEntity[]>()
  for (const entity of raw.entities) {
    const rows = types.get(entity.entityType) ?? []
    rows.push(entity)
    types.set(entity.entityType, rows)
  }
  const live = (type: string): YnabEntity[] =>
    (types.get(type) ?? []).filter((entity) => !flag(entity.isTombstone))
  const accountTypes: Record<string, Account['type']> = {
    Checking: 'checking',
    Savings: 'savings',
    Cash: 'cash',
    CreditCard: 'credit',
    LineOfCredit: 'credit',
    InvestmentAccount: 'asset',
    OtherAsset: 'asset',
    OtherLiability: 'liability',
    Mortgage: 'liability',
    Loan: 'liability',
  }
  const accounts: Account[] = live('account')
    .sort((a, b) => sortIndex(a) - sortIndex(b))
    .map((entity) => {
      const type = accountTypes[text(entity.accountType)]
      if (!type) throw new Error('Unsupported legacy account type')
      return {
        id: entity.entityId,
        name: string(entity.accountName, 'Account name'),
        type,
        onBudget: flag(entity.onBudget),
        closed: flag(entity.hidden),
        note: text(entity.note),
        legacyId: entity.entityId,
      }
    })
  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const groups = live('masterCategory')
    .filter((entity) => entity.type === 'OUTFLOW')
    .sort((a, b) => sortIndex(a) - sortIndex(b))
    .map((entity, index) => ({
      id: entity.entityId,
      name: string(entity.name, 'Group name'),
      sort: index,
      hidden: entity.name === 'Hidden Categories',
    }))
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const categories = live('category')
    .filter((entity) => entity.type === 'OUTFLOW')
    .sort((a, b) => sortIndex(a) - sortIndex(b))
    .map((entity, index) => ({
      id: entity.entityId,
      groupId: string(entity.masterCategoryId, 'Category group'),
      name: string(entity.name, 'Category name'),
      sort: index,
      hidden: groupById.get(text(entity.masterCategoryId))?.hidden ?? false,
      debt: entity.entityId.startsWith('Category/PreYNABDebt/'),
      legacyId: entity.entityId,
    }))
  const payees = live('payee').map((entity) => ({
    id: entity.entityId,
    name: string(entity.name, 'Payee name'),
    legacyId: entity.entityId,
  }))
  const transactionsRaw = live('transaction')
  const transactionById = new Map(transactionsRaw.map((entity) => [entity.entityId, entity]))
  const childSplits = new Map<string, YnabEntity[]>()
  const liveParents = new Set(
    [...transactionsRaw, ...live('scheduledTransaction')].map((entity) => entity.entityId),
  )
  for (const entity of live('subTransaction')) {
    const parent = string(entity.parentTransactionId, 'Split parent')
    if (!liveParents.has(parent))
      throw new Error('Live split references a missing parent transaction')
    const splits = childSplits.get(parent) ?? []
    splits.push(entity)
    childSplits.set(parent, splits)
  }
  const transferTarget = (entity: YnabEntity): string | null =>
    entity.transferTransactionId == null
      ? null
      : string(entity.transferTransactionId, 'Transfer target')
  for (const entity of transactionsRaw) {
    const target = transferTarget(entity)
    if (target) {
      const peer =
        transactionById.get(target) ??
        live('subTransaction').find((split) => split.entityId === target)
      if (!peer || transferTarget(peer) !== entity.entityId)
        throw new Error('Legacy transfer references are not reciprocal')
      const peerAccount =
        peer.accountId ?? transactionById.get(text(peer.parentTransactionId))?.accountId
      if (entity.targetAccountId != null && entity.targetAccountId !== peerAccount)
        throw new Error('Legacy transfer target account is inconsistent')
    }
  }
  const split = (
    entity: YnabEntity,
    accountId: string,
    transactionDate: string,
    id: string,
  ): Split => {
    let categoryId = entity.categoryId == null ? null : string(entity.categoryId, 'Legacy category')
    let incomeMonth: string | null = null
    if (!accountById.get(accountId))
      throw new Error('Legacy transaction references a missing account')
    if (!accountById.get(accountId)!.onBudget) categoryId = null
    else if (
      categoryId === 'Category/__ImmediateIncome__' ||
      categoryId === 'Category/__DeferredIncome__'
    ) {
      incomeMonth = addMonths(
        transactionDate.slice(0, 7),
        categoryId === 'Category/__DeferredIncome__' ? 1 : 0,
      )
      categoryId = null
    }
    if (categoryId === 'Category/__Split__')
      throw new Error('Legacy split header has no live subtransactions')
    return {
      id,
      amount: ynabMinor(entity.amount),
      categoryId,
      incomeMonth,
      memo: text(entity.memo),
    }
  }
  const convertTransaction = (entity: YnabEntity, template = false): Transaction => {
    const accountId = string(entity.accountId, 'Transaction account')
    const transactionDate = date(entity.date)
    const unordered = childSplits.get(entity.entityId) ?? []
    const byId = new Map(unordered.map((child) => [child.entityId, child]))
    const order = entity.subTransactions
    if (
      unordered.length &&
      (!Array.isArray(order) ||
        order.length !== unordered.length ||
        order.some((id) => !byId.has(id)))
    )
      throw new Error('Legacy split order is missing or inconsistent')
    const children = unordered.length ? (order as string[]).map((id) => byId.get(id)!) : []
    const cleared = { Uncleared: 'uncleared', Cleared: 'cleared', Reconciled: 'reconciled' }[
      text(entity.cleared)
    ] as Transaction['cleared'] | undefined
    if (!cleared) throw new Error('Unsupported legacy cleared state')
    const target = transferTarget(entity)
    return {
      id: entity.entityId,
      accountId,
      date: transactionDate,
      payeeId: entity.payeeId == null ? null : string(entity.payeeId, 'Payee ID'),
      memo: text(entity.memo),
      amount: ynabMinor(entity.amount),
      cleared,
      splits: children.length
        ? children.map((child) => ({
            ...split(child, accountId, transactionDate, child.entityId),
            transferId: transferTarget(child)
              ? linkedId(child.entityId, transferTarget(child)!)
              : null,
          }))
        : [split(entity, accountId, transactionDate, `ynab-split:${entity.entityId}`)],
      transferId: target ? linkedId(entity.entityId, target) : null,
      bankId: entity.importedId == null ? null : text(entity.importedId),
      legacyId: template ? null : entity.entityId,
    }
  }
  const transactions = transactionsRaw.map((entity) => convertTransaction(entity))
  const monthlyBudgets = live('monthlyBudget')
  const monthById = new Map(
    monthlyBudgets.map((entity) => [entity.entityId, date(entity.month).slice(0, 7)]),
  )
  const allocations = live('monthlyCategoryBudget').map((entity) => {
    const month = monthById.get(text(entity.parentMonthlyBudgetId))
    if (!month) throw new Error('Legacy allocation references a missing budget month')
    const overspending = entity.overspendingHandling ?? null
    if (overspending !== null && overspending !== 'Confined' && overspending !== 'AffectsBuffer')
      throw new Error('Unknown legacy overspending rule')
    return {
      categoryId: string(entity.categoryId, 'Allocation category'),
      month,
      amount: ynabMinor(entity.budgeted),
      overspending,
      note: text(entity.note),
    }
  })
  const frequencies: Record<string, Schedule['frequency']> = {
    Daily: 'daily',
    Weekly: 'weekly',
    EveryOtherWeek: 'fortnightly',
    Monthly: 'monthly',
    EveryThreeMonths: 'quarterly',
    Yearly: 'yearly',
  }
  const schedules: Schedule[] = live('scheduledTransaction').map((entity) => {
    const frequency = frequencies[text(entity.frequency)]
    if (!frequency) throw new Error('Unsupported legacy recurrence must be resolved before import')
    if (entity.targetAccountId && !entity.transferTransactionId)
      throw new Error('Legacy recurring transfer lacks a paired schedule')
    return {
      id: entity.entityId,
      nextDate: date(entity.date),
      frequency,
      endDate: entity.endDate == null ? null : date(entity.endDate),
      transaction: convertTransaction(entity, true),
      enabled: true,
    }
  })
  const kindMap: Record<string, string> = {
    account: 'account',
    masterCategory: 'group',
    category: 'category',
    payee: 'payee',
    transaction: 'transaction',
    subTransaction: 'split',
    scheduledTransaction: 'schedule',
    monthlyCategoryBudget: 'legacyAllocation',
    monthlyBudget: 'legacyMonth',
  }
  const tombstones = raw.entities
    .filter((entity) => flag(entity.isTombstone))
    .map((entity) => ({
      kind: kindMap[entity.entityType] ?? `legacy:${entity.entityType}`,
      id: entity.entityId,
      revision: entity.entityVersion,
    }))
  const warnings = [
    'Legacy cached balances were excluded from calculations. No adjustment transactions were created.',
    'Historical original-app display totals are unavailable; ledger and category calculations require independent verification.',
  ]
  const reconciliations: Budget['reconciliations'] = []
  warnings.push(
    'Cleared and reconciled flags were preserved. Historical reconciliation events are unavailable; legacy dates and cached totals remain in the source evidence only.',
  )
  const months = [...monthById.values()].sort()
  const startMonth =
    months[0] ?? transactions.map((transaction) => transaction.date.slice(0, 7)).sort()[0]
  if (!startMonth) throw new Error('Legacy budget has no dated history')
  const budget = budgetSchema.parse({
    schemaVersion: 1,
    id: `ynab-${raw.sourceDigest.slice(0, 32)}`,
    name: raw.name || 'Imported budget',
    currency,
    revision: 0,
    startMonth,
    months: monthlyBudgets.map((entity) => ({
      id: entity.entityId,
      month: monthById.get(entity.entityId)!,
      legacyId: entity.entityId,
    })),
    accounts,
    groups,
    categories,
    payees,
    transactions,
    allocations,
    schedules,
    reconciliations,
    tombstones,
    provenance: [
      {
        id: `ynab-${raw.sourceDigest}`,
        kind: 'ynab4',
        digest: raw.sourceDigest,
        importedAt: new Date().toISOString(),
        detail: JSON.stringify({
          generation: raw.generation,
          fullKnowledge: raw.fullKnowledge,
          finalKnowledge: raw.finalKnowledge,
          replayedFiles: raw.replayedPaths.length,
          sourceMonths: months.length,
        }),
      },
    ],
  })
  const errors = validateBudget(budget)
  const uncategorized = transactions.filter(
    (transaction) =>
      accountById.get(transaction.accountId)?.onBudget &&
      !transaction.transferId &&
      transaction.splits.some(
        (split) => !split.transferId && !split.categoryId && !split.incomeMonth,
      ),
  ).length
  if (uncategorized)
    warnings.push(`${uncategorized} transactions remain uncategorized and require review.`)
  return {
    budget,
    report: {
      sourceDigest: raw.sourceDigest,
      generation: raw.generation,
      fullKnowledge: raw.fullKnowledge,
      finalKnowledge: raw.finalKnowledge,
      replayedFiles: raw.replayedPaths.length,
      accounts: accounts.length,
      transactions: transactions.length,
      months: months.length,
      categories: categories.length,
      uncategorized,
      tombstones: tombstones.length,
      warnings,
      errors,
    },
  }
}
