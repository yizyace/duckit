import { addMonths, type ReportMonth } from '../../../engine'
import type { Budget } from '../../../shared/contracts'

/** Keep money exact; conversion to Number happens only after bounded scaling. */
export function chartScale(values: bigint[]) {
  let min = 0n,
    max = 0n
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  if (min === max) max = 100n
  const span = max - min
  return {
    min,
    max,
    fraction: (value: bigint) => Number(((value - min) * 1000000n) / span) / 1000000,
    ticks: [...new Set(Array.from({ length: 5 }, (_, i) => min + (span * BigInt(i)) / 4n))],
  }
}

export function categoryTotals(budget: Budget, data: ReportMonth[]) {
  const totals = new Map<string, bigint>()
  for (const month of data)
    for (const category of month.categories)
      totals.set(category.categoryId, (totals.get(category.categoryId) ?? 0n) + category.spending)
  return budget.categories
    .map((category) => ({ ...category, amount: totals.get(category.id) ?? 0n }))
    .filter((category) => category.amount !== 0n)
    .sort((a, b) =>
      a.amount === b.amount ? a.name.localeCompare(b.name) : a.amount > b.amount ? -1 : 1,
    )
}

export function reportPreset(month: string, preset: '6' | '12' | 'year') {
  const offset = preset === 'year' ? Number(month.slice(5)) - 1 : Number(preset) - 1
  const available = (Number(month.slice(0, 4)) - 1) * 12 + Number(month.slice(5)) - 1
  return { from: addMonths(month, -Math.min(offset, available)), to: month }
}

/** Compact axis labels are approximate; details and tables always use exact money. */
export function axisAmount(value: bigint): string {
  const negative = value < 0n,
    absolute = negative ? -value : value
  for (const [divisor, suffix] of [
    [100000000000000n, 'T'],
    [100000000000n, 'B'],
    [100000000n, 'M'],
    [100000n, 'K'],
  ] as const) {
    if (absolute >= divisor) {
      const tenths = (absolute * 10n) / divisor
      return `${negative ? '−' : ''}${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ''}${suffix}`
    }
  }
  return `${negative ? '−' : ''}${absolute / 100n}${absolute % 100n ? `.${String(absolute % 100n).padStart(2, '0')}` : ''}`
}
