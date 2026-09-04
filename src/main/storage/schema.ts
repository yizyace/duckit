import type { Budget } from '../../shared/contracts'
export type Row = Record<string, string | number | boolean | null>
type Column = { name: string; type: string; json?: boolean; boolean?: boolean }
export type Table = { name: string; key: string[]; columns: Column[] }
const text = (name: string): Column => ({ name, type: 'LONGTEXT' })
const id = (name: string): Column => ({ name, type: 'VARCHAR(200)' })
const bool = (name: string): Column => ({ name, type: 'BOOLEAN', boolean: true })
const num = (name: string): Column => ({ name, type: 'BIGINT' })
const money = (name: string): Column => ({ name, type: 'DECIMAL(40,0)' })
const json = (name: string): Column => ({ name, type: 'LONGTEXT', json: true })
export const tables: Table[] = [
  {
    name: 'budget_meta',
    key: ['id'],
    columns: [
      id('id'),
      num('schemaVersion'),
      text('name'),
      id('currency'),
      num('revision'),
      id('startMonth'),
    ],
  },
  {
    name: 'accounts',
    key: ['id'],
    columns: [
      id('id'),
      text('name'),
      id('type'),
      bool('onBudget'),
      bool('closed'),
      text('note'),
      id('legacyId'),
    ],
  },
  {
    name: 'category_groups',
    key: ['id'],
    columns: [id('id'), text('name'), num('sort'), bool('hidden')],
  },
  {
    name: 'categories',
    key: ['id'],
    columns: [
      id('id'),
      id('groupId'),
      text('name'),
      num('sort'),
      bool('hidden'),
      bool('debt'),
      id('legacyId'),
    ],
  },
  { name: 'payees', key: ['id'], columns: [id('id'), text('name'), id('legacyId')] },
  {
    name: 'transactions',
    key: ['id'],
    columns: [
      id('id'),
      id('accountId'),
      id('date'),
      id('payeeId'),
      text('memo'),
      money('amount'),
      id('cleared'),
      id('transferId'),
      text('bankId'),
      id('legacyId'),
    ],
  },
  {
    name: 'splits',
    key: ['id'],
    columns: [
      id('id'),
      id('transactionId'),
      money('amount'),
      id('categoryId'),
      id('incomeMonth'),
      id('transferId'),
      text('memo'),
    ],
  },
  {
    name: 'allocations',
    key: ['categoryId', 'month'],
    columns: [id('categoryId'), id('month'), money('amount'), id('overspending'), text('note')],
  },
  {
    name: 'schedules',
    key: ['id'],
    columns: [
      id('id'),
      id('nextDate'),
      id('frequency'),
      id('endDate'),
      json('transaction'),
      bool('enabled'),
    ],
  },
  {
    name: 'reconciliations',
    key: ['id'],
    columns: [id('id'), id('accountId'), id('date'), money('balance')],
  },
  {
    name: 'reconciliation_items',
    key: ['reconciliationId', 'transactionId'],
    columns: [id('reconciliationId'), id('transactionId')],
  },
  {
    name: 'provenance',
    key: ['id'],
    columns: [id('id'), id('kind'), text('digest'), text('importedAt'), text('detail')],
  },
  { name: 'tombstones', key: ['kind', 'id'], columns: [id('kind'), id('id'), text('revision')] },
]
export const schemaSQL =
  tables
    .map(
      (t) =>
        `CREATE TABLE \`${t.name}\` (${t.columns.map((c) => `\`${c.name}\` ${c.type}${t.key.includes(c.name) ? ' NOT NULL' : ''}`).join(',')}, PRIMARY KEY (${t.key.map((k) => `\`${k}\``).join(',')}));`,
    )
    .join('\n') +
  `
CREATE TABLE command_receipts (id VARCHAR(200) PRIMARY KEY, fingerprint VARCHAR(64) NOT NULL, revision BIGINT NOT NULL);
CREATE TABLE undo_history (id BIGINT PRIMARY KEY, before_state LONGTEXT NOT NULL, after_state LONGTEXT NOT NULL, undone BOOLEAN NOT NULL DEFAULT FALSE, retired BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE write_guard (id INT PRIMARY KEY);
INSERT INTO write_guard VALUES (1);
`
export function normalize(b: Budget): Record<string, Row[]> {
  const {
    accounts,
    groups,
    categories,
    payees,
    transactions,
    allocations,
    schedules,
    reconciliations,
    provenance,
    tombstones,
    ...meta
  } = b
  return {
    budget_meta: [meta],
    accounts,
    category_groups: groups,
    categories,
    payees,
    transactions: transactions.map(({ splits: _, ...t }) => t),
    splits: transactions.flatMap((t) => t.splits.map((s) => ({ ...s, transferId: s.transferId ?? null, transactionId: t.id }))),
    allocations,
    schedules: schedules.map((s) => ({ ...s, transaction: JSON.stringify(s.transaction) })),
    reconciliations: reconciliations.map(({ transactionIds: _, ...r }) => r),
    reconciliation_items: reconciliations.flatMap((r) =>
      r.transactionIds.map((transactionId) => ({ reconciliationId: r.id, transactionId })),
    ),
    provenance,
    tombstones,
  }
}
export function denormalize(rows: Record<string, Row[]>): unknown {
  const splits=new Map<string,Row[]>()
  for(const {transactionId,...split} of rows.splits ?? []) {
    const key=String(transactionId), entries=splits.get(key) ?? []
    entries.push(split);splits.set(key,entries)
  }
  return {
    ...rows.budget_meta?.[0],
    accounts: rows.accounts,
    groups: rows.category_groups,
    categories: rows.categories,
    payees: rows.payees,
    transactions: rows.transactions?.map((t) => ({
      ...t,
      splits: splits.get(String(t.id)) ?? [],
    })),
    allocations: rows.allocations,
    schedules: rows.schedules?.map((s) => ({
      ...s,
      transaction: typeof s.transaction === 'string' ? JSON.parse(s.transaction) : s.transaction,
    })),
    reconciliations: rows.reconciliations?.map((r) => ({
      ...r,
      transactionIds: rows.reconciliation_items
        ?.filter((i) => i.reconciliationId === r.id)
        .map((i) => i.transactionId),
    })),
    provenance: rows.provenance,
    tombstones: rows.tombstones,
  }
}
