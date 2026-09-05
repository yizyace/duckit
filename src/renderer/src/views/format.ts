import { formatMoney } from '../../../engine'
export function money(value: bigint | string, currency: string): string {
  const exact = formatMoney(value),
    negative = exact.startsWith('-'),
    digits = (negative ? exact.slice(1) : exact).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  let symbol = currency + ' '
  try {
    symbol =
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? symbol
  } catch {}
  return (negative ? '−' : '') + symbol + digits
}
export function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}
export function monthLabel(month: string): string {
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  return `${names[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`
}
