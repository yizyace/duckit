import { type Budget } from './contracts'
export function emptyBudget(
  id: string,
  name: string,
  currency = 'USD',
  startMonth = '2026-09',
): Budget {
  return {
    schemaVersion: 1,
    id,
    name,
    currency,
    revision: 0,
    startMonth,
    accounts: [],
    groups: [],
    categories: [],
    payees: [],
    transactions: [],
    allocations: [],
    schedules: [],
    reconciliations: [],
    provenance: [],
    tombstones: [],
  }
}
export function demoBudget(): Budget {
  const b = emptyBudget('demo-budget', 'Everyday budget')
  b.accounts = [
    {
      id: 'checking',
      name: 'Checking',
      type: 'checking',
      onBudget: true,
      closed: false,
      note: '',
      legacyId: null,
    },
    {
      id: 'savings',
      name: 'Savings',
      type: 'savings',
      onBudget: true,
      closed: false,
      note: '',
      legacyId: null,
    },
  ]
  b.groups = [
    { id: 'essentials', name: 'Everyday essentials', sort: 0, hidden: false },
    { id: 'future', name: 'Looking ahead', sort: 1, hidden: false },
  ]
  b.categories = [
    'Groceries',
    'Rent',
    'Transport',
    'Coffee & dining',
    'Emergency fund',
    'Travel',
  ].map((name, i) => ({
    id: `cat-${i}`,
    name,
    groupId: i < 4 ? 'essentials' : 'future',
    sort: i,
    hidden: false,
    debt: false,
    legacyId: null,
  }))
  b.payees = [
    { id: 'employer', name: 'Employer', legacyId: null },
    { id: 'market', name: 'Neighborhood Market', legacyId: null },
  ]
  b.transactions = [
    {
      id: 'income',
      accountId: 'checking',
      date: '2026-09-01',
      payeeId: 'employer',
      memo: 'September income',
      amount: '420000',
      cleared: 'cleared',
      splits: [
        {
          id: 'income-split',
          amount: '420000',
          categoryId: null,
          incomeMonth: '2026-09',
          memo: '',
        },
      ],
      transferId: null,
      bankId: null,
      legacyId: null,
    },
    {
      id: 'groceries',
      accountId: 'checking',
      date: '2026-09-03',
      payeeId: 'market',
      memo: '',
      amount: '-8642',
      cleared: 'uncleared',
      splits: [
        { id: 'grocery-split', amount: '-8642', categoryId: 'cat-0', incomeMonth: null, memo: '' },
      ],
      transferId: null,
      bankId: null,
      legacyId: null,
    },
  ]
  b.allocations = ['50000', '160000', '15000', '24000', '70000', '30000'].map((amount, i) => ({
    categoryId: `cat-${i}`,
    month: '2026-09',
    amount,
    overspending: null,
    note: '',
  }))
  return b
}
