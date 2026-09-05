import { describe, expect, it } from 'vitest'
import {
  budgetSchema,
  type Allocation,
  type Budget,
  type Schedule,
  type Transaction,
} from '../src/shared/contracts'
import {
  accountBalance,
  addDays,
  addMonths,
  applyChanges,
  calculateBudget,
  formatMoney,
  monthsBetween,
  nextOccurrence,
  parseMoney,
  reports,
  validateBudget,
} from '../src/engine'

function budget(): Budget {
  return budgetSchema.parse({
    schemaVersion: 1,
    id: 'synthetic',
    name: 'Synthetic test',
    currency: 'USD',
    revision: 0,
    startMonth: '2024-01',
    accounts: [
      { id: 'checking', name: 'Checking', type: 'checking', onBudget: true, closed: false },
      { id: 'credit', name: 'Credit card', type: 'credit', onBudget: true, closed: false },
      { id: 'asset', name: 'Investment', type: 'asset', onBudget: false, closed: false },
    ],
    groups: [{ id: 'living', name: 'Living', sort: 0 }],
    categories: [
      { id: 'food', groupId: 'living', name: 'Food', sort: 0, hidden: false, debt: false },
      { id: 'travel', groupId: 'living', name: 'Travel', sort: 1, hidden: false, debt: false },
      { id: 'debt', groupId: 'living', name: 'Pre-YNAB debt', sort: 2, hidden: false, debt: true },
    ],
    payees: [],
    transactions: [],
    allocations: [],
    schedules: [],
    reconciliations: [],
    provenance: [],
    tombstones: [],
  })
}

function transaction(
  id: string,
  amount: string,
  categoryId: string | null,
  date = '2024-01-15',
  extra: Partial<Transaction> = {},
): Transaction {
  return {
    id,
    accountId: 'checking',
    date,
    payeeId: null,
    memo: '',
    amount,
    cleared: 'uncleared',
    splits: [{ id: `${id}:split`, amount, categoryId, incomeMonth: null, memo: '' }],
    transferId: null,
    bankId: null,
    legacyId: null,
    ...extra,
  }
}

function income(id: string, amount: string, date: string, month: string): Transaction {
  return transaction(id, amount, null, date, {
    splits: [{ id: `${id}:split`, amount, categoryId: null, incomeMonth: month, memo: '' }],
  })
}

function allocation(
  categoryId: string,
  month: string,
  amount: string,
  overspending: Allocation['overspending'] = null,
): Allocation {
  return { categoryId, month, amount, overspending, note: '' }
}

const options = { commandId: 'synthetic-command' }

describe('lossless money and calendar arithmetic', () => {
  it('parses beyond Number.MAX_SAFE_INTEGER and formats every minor unit exactly', () => {
    expect(parseMoney('9007199254740993.27')).toBe(900719925474099327n)
    expect(formatMoney(900719925474099327n)).toBe('9007199254740993.27')
    expect(formatMoney(parseMoney('-0.01'))).toBe('-0.01')
    expect(parseMoney(' +0012.3400 ')).toBe(1234n)
    expect(parseMoney('-.01')).toBe(-1n)
    expect(parseMoney('1.')).toBe(100n)
    expect(formatMoney(parseMoney('-0.00'))).toBe('0.00')
    expect(parseMoney('123', 0)).toBe(123n)
    expect(formatMoney(parseMoney('1.234', 3), 3)).toBe('1.234')
  })

  it.each(['1.001', '1e3', 'NaN', '1,234.00', '', '.', 'Infinity'])(
    'rejects ambiguous or lossy money %s',
    (value) => {
      expect(() => parseMoney(value)).toThrow()
    },
  )

  it('uses leap-year calendar dates and checks range without timezones', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01')
    expect(addMonths('2024-01', -1)).toBe('2023-12')
    expect(monthsBetween('2023-12', '2024-02')).toEqual(['2023-12', '2024-01', '2024-02'])
    expect(() => addDays('2023-02-29', 1)).toThrow()
    expect(() => addMonths('0001-01', -1)).toThrow()
    expect(() => addMonths('9999-12', 1)).toThrow()
  })

  it('keeps monthly and leap-day recurrence anchors across shortened months', () => {
    expect(nextOccurrence('2024-01-31', 'monthly')).toBe('2024-02-29')
    expect(nextOccurrence('2024-02-29', 'monthly', '2024-01-31')).toBe('2024-03-31')
    expect(nextOccurrence('2025-02-28', 'yearly', '2024-02-29')).toBe('2026-02-28')
    expect(nextOccurrence('2027-02-28', 'yearly', '2024-02-29')).toBe('2028-02-29')
    expect(nextOccurrence('2024-11-30', 'quarterly')).toBe('2025-02-28')
  })
})

