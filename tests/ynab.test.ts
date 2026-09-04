import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { calculateBudget } from '../src/engine'
import {
  reconstructYnab,
  reconstructRawYnab,
  ynabMinor,
  ynabPreview,
} from '../src/main/imports/ynab'

type Row = Record<string, unknown>
const root = 'Synthetic~ABC.ynab4/'
const generation = `${root}data1-ABC/`
const version = 'A-20,B-0'
function full(): Row {
  return {
    fileMetaData: {
      entityType: 'fileMetaData',
      currentKnowledge: version,
      budgetDataVersion: '4.2',
    },
    budgetMetaData: {
      entityType: 'budgetMetaData',
      entityId: 'metadata',
      entityVersion: 'A-0',
      currencyISOSymbol: null,
    },
    accounts: [
      {
        entityType: 'account',
        entityId: 'checking',
        entityVersion: 'A-1',
        accountName: 'Synthetic checking',
        accountType: 'Checking',
        onBudget: true,
        hidden: false,
        sortableIndex: 0,
        lastReconciledDate: '2024-01-01',
        lastReconciledBalance: 9999.99,
      },
    ],
    masterCategories: [
      {
        entityType: 'masterCategory',
        entityId: 'living',
        entityVersion: 'A-2',
        name: 'Living',
        type: 'OUTFLOW',
        sortableIndex: 0,
        subCategories: [
          {
            entityType: 'category',
            entityId: 'food',
            entityVersion: 'A-3',
            name: 'Food',
            type: 'OUTFLOW',
            masterCategoryId: 'living',
            sortableIndex: 0,
            cachedBalance: 99999.99,
          },
        ],
      },
    ],
    payees: [
      { entityType: 'payee', entityId: 'shop', entityVersion: 'A-4', name: 'Synthetic shop' },
    ],
    monthlyBudgets: [
      {
        entityType: 'monthlyBudget',
        entityId: 'jan',
        entityVersion: 'A-5',
        month: '2024-01-01',
        monthlySubCategoryBudgets: [
          {
            entityType: 'monthlyCategoryBudget',
            entityId: 'jan-food',
            entityVersion: 'A-6',
            parentMonthlyBudgetId: 'jan',
            categoryId: 'food',
            budgeted: 30,
            overspendingHandling: 'Confined',
          },
        ],
      },
      {
        entityType: 'monthlyBudget',
        entityId: 'feb',
        entityVersion: 'A-9',
        month: '2024-02-01',
        monthlySubCategoryBudgets: [
          {
            entityType: 'monthlyCategoryBudget',
            entityId: 'feb-food',
            entityVersion: 'A-10',
            parentMonthlyBudgetId: 'feb',
            categoryId: 'food',
            budgeted: 0,
            overspendingHandling: null,
          },
        ],
      },
    ],
    transactions: [
      transaction('income', 'A-7', 100, 'Category/__ImmediateIncome__'),
      transaction('expense', 'A-8', -40, 'food'),
    ],
    scheduledTransactions: [],
  }
}
function transaction(
  entityId: string,
  entityVersion: string,
  amount: number | string,
  categoryId: string | null,
): Row {
  return {
    entityType: 'transaction',
    entityId,
    entityVersion,
    accountId: 'checking',
    date: '2024-01-01',
    amount,
    categoryId,
    cleared: 'Reconciled',
    payeeId: categoryId === 'food' ? 'shop' : null,
    subTransactions: [],
  }
}
function diff(startVersion: string, endVersion: string, items: Row[], shortDeviceId = 'A'): Row {
  return { dataVersion: '4.2', shortDeviceId, startVersion, endVersion, items }
}
function zipped(entries: Record<string, Row | string>, snapshot = full()): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [`${root}Budget.ymeta`]: strToU8(
      JSON.stringify({ formatVersion: '2', relativeDataFolderName: 'data1-ABC' }),
    ),
    [`${generation}device/Budget.yfull`]: strToU8(JSON.stringify(snapshot)),
  }
  for (const [name, value] of Object.entries(entries))
    files[name] = strToU8(typeof value === 'string' ? value : JSON.stringify(value))
  return zipSync(files, { level: 0 })
}

