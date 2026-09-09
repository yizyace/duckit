import { describe, expect, it } from 'vitest'
import { demoBudget } from '../src/shared/demo'
import { reports } from '../src/engine'
import {
  axisAmount,
  categoryTotals,
  chartScale,
  reportPreset,
} from '../src/renderer/src/views/report-model'

describe('report chart projection', () => {
  it('scales negative, zero and enormous money without first converting it to Number', () => {
    const enormous = 10n ** 400n
    const scale = chartScale([-enormous, 0n, enormous])
    expect(scale.fraction(-enormous)).toBe(0)
    expect(scale.fraction(0n)).toBe(0.5)
    expect(scale.fraction(enormous)).toBe(1)
    expect(scale.ticks).toEqual([-enormous, -enormous / 2n, 0n, enormous / 2n, enormous])
    expect(chartScale([0n]).fraction(0n)).toBe(0)
    expect(chartScale([-1n]).max).toBe(0n)
    expect(chartScale([-1n]).ticks).toEqual([-1n, 0n])
    expect(axisAmount(-123456n)).toBe('−1.2K')
    expect(axisAmount(101n)).toBe('1.01')
  })
  it('retains exact category totals including refunds and activity more than 24 months ago', () => {
    const budget = demoBudget()
    const template = budget.transactions[1]!
    budget.transactions = [
      {
        ...template,
        date: '2024-01-01',
        amount: '-900719925474099301',
        splits: [{ ...template.splits[0]!, amount: '-900719925474099301' }],
      },
      {
        ...template,
        id: 'refund',
        date: '2026-09-01',
        amount: '12345',
        splits: [{ ...template.splits[0]!, categoryId: 'cat-1', amount: '12345' }],
      },
    ]
    const data = reports(budget, '2024-01', '2026-09')
    expect(data).toHaveLength(33)
    expect(categoryTotals(budget, data).map(({ id, amount }) => ({ id, amount }))).toEqual([
      { id: 'cat-0', amount: 900719925474099301n },
      { id: 'cat-1', amount: -12345n },
    ])
    expect(data[0]!.spending).toBe(900719925474099301n)
  })
  it('makes inclusive presets across December and clamps the start of the supported calendar', () => {
    expect(reportPreset('2027-01', '6')).toEqual({ from: '2026-08', to: '2027-01' })
    expect(reportPreset('2027-01', '12')).toEqual({ from: '2026-02', to: '2027-01' })
    expect(reportPreset('2027-09', 'year')).toEqual({ from: '2027-01', to: '2027-09' })
    expect(reportPreset('0001-02', '12')).toEqual({ from: '0001-01', to: '0001-02' })
  })
})