describe('Classic budget calculation with hand-computed cents', () => {
  it('holds next-month income, carries unused money, and charges red overspending once in the next month', () => {
    const data = budget()
    data.transactions = [
      income('pay', '100000', '2024-01-01', '2024-01'),
      income('deferred', '20000', '2024-01-20', '2024-02'),
      transaction('food', '-60000', 'food'),
    ]
    data.allocations = [
      allocation('food', '2024-01', '50000'),
      allocation('travel', '2024-03', '5000'),
    ]
    const [jan, feb, mar] = calculateBudget(data, '2024-01', '2024-03')
    expect(jan).toMatchObject({
      income: 100000n,
      budgeted: 50000n,
      available: 50000n,
      overspending: 0n,
    })
    expect(jan!.categories[0]).toMatchObject({
      activity: -60000n,
      balance: -10000n,
      overspending: 'AffectsBuffer',
    })
    expect(feb).toMatchObject({ income: 20000n, available: 60000n, overspending: 10000n })
    expect(feb!.categories[0]!.balance).toBe(0n)
    expect(mar).toMatchObject({ available: 55000n, overspending: 0n })
  })

  it('inherits Confined through absent and null overrides until an explicit change', () => {
    const data = budget()
    data.transactions = [
      income('pay', '10000', '2024-01-01', '2024-01'),
      transaction('food', '-2000', 'food'),
    ]
    data.allocations = [
      allocation('food', '2024-01', '1000', 'Confined'),
      allocation('food', '2024-03', '200', null),
      allocation('food', '2024-04', '0', 'AffectsBuffer'),
    ]
    const rows = calculateBudget(data, '2024-01', '2024-06')
    expect(rows.map((row) => row.categories[0]!.balance)).toEqual([
      -1000n,
      -1000n,
      -800n,
      -800n,
      0n,
      0n,
    ])
    expect(rows.map((row) => row.available)).toEqual([9000n, 9000n, 8800n, 8800n, 8000n, 8000n])
    expect(rows.map((row) => row.overspending)).toEqual([0n, 0n, 0n, 0n, 800n, 0n])
  })

  it('uses the preceding month setting to determine carry-in even when the next month changes its rule', () => {
    const data = budget()
    data.transactions = [transaction('food', '-500', 'food')]
    data.allocations = [allocation('food', '2024-02', '0', 'Confined')]
    const [jan, feb, mar] = calculateBudget(data, '2024-01', '2024-03')
    expect(jan!.categories[0]!.balance).toBe(-500n)
    expect(feb).toMatchObject({ available: -500n, overspending: 500n })
    expect(feb!.categories[0]).toMatchObject({ carryIn: 0n, balance: 0n, overspending: 'Confined' })
    expect(mar!.overspending).toBe(0n)
  })

  it('recomputes history even when requesting a later range and retains future allocations', () => {
    const data = budget()
    data.transactions = [
      income('pay', '10000', '2023-12-20', '2024-01'),
      transaction('food', '-1500', 'food'),
    ]
    data.allocations = [
      allocation('food', '2024-01', '1000'),
      allocation('travel', '2026-05', '2000'),
    ]
    expect(calculateBudget(data, '2026-05', '2026-05')[0]!.available).toBe(6500n)
    data.transactions[1] = transaction('food', '-700', 'food')
    const may = calculateBudget(data, '2026-05', '2026-05')[0]!
    expect(may.available).toBe(7000n)
    expect(may.categories[0]!.balance).toBe(300n)
    expect(may.categories[1]!.budgeted).toBe(2000n)
  })

  it('accounts for split refunds, negative allocations, and Classic debt categories', () => {
    const data = budget()
    data.transactions = [
      income('pay', '10000', '2024-01-01', '2024-01'),
      transaction('opening-debt', '-5000', 'debt', '2024-01-01', { accountId: 'credit' }),
      transaction('mixed', '-1200', 'food', '2024-01-15', {
        splits: [
          { id: 'mixed-food', amount: '-1500', categoryId: 'food', incomeMonth: null, memo: '' },
          { id: 'mixed-refund', amount: '300', categoryId: 'travel', incomeMonth: null, memo: '' },
        ],
      }),
    ]
    data.allocations = [
      allocation('debt', '2024-01', '1000', 'Confined'),
      allocation('food', '2024-01', '2000'),
      allocation('travel', '2024-01', '-300'),
    ]
    const jan = calculateBudget(data, '2024-01', '2024-01')[0]!
    expect(jan).toMatchObject({ budgeted: 2700n, available: 7300n })
    expect(jan.categories.map((row) => row.balance)).toEqual([500n, 0n, -4000n])
    expect(accountBalance(data, 'credit')).toBe(-5000n)
    expect(validateBudget(data)).toEqual([])
  })

  it('confines a debt category by default until a later month sets AffectsBuffer', () => {
    const data = budget()
    data.transactions = [
      income('pay', '300000', '2024-01-01', '2024-01'),
      income('pay2', '300000', '2024-02-01', '2024-02'),
      transaction('opening-debt', '-500000', 'debt', '2024-01-01', { accountId: 'credit' }),
    ]
    data.allocations = [
      allocation('debt', '2024-01', '50000'),
      allocation('debt', '2024-03', '0', 'AffectsBuffer'),
    ]
    const [jan, feb, mar, apr] = calculateBudget(data, '2024-01', '2024-04')
    expect(feb).toMatchObject({ availableBeforeBudget: 550000n, overspending: 0n })
    expect(feb!.categories[2]).toMatchObject({ carryIn: -450000n, balance: -450000n })
    expect(jan).toMatchObject({ available: 250000n, overspending: 0n })
    expect(jan!.categories[2]).toMatchObject({ balance: -450000n, overspending: 'Confined' })
    expect(feb!.categories[0]).toMatchObject({ balance: 0n, overspending: 'AffectsBuffer' })
    expect(mar).toMatchObject({ available: 550000n, overspending: 0n })
    expect(mar!.categories[2]).toMatchObject({ balance: -450000n, overspending: 'AffectsBuffer' })
    expect(apr).toMatchObject({ availableBeforeBudget: 100000n, overspending: 450000n })
    expect(apr!.categories[2]).toMatchObject({
      carryIn: 0n,
      balance: 0n,
      overspending: 'AffectsBuffer',
    })
  })

  it('lets an explicit AffectsBuffer on a debt category charge the buffer as before', () => {
    const data = budget()
    data.transactions = [
      income('pay', '300000', '2024-01-01', '2024-01'),
      income('pay2', '300000', '2024-02-01', '2024-02'),
      transaction('opening-debt', '-500000', 'debt', '2024-01-01', { accountId: 'credit' }),
    ]
    data.allocations = [allocation('debt', '2024-01', '50000', 'AffectsBuffer')]
    const [jan, feb] = calculateBudget(data, '2024-01', '2024-02')
    expect(jan!.categories[2]).toMatchObject({ balance: -450000n, overspending: 'AffectsBuffer' })
    expect(feb).toMatchObject({ availableBeforeBudget: 100000n, overspending: 450000n })
    expect(feb!.categories[2]).toMatchObject({ carryIn: 0n, balance: 0n })
  })

  it('keeps uncategorized entries visible without inventing categories or income', () => {
    const data = budget()
    data.transactions = [transaction('unknown', '-123', null)]
    expect(validateBudget(data)).toEqual([])
    expect(calculateBudget(data, '2024-01', '2024-01')[0]).toMatchObject({
      uncategorized: -123n,
      income: 0n,
    })
    expect(accountBalance(data, 'checking')).toBe(-123n)
  })
})