describe('YNAB archive reconstruction', () => {
  it('selects canonical active metadata and dominant knowledge, then replays files causally', () => {
    const older = full()
    ;(older.fileMetaData as Row).currentKnowledge = 'A-19,B-0'
    const bytes = zipped({
      [`${root}Budget (conflicted copy).ymeta`]: {
        formatVersion: '2',
        relativeDataFolderName: 'data0-OLD',
      },
      [`${root}data0-OLD/device/Budget.yfull`]: older,
      [`${generation}old-device/Budget.yfull`]: older,
      [`${generation}device/first-name-later.ydiff`]: diff('A-21,B-0', 'A-22,B-0', [
        transaction('late', 'A-22', -2, 'food'),
      ]),
      [`${generation}device/last-name-earlier.ydiff`]: diff(version, 'A-21,B-0', [
        transaction('early', 'A-21', -1, 'food'),
      ]),
    })
    const result = reconstructYnab(bytes)
    expect(result.report).toMatchObject({
      accounts: 1,
      transactions: 4,
      months: 2,
      replayedFiles: 2,
      fullKnowledge: version,
      finalKnowledge: 'A-22,B-0',
      errors: [],
    })
    expect(result.reconstructed.replayedPaths.map((path) => path.split('/').at(-1))).toEqual([
      'last-name-earlier.ydiff',
      'first-name-later.ydiff',
    ])
    expect(result.budget.transactions.find((row) => row.id === 'late')!.amount).toBe('-200')
    expect(result.budget.name).toBe('Synthetic')
  })

  it('rejects incomparable full snapshots and equal vectors with conflicting data', () => {
    const other = full()
    ;(other.fileMetaData as Row).currentKnowledge = 'A-19,B-1'
    expect(() =>
      reconstructRawYnab(zipped({ [`${generation}other/Budget.yfull`]: other })),
    ).toThrow('dominant full')
    ;(other.fileMetaData as Row).currentKnowledge = version
    ;(other.transactions as Row[])[0]!.amount = 101
    expect(() =>
      reconstructRawYnab(zipped({ [`${generation}other/Budget.yfull`]: other })),
    ).toThrow('conflicting entity states')
  })

  it('rejects missing predecessor files and missing entity revisions inside a range', () => {
    expect(() =>
      reconstructRawYnab(
        zipped({
          [`${generation}device/gap.ydiff`]: diff('A-21,B-0', 'A-22,B-0', [
            transaction('missing', 'A-22', -1, 'food'),
          ]),
        }),
      ),
    ).toThrow('missing causal predecessors')
    expect(() =>
      reconstructRawYnab(
        zipped({
          [`${generation}device/gap.ydiff`]: diff(version, 'A-22,B-0', [
            transaction('missing', 'A-22', -1, 'food'),
          ]),
        }),
      ),
    ).toThrow('omits an entity revision')
  })

  it('rejects ambiguous same-revision payloads and concurrent edits to the same entity', () => {
    expect(() =>
      reconstructRawYnab(
        zipped({
          [`${generation}device/one.ydiff`]: diff(version, 'A-21,B-0', [
            transaction('expense', 'A-21', -1, 'food'),
          ]),
          [`${generation}device/two.ydiff`]: diff(version, 'A-21,B-0', [
            transaction('expense', 'A-21', -2, 'food'),
          ]),
        }),
      ),
    ).toThrow('Ambiguous incremental')
    expect(() =>
      reconstructRawYnab(
        zipped({
          [`${generation}device/one.ydiff`]: diff(version, 'A-21,B-0', [
            transaction('expense', 'A-21', -1, 'food'),
          ]),
          [`${generation}device/two.ydiff`]: diff(
            version,
            'A-20,B-1',
            [transaction('expense', 'B-1', -2, 'food')],
            'B',
          ),
        }),
      ),
    ).toThrow('Concurrent entity revisions')
  })

  it('merges independent concurrent entities and ignores fully covered increments', () => {
    const result = reconstructYnab(
      zipped({
        [`${generation}device/one.ydiff`]: diff(version, 'A-21,B-0', [
          transaction('new-a', 'A-21', -1, 'food'),
        ]),
        [`${generation}device/two.ydiff`]: diff(
          version,
          'A-20,B-1',
          [transaction('new-b', 'B-1', -2, 'food')],
          'B',
        ),
        [`${generation}device/old.ydiff`]: diff('A-7,B-0', 'A-8,B-0', [
          transaction('expense', 'A-8', -40, 'food'),
        ]),
      }),
    )
    expect(result.report).toMatchObject({
      replayedFiles: 2,
      transactions: 4,
      finalKnowledge: 'A-21,B-1',
    })
  })

  it('checks entity-level knowledge and revision range authorship', () => {
    const entry = transaction('new', 'A-21', -1, 'food')
    entry.madeWithKnowledge = 'A-20,B-1'
    expect(() =>
      reconstructRawYnab(
        zipped({ [`${generation}device/one.ydiff`]: diff(version, 'A-21,B-0', [entry]) }),
      ),
    ).toThrow('Entity has missing causal predecessors')
    entry.entityVersion = 'B-1'
    expect(() =>
      reconstructRawYnab(
        zipped({ [`${generation}device/one.ydiff`]: diff(version, 'A-21,B-0', [entry]) }),
      ),
    ).toThrow('outside its revision range')
  })

  it('preserves deletion revisions and live legacy IDs without adding balance adjustments', () => {
    const deleted = { ...transaction('expense', 'A-21', -40, 'food'), isTombstone: true }
    const result = reconstructYnab(
      zipped({ [`${generation}device/delete.ydiff`]: diff(version, 'A-21,B-0', [deleted]) }),
    )
    expect(result.budget.transactions).toHaveLength(1)
    expect(result.budget.transactions[0]).toMatchObject({
      id: 'income',
      legacyId: 'income',
      amount: '10000',
      cleared: 'reconciled',
    })
    expect(result.budget.tombstones).toContainEqual({
      kind: 'transaction',
      id: 'expense',
      revision: 'A-21',
    })
    expect(result.budget.reconciliations).toEqual([])
    expect(result.report.warnings.join()).toContain(
      'Historical reconciliation events are unavailable',
    )
  })

  it('rejects unsafe entry paths, duplicate names, corrupt checksums and incomplete ZIPs', () => {
    expect(() => reconstructRawYnab(zipped({ '../outside.txt': 'x' }))).toThrow(
      'unsafe or duplicate',
    )
    const duplicate = Buffer.from(zipped({ 'aaaa/note.txt': 'a', 'bbbb/note.txt': 'b' }))
    let index = duplicate.indexOf('bbbb/note.txt')
    while (index >= 0) {
      duplicate.write('aaaa/note.txt', index)
      index = duplicate.indexOf('bbbb/note.txt')
    }
    expect(() => reconstructRawYnab(duplicate)).toThrow('unsafe or duplicate')
    const corrupt = Buffer.from(zipped({}))
    const position = corrupt.indexOf('"formatVersion":"2"')
    expect(position).toBeGreaterThan(0)
    corrupt[position + 17] = '3'.charCodeAt(0)
    expect(() => reconstructRawYnab(corrupt)).toThrow('integrity check')
    expect(() => reconstructRawYnab(zipped({}).subarray(0, -10))).toThrow('complete ZIP directory')
  })

  it('requires canonical metadata, a supported data format, and unique JSON keys', () => {
    expect(() =>
      reconstructRawYnab(
        zipped({
          [`${root}Budget.ymeta`]: { formatVersion: '3', relativeDataFolderName: 'data1-ABC' },
        }),
      ),
    ).toThrow('Unsupported YNAB metadata')
    expect(() =>
      reconstructRawYnab(
        zipped({ [`${root}Budget.ymeta`]: '{"formatVersion":"2","formatVersion":"3"}' }),
      ),
    ).toThrow()
    const unknown = full()
    ;(unknown.fileMetaData as Row).budgetDataVersion = '99'
    expect(() => reconstructRawYnab(zipped({}, unknown))).toThrow('Unsupported YNAB data version')
  })
})

