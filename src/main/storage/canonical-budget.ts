import type { Budget, Transaction } from '../../shared/contracts'

type CollectionKey = {
  [Key in keyof Budget]-?: NonNullable<Budget[Key]> extends readonly unknown[] ? Key : never
}[keyof Budget]

// These are normalized tables, whose SQL row order has no domain meaning.
// Keep this exhaustive so a new top-level collection requires an explicit decision.
const unorderedCollections = {
  months: true,
  accounts: true,
  groups: true,
  categories: true,
  payees: true,
  transactions: true,
  allocations: true,
  schedules: true,
  reconciliations: true,
  provenance: true,
  tombstones: true,
} satisfies Record<CollectionKey, true>

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    )
  return value
}

function normalizedTransaction(transaction: Transaction): Transaction {
  return {
    ...transaction,
    // SQL represents an omitted optional split transfer as NULL. Both mean no transfer.
    splits: transaction.splits.map((split) => ({ ...split, transferId: split.transferId ?? null })),
  }
}

/** Stable domain encoding: table collections are unordered; split positions are significant. */
export function canonicalBudget(budget: Budget): string {
  const normalized = stable({
    ...budget,
    months: budget.months ?? [],
    transactions: budget.transactions.map(normalizedTransaction),
    schedules: budget.schedules.map((schedule) => ({
      ...schedule,
      transaction: normalizedTransaction(schedule.transaction),
    })),
    reconciliations: budget.reconciliations.map((reconciliation) => ({
      ...reconciliation,
      transactionIds: [...reconciliation.transactionIds].sort(),
    })),
  }) as Record<string, unknown>
  for (const key of Object.keys(unorderedCollections) as CollectionKey[]) {
    normalized[key] = (normalized[key] as unknown[])
      .map((value) => ({ value, key: JSON.stringify(value) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ value }) => value)
  }
  return JSON.stringify(normalized)
}