describe('transfers, balances, and historical reports', () => {
  it('keeps credit payments out of spending and counts only budget-side external transfers', () => {
    const data = budget()
    data.transactions = [
      income('pay', '10000', '2024-01-01', '2024-01'),
      transaction('charge', '-2000', 'food', '2024-01-02', { accountId: 'credit' }),
      transaction('payment-out', '-2000', null, '2024-01-03', { transferId: 'payment' }),
      transaction('payment-in', '2000', null, '2024-01-03', {
        accountId: 'credit',
        transferId: 'payment',
      }),
      transaction('invest-out', '-1000', 'travel', '2024-01-04', { transferId: 'invest' }),
      transaction('invest-in', '1000', null, '2024-01-04', {
        accountId: 'asset',
        transferId: 'invest',
      }),
    ]
    expect(validateBudget(data)).toEqual([])
    expect(accountBalance(data, 'checking')).toBe(7000n)
    expect(accountBalance(data, 'credit')).toBe(0n)
    expect(accountBalance(data, 'asset')).toBe(1000n)
    const jan = calculateBudget(data, '2024-01', '2024-01')[0]!
    expect(jan.categories.map((row) => row.activity)).toEqual([-2000n, -1000n, 0n])
    expect(jan.uncategorized).toBe(0n)
    expect(reports(data, '2024-01', '2024-01')[0]).toMatchObject({
      income: 10000n,
      spending: 3000n,
      netWorth: 8000n,
    })
  })

  it('reports cash-date income and all-account net worth through month end', () => {
    const data = budget()
    data.transactions = [
      income('old', '1000', '2023-12-01', '2023-12'),
      income('deferred', '4000', '2024-01-31', '2024-02'),
      transaction('spend', '-600', 'food', '2024-02-01', { cleared: 'cleared' }),
      transaction('refund', '100', 'food', '2024-02-02'),
      transaction('future', '-700', 'food', '2024-03-01'),
      transaction('asset', '10000', null, '2024-01-03', { accountId: 'asset' }),
    ]
    const [jan, feb] = reports(data, '2024-01', '2024-02')
    expect(jan).toMatchObject({ income: 4000n, spending: 0n, netWorth: 15000n })
    expect(feb).toMatchObject({ income: 0n, spending: 500n, netWorth: 14500n })
    expect(reports(data, '2024-02', '2024-02')[0]).toEqual(feb)
    expect(accountBalance(data, 'checking', '2024-02-01')).toBe(4400n)
    expect(accountBalance(data, 'checking', '2024-02-29', true)).toBe(-600n)
    expect(() => accountBalance(data, 'missing')).toThrow('Account does not exist')
  })
})