describe('YNAB normalization and migration preview', () => {
  it('retains sparse overspending inheritance, future allocations and editable currency without conversion', () => {
    const result = reconstructYnab(zipped({}), 'EUR')
    expect(result.budget.currency).toBe('EUR')
    expect(result.budget.months).toEqual([
      { id: 'jan', month: '2024-01', legacyId: 'jan' },
      { id: 'feb', month: '2024-02', legacyId: 'feb' },
    ])
    expect(result.budget.allocations.map((row) => row.overspending)).toEqual(['Confined', null])
    const rows = calculateBudget(result.budget, '2024-01', '2024-02')
    expect(rows.map((row) => row.categories[0]!.balance)).toEqual([-1000n, -1000n])
    expect(rows.map((row) => row.available)).toEqual([7000n, 7000n])
    expect(ynabPreview(result, 'review-token')).toMatchObject({
      token: 'review-token',
      kind: 'ynab4',
      currency: 'EUR',
      accounts: 1,
      transactions: 2,
      months: 2,
      errors: [],
    })
  })

  it('parses raw JSON monetary tokens beyond safe floats exactly and rejects sub-cent input', () => {
    const text = JSON.stringify(full()).replace('"amount":100', '"amount":9007199254740993.27')
    const result = reconstructYnab(zipped({ [`${generation}device/Budget.yfull`]: text }))
    expect(result.budget.transactions[0]!.amount).toBe('900719925474099327')
    expect(ynabMinor('1.23e2')).toBe('12300')
    expect(ynabMinor('-1e-2')).toBe('-1')
    expect(ynabMinor('0.000000')).toBe('0')
    expect(() => ynabMinor('0.001')).toThrow('sub-cent')
  })

  it('preserves uncategorized transactions and exposes relational errors that block activation', () => {
    const snapshot = full()
    ;(snapshot.transactions as Row[])[1]!.categoryId = null
    const result = reconstructYnab(zipped({}, snapshot))
    expect(result.report).toMatchObject({ uncategorized: 1, errors: [] })
    ;(snapshot.transactions as Row[])[1]!.categoryId = 'missing-category'
    const invalid = reconstructYnab(zipped({}, snapshot))
    expect(invalid.report.errors.join()).toContain('missing category')
    expect(ynabPreview(invalid, 'token').errors.length).toBeGreaterThan(0)
  })

  it('maps reciprocal transfers without adding or removing source transactions', () => {
    const snapshot = full()
    ;(snapshot.accounts as Row[]).push({
      entityType: 'account',
      entityId: 'credit',
      entityVersion: 'A-11',
      accountName: 'Synthetic credit',
      accountType: 'CreditCard',
      onBudget: true,
      hidden: false,
      sortableIndex: 1,
    })
    ;(snapshot.transactions as Row[]).push(
      {
        ...transaction('out', 'A-12', -5, null),
        transferTransactionId: 'in',
        targetAccountId: 'credit',
      },
      {
        ...transaction('in', 'A-13', 5, null),
        accountId: 'credit',
        transferTransactionId: 'out',
        targetAccountId: 'checking',
      },
    )
    const result = reconstructYnab(zipped({}, snapshot))
    expect(result.report).toMatchObject({ transactions: 4, errors: [], uncategorized: 0 })
    expect(result.budget.transactions[2]!.transferId).toBe(
      result.budget.transactions[3]!.transferId,
    )
    expect(calculateBudget(result.budget, '2024-01', '2024-01')[0]!.categories[0]!.activity).toBe(
      -4000n,
    )
    ;(snapshot.transactions as Row[])[3]!.transferTransactionId = 'different'
    expect(() => reconstructYnab(zipped({}, snapshot))).toThrow('not reciprocal')
  })
})

describe('independent review regressions', () => {
  it('rejects empty identities, reused full revisions and orphan financial children', () => {
    const missing = full()
    ;(missing.transactions as Row[])[0]!.entityId = ''
    expect(() => reconstructYnab(zipped({}, missing))).toThrow('nonempty')
    const reused = full()
    ;(reused.transactions as Row[])[1]!.entityVersion = 'A-7'
    expect(() => reconstructYnab(zipped({}, reused))).toThrow('repeats an entity revision')
    const orphan = full()
    orphan.subTransactions = [
      {
        entityType: 'subTransaction',
        entityId: 'orphan',
        entityVersion: 'A-11',
        parentTransactionId: 'missing',
        amount: -1,
        categoryId: 'food',
      },
    ]
    expect(() => reconstructYnab(zipped({}, orphan))).toThrow('missing parent')
  })
})
