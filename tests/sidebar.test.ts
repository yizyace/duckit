import { describe, expect, it } from 'vitest'
import { demoBudget } from '../src/shared/demo'
import {
  defaultSidebarWidth,
  sidebarPreference,
  sidebarWidth,
} from '../src/renderer/src/lib/sidebar-width'
import { registerBalances } from '../src/renderer/src/views/register-model'

describe('local sidebar width preferences', () => {
  it('uses a safe default for unavailable or invalid preferences and clamps saved values', () => {
    for (const value of [null, '', ' ', 'bad', 'NaN', 'Infinity'])
      expect(sidebarPreference(value)).toBe(defaultSidebarWidth)
    expect(sidebarPreference('400')).toBe(400)
    expect(sidebarPreference('239')).toBe(240)
    expect(sidebarPreference('1000')).toBe(480)
  })

  it('keeps desktop resizing within the minimum, maximum and window fraction', () => {
    expect(sidebarWidth(100, 1440)).toBe(240)
    expect(sidebarWidth(600, 1440)).toBe(480)
    expect(sidebarWidth(480, 1000)).toBe(400)
    expect(sidebarWidth(480, 721)).toBeCloseTo(288.4)
    expect(sidebarWidth(320, 1440)).toBe(320)
  })
})

it('calculates a large posted ledger in one pass and refreshes historical edits and date rollover', () => {
  const budget = demoBudget()
  const template = budget.transactions[0]!
  let visits = 0
  budget.transactions = Array.from({ length: 50000 }, (_, index) => ({
    ...template,
    id: `sidebar-large-${index}`,
    get amount() {
      visits++
      return index % 2 ? '-900719925474099300000' : '900719925474099300001'
    },
  }))
  expect(registerBalances(budget, '2026-09-08').get('checking')?.balance).toBe(25000n)
  expect(visits).toBe(50000)
  budget.transactions = [
    { ...template, amount: '10000', date: '2026-09-01', cleared: 'uncleared' },
    { ...template, id: 'tomorrow', amount: '-1234', date: '2026-09-09' },
    { ...template, id: 'transfer-out', amount: '-500', transferId: 'transfer' },
    {
      ...template,
      id: 'transfer-in',
      amount: '500',
      accountId: 'savings',
      transferId: 'transfer',
    },
  ]
  expect(registerBalances(budget, '2026-09-08').get('checking')).toEqual({
    balance: 9500n,
    cleared: -500n,
  })
  expect(registerBalances(budget, '2026-09-08').get('savings')?.balance).toBe(500n)
  budget.transactions[0] = { ...budget.transactions[0]!, amount: '9000' }
  expect(registerBalances(budget, '2026-09-08').get('checking')?.balance).toBe(8500n)
  expect(registerBalances(budget, '2026-09-09').get('checking')?.balance).toBe(7266n)
})