describe('atomic domain mutations', () => {
  it('validates transfers after the entire batch and deletes both sides with tombstones', () => {
    const original = budget()
    const left = transaction('left', '-100', null, '2024-01-01', { transferId: 'pair' })
    const right = transaction('right', '100', null, '2024-01-01', {
      accountId: 'credit',
      transferId: 'pair',
    })
    expect(() =>
      applyChanges(original, [{ type: 'transaction.put', value: left }], options),
    ).toThrow('exactly two')
    expect(original.transactions).toEqual([])
    const saved = applyChanges(
      original,
      [
        { type: 'transaction.put', value: left },
        { type: 'transaction.put', value: right },
      ],
      options,
    )
    expect(saved.revision).toBe(0)
    expect(saved.transactions).toHaveLength(2)
    const deleted = applyChanges(saved, [{ type: 'transaction.delete', ids: ['left'] }], options)
    expect(deleted.transactions).toEqual([])
    expect(
      deleted.tombstones.filter((row) => row.kind === 'transaction').map((row) => row.id),
    ).toEqual(['left', 'right'])
    expect(saved.transactions).toHaveLength(2)
  })

  it('rejects unbalanced splits, nonexistent references, invalid income timing, and duplicate rows', () => {
    const data = budget()
    data.transactions = [transaction('bad', '-100', 'food', '2024-01-01', { amount: '-101' })]
    expect(validateBudget(data).join()).toContain('Splits do not equal')
    data.transactions = [transaction('bad', '-100', 'missing')]
    expect(validateBudget(data).join()).toContain('missing category')
    data.transactions = [income('bad', '100', '2024-01-01', '2024-03')]
    expect(validateBudget(data).join()).toContain('current or next month')
    data.transactions = []
    data.allocations = [allocation('food', '2024-01', '0'), allocation('food', '2024-01', '1')]
    expect(validateBudget(data).join()).toContain('Duplicate allocation')
  })

  it('requires explicit budget-side categorization for an off-budget transfer', () => {
    const data = budget()
    data.transactions = [
      transaction('left', '-100', null, '2024-01-01', { transferId: 'pair' }),
      transaction('right', '100', null, '2024-01-01', { accountId: 'asset', transferId: 'pair' }),
    ]
    expect(validateBudget(data).join()).toContain('requires category or income')
    data.transactions[0]!.splits[0]!.categoryId = 'food'
    expect(validateBudget(data)).toEqual([])
  })

  it('rejects duplicate tombstones and entities that are simultaneously live and deleted', () => {
    const data = budget()
    data.tombstones = [
      { kind: 'transaction', id: 'deleted', revision: '1' },
      { kind: 'transaction', id: 'deleted', revision: '2' },
      { kind: 'account', id: 'checking', revision: '1' },
    ]
    expect(validateBudget(data).join()).toContain('Duplicate tombstone')
    expect(validateBudget(data).join()).toContain('Live account checking is also tombstoned')
    data.tombstones = [{ kind: 'transaction', id: 'live', revision: '1' }]
    data.transactions = [transaction('live', '100', null)]
    expect(validateBudget(data).join()).toContain('Live transaction live is also tombstoned')
  })

  it('reconciles exact cleared totals only, retaining uncleared and future entries', () => {
    const data = budget()
    data.transactions = [
      transaction('cleared', '1000', null, '2024-01-01', { cleared: 'cleared' }),
      transaction('uncleared', '-100', 'food'),
      transaction('future', '-300', 'food', '2024-02-01', { cleared: 'cleared' }),
    ]
    expect(() =>
      applyChanges(
        data,
        [{ type: 'reconcile', accountId: 'checking', date: '2024-01-31', balance: '900' }],
        options,
      ),
    ).toThrow('Cleared balance does not match')
    const saved = applyChanges(
      data,
      [{ type: 'reconcile', accountId: 'checking', date: '2024-01-31', balance: '1000' }],
      options,
    )
    expect(saved.transactions.map((row) => row.cleared)).toEqual([
      'reconciled',
      'uncleared',
      'cleared',
    ])
    expect(saved.reconciliations[0]).toMatchObject({ balance: '1000', transactionIds: ['cleared'] })
    expect(data.transactions[0]!.cleared).toBe('cleared')
    const deleted = applyChanges(saved, [{ type: 'transaction.delete', ids: ['cleared'] }], options)
    expect(validateBudget(deleted)).toEqual([])
    expect(deleted.reconciliations).toEqual(saved.reconciliations)
  })

  it('bulk clear is all-or-nothing and history operations belong to persistence', () => {
    const data = budget()
    data.transactions = [transaction('one', '100', null)]
    expect(() =>
      applyChanges(
        data,
        [{ type: 'transaction.clear', ids: ['one', 'missing'], cleared: 'cleared' }],
        options,
      ),
    ).toThrow('does not exist')
    expect(data.transactions[0]!.cleared).toBe('uncleared')
    expect(() => applyChanges(data, [{ type: 'undo' }], options)).toThrow('persistence')
  })

  it('rejects reconciliation references from a different account or after the statement date', () => {
    const data = budget()
    data.transactions = [
      transaction('other', '-100', 'food', '2024-02-01', { accountId: 'credit' }),
    ]
    data.reconciliations = [
      {
        id: 'record',
        accountId: 'checking',
        date: '2024-01-31',
        balance: '0',
        transactionIds: ['other'],
      },
    ]
    expect(validateBudget(data).join()).toContain('another account')
    expect(validateBudget(data).join()).toContain('after its statement date')
  })

  it('validates many months of reconciliation records within a bounded multiple of no-reconciliation time', () => {
    // Guards against reintroducing a per-id linear scan of transactions/accounts:
    // this fixture mirrors the audit repro (96 months, 100 tx/month, reconciliations
    // that each list every cleared transaction to date). Comparing against a
    // same-run, same-machine baseline (instead of an absolute bound) keeps this
    // deterministic under CI/CPU contention: before the Map-based lookups, validating
    // it took ~240x as long as the same budget with no reconciliation records; after,
    // ~4x. An untimed warm-up plus taking the minimum of three timed runs per side
    // damps scheduler/GC jitter on the small no-reconciliation sample, and the
    // assertion's additive slack covers what jitter remains — a genuine quadratic
    // regression is 50-200x and still fails either way. A zero-errors assertion
    // alone would not catch that regression, so this asserts the timing ratio too.
    const data = budget()
    const months = 96
    const perMonth = 100
    let month = '2024-01'
    for (let m = 0; m < months; m++) {
      const paycheck = income(`inc-${m}`, '500000', `${month}-01`, month)
      paycheck.cleared = 'cleared'
      data.transactions.push(paycheck)
      for (let i = 0; i < perMonth; i++) {
        const day = String(1 + (i % 28)).padStart(2, '0')
        data.transactions.push(
          transaction(
            `t-${m}-${i}`,
            String(-(100 + i)),
            i % 2 ? 'food' : 'travel',
            `${month}-${day}`,
            { cleared: 'cleared' },
          ),
        )
      }
      month = addMonths(month, 1)
    }
    month = '2024-01'
    for (let m = 0; m < months; m++) {
      const date = `${month}-28`
      data.reconciliations.push({
        id: `rec-${m}`,
        accountId: 'checking',
        date,
        balance: '0',
        transactionIds: data.transactions
          .filter((row) => row.accountId === 'checking' && row.date <= date)
          .map((row) => row.id),
      })
      month = addMonths(month, 1)
    }
    const withoutReconciliations = structuredClone(data)
    withoutReconciliations.reconciliations = []
    validateBudget(withoutReconciliations) // untimed warm-up

    const timeValidate = (input: Budget): { ms: number; errors: string[] } => {
      let ms = Infinity
      let errors: string[] = []
      for (let i = 0; i < 3; i++) {
        const start = performance.now()
        errors = validateBudget(input)
        ms = Math.min(ms, performance.now() - start)
      }
      return { ms, errors }
    }
    const withRecs = timeValidate(data)
    const withoutRecs = timeValidate(withoutReconciliations)

    expect(withRecs.errors).toEqual([])
    expect(withoutRecs.errors).toEqual([])
    expect(withRecs.ms).toBeLessThan(10 * withoutRecs.ms + 100)
  })

  it('posts monthly schedules once, preserves the day anchor, and shifts deferred income', () => {
    const data = budget()
    const schedule: Schedule = {
      id: 'salary',
      nextDate: '2024-01-31',
      frequency: 'monthly',
      endDate: '2024-03-31',
      enabled: true,
      transaction: income('template', '1000', '2024-01-31', '2024-02'),
    }
    data.schedules = [schedule]
    const feb = applyChanges(data, [{ type: 'schedule.run', through: '2024-02-29' }], options)
    expect(feb.transactions.map((row) => row.date)).toEqual(['2024-01-31', '2024-02-29'])
    expect(feb.transactions.map((row) => row.splits[0]!.incomeMonth)).toEqual([
      '2024-02',
      '2024-03',
    ])
    expect(feb.schedules[0]!.nextDate).toBe('2024-03-31')
    const repeated = applyChanges(feb, [{ type: 'schedule.run', through: '2024-02-29' }], options)
    expect(repeated).toEqual(feb)
    const ended = applyChanges(feb, [{ type: 'schedule.run', through: '2024-12-31' }], options)
    expect(ended.transactions).toHaveLength(3)
    expect(ended.schedules[0]!.enabled).toBe(false)
    expect(validateBudget(ended)).toEqual([])
  })

  it('rejects schedule IDs that cannot produce bounded transaction and split IDs', () => {
    const data = budget()
    data.schedules = [
      {
        id: 'x'.repeat(179),
        nextDate: '2024-01-01',
        frequency: 'monthly',
        endDate: null,
        enabled: true,
        transaction: transaction('template', '-100', 'food', '2024-01-01'),
      },
    ]
    expect(validateBudget(data).join()).toContain('IDs are too long for generated occurrences')
  })

  it('posts both scheduled transfer legs atomically with occurrence-specific links', () => {
    const data = budget()
    data.schedules = [
      {
        id: 'out',
        nextDate: '2024-01-01',
        frequency: 'weekly',
        endDate: null,
        enabled: true,
        transaction: transaction('out-template', '-100', null, '2024-01-01', {
          transferId: 'automatic',
        }),
      },
      {
        id: 'in',
        nextDate: '2024-01-01',
        frequency: 'weekly',
        endDate: null,
        enabled: true,
        transaction: transaction('in-template', '100', null, '2024-01-01', {
          accountId: 'credit',
          transferId: 'automatic',
        }),
      },
    ]
    const saved = applyChanges(data, [{ type: 'schedule.run', through: '2024-01-08' }], options)
    expect(saved.transactions).toHaveLength(4)
    expect(new Set(saved.transactions.map((row) => row.transferId)).size).toBe(2)
    expect(validateBudget(saved)).toEqual([])
    expect(accountBalance(saved, 'checking')).toBe(-200n)
    expect(accountBalance(saved, 'credit')).toBe(200n)
    expect(calculateBudget(saved, '2024-01', '2024-01')[0]!.income).toBe(0n)
  })
})

describe('mixed split transfers', () => {
  function mixed(): Transaction {
    return transaction('mixed', '-300', 'food', '2024-01-01', {
      splits: [
        { id: 'food-split', amount: '-200', categoryId: 'food', incomeMonth: null, memo: '' },
        {
          id: 'transfer-split',
          amount: '-100',
          categoryId: null,
          incomeMonth: null,
          memo: '',
          transferId: 'mixed-pair',
        },
      ],
    })
  }
  function counterpart(): Transaction {
    return transaction('counterpart', '100', null, '2024-01-01', {
      accountId: 'credit',
      transferId: 'mixed-pair',
    })
  }

  it('excludes only transferred budget splits and preserves unrelated spending', () => {
    const data = budget()
    data.transactions = [mixed(), counterpart()]
    expect(validateBudget(data)).toEqual([])
    const jan = calculateBudget(data, '2024-01', '2024-01')[0]!
    expect(jan.categories[0]!.activity).toBe(-200n)
    expect(jan.uncategorized).toBe(0n)
    expect(reports(data, '2024-01', '2024-01')[0]).toMatchObject({
      income: 0n,
      spending: 200n,
      netWorth: -200n,
    })
    expect(accountBalance(data, 'checking')).toBe(-300n)
    expect(accountBalance(data, 'credit')).toBe(100n)
  })

  it('keeps explicit category treatment on a split transferred off budget', () => {
    const data = budget()
    const left = mixed()
    left.splits[1]!.categoryId = 'travel'
    const right = counterpart()
    right.accountId = 'asset'
    data.transactions = [left, right]
    expect(validateBudget(data)).toEqual([])
    expect(
      calculateBudget(data, '2024-01', '2024-01')[0]!.categories.map((row) => row.activity),
    ).toEqual([-200n, -100n, 0n])
    expect(reports(data, '2024-01', '2024-01')[0]).toMatchObject({
      spending: 300n,
      netWorth: -200n,
    })
  })

  it('deletes a selected whole leg while retaining and rebalancing unrelated counterpart splits', () => {
    const data = budget()
    data.transactions = [mixed(), counterpart()]
    const saved = applyChanges(
      data,
      [{ type: 'transaction.delete', ids: ['counterpart'] }],
      options,
    )
    expect(saved.transactions).toHaveLength(1)
    expect(saved.transactions[0]).toMatchObject({ id: 'mixed', amount: '-200' })
    expect(saved.transactions[0]!.splits.map((split) => split.id)).toEqual(['food-split'])
    expect(saved.tombstones).toContainEqual({ kind: 'split', id: 'transfer-split', revision: '1' })
    expect(validateBudget(saved)).toEqual([])
    expect(data.transactions[0]!.amount).toBe('-300')
    const deleted = applyChanges(data, [{ type: 'transaction.delete', ids: ['mixed'] }], options)
    expect(deleted.transactions).toEqual([])
  })

  it('pairs two mixed transactions and preserves a surviving expense when the other is deleted', () => {
    const data = budget()
    const right = transaction('right', '50', 'debt', '2024-01-01', {
      accountId: 'credit',
      splits: [
        {
          id: 'right-transfer',
          amount: '100',
          categoryId: null,
          incomeMonth: null,
          memo: '',
          transferId: 'mixed-pair',
        },
        { id: 'right-expense', amount: '-50', categoryId: 'debt', incomeMonth: null, memo: '' },
      ],
    })
    data.transactions = [mixed(), right]
    expect(validateBudget(data)).toEqual([])
    expect(reports(data, '2024-01', '2024-01')[0]).toMatchObject({
      spending: 250n,
      netWorth: -250n,
    })
    const saved = applyChanges(data, [{ type: 'transaction.delete', ids: ['mixed'] }], options)
    expect(saved.transactions).toHaveLength(1)
    expect(saved.transactions[0]).toMatchObject({
      id: 'right',
      amount: '-50',
      splits: [{ id: 'right-expense' }],
    })
  })

  it('rejects ambiguous header/split links and unpaired or unequal split amounts', () => {
    const data = budget()
    data.transactions = [mixed(), counterpart()]
    data.transactions[0]!.transferId = 'whole-pair'
    expect(validateBudget(data).join()).toContain('cannot combine whole and split')
    data.transactions[0]!.transferId = null
    data.transactions[1]!.splits[0]!.amount = '101'
    data.transactions[1]!.amount = '101'
    expect(validateBudget(data).join()).toContain('amounts must cancel')
    data.transactions.pop()
    expect(validateBudget(data).join()).toContain('exactly two')
  })

  it('posts mixed transfer schedules with unique paired links on each occurrence', () => {
    const data = budget()
    data.schedules = [
      {
        id: 'mixed-schedule',
        nextDate: '2024-01-01',
        frequency: 'monthly',
        endDate: null,
        enabled: true,
        transaction: mixed(),
      },
      {
        id: 'counter-schedule',
        nextDate: '2024-01-01',
        frequency: 'monthly',
        endDate: null,
        enabled: true,
        transaction: counterpart(),
      },
    ]
    const saved = applyChanges(data, [{ type: 'schedule.run', through: '2024-02-01' }], options)
    expect(validateBudget(saved)).toEqual([])
    expect(saved.transactions).toHaveLength(4)
    expect(accountBalance(saved, 'checking')).toBe(-600n)
    expect(accountBalance(saved, 'credit')).toBe(200n)
    expect(reports(saved, '2024-01', '2024-02').map((row) => row.spending)).toEqual([200n, 200n])
    const transferIds = saved.transactions
      .flatMap((row) => [row.transferId, ...row.splits.map((split) => split.transferId)])
      .filter(Boolean)
    expect(new Set(transferIds).size).toBe(2)
    data.schedules[1]!.frequency = 'weekly'
    expect(validateBudget(data).join()).toContain('must share recurrence and anchor')
  })
})
