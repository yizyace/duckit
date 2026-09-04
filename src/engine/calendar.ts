import { dateSchema, monthSchema, type Schedule } from '../shared/contracts'

export function monthOf(date: string): string {
  return dateSchema.parse(date).slice(0, 7)
}

export function addMonths(month: string, count: number): string {
  monthSchema.parse(month)
  if (!Number.isSafeInteger(count)) throw new Error('Month offset must be an integer')
  const [year, number] = month.split('-').map(Number) as [number, number]
  const absolute = (year - 1) * 12 + number - 1 + count
  if (absolute < 0 || absolute >= 9999 * 12) throw new Error('Month is outside calendar range')
  return `${String(Math.floor(absolute / 12) + 1).padStart(4, '0')}-${String((absolute % 12) + 1).padStart(2, '0')}`
}

export function daysInMonth(month: string): number {
  monthSchema.parse(month)
  const [year, number] = month.split('-').map(Number) as [number, number]
  if (number === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(number) ? 30 : 31
}

export function lastDayOfMonth(month: string): string {
  return `${month}-${daysInMonth(month)}`
}

/** Calendar arithmetic deliberately does not construct Date objects. */
export function addDays(date: string, count: number): string {
  dateSchema.parse(date)
  if (!Number.isSafeInteger(count) || Math.abs(count) > 3660000)
    throw new Error('Day offset is outside calendar range')
  let month = date.slice(0, 7)
  let day = Number(date.slice(8)) + count
  while (day < 1) {
    month = addMonths(month, -1)
    day += daysInMonth(month)
  }
  while (day > daysInMonth(month)) {
    day -= daysInMonth(month)
    month = addMonths(month, 1)
  }
  return `${month}-${String(day).padStart(2, '0')}`
}

/** Retain the original day-of-month after clamping a short month. */
export function nextOccurrence(
  date: string,
  frequency: Schedule['frequency'],
  anchorDate = date,
): string {
  dateSchema.parse(date)
  dateSchema.parse(anchorDate)
  switch (frequency) {
    case 'daily':
      return addDays(date, 1)
    case 'weekly':
      return addDays(date, 7)
    case 'fortnightly':
      return addDays(date, 14)
    case 'monthly':
    case 'quarterly':
    case 'yearly': {
      const month = addMonths(
        date.slice(0, 7),
        frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12,
      )
      const day = Math.min(Number(anchorDate.slice(8)), daysInMonth(month))
      return `${month}-${String(day).padStart(2, '0')}`
    }
  }
}

export function monthsBetween(from: string, to: string): string[] {
  monthSchema.parse(from)
  monthSchema.parse(to)
  if (from > to) throw new Error('Start month must not follow end month')
  const result: string[] = []
  for (let month = from; ; month = addMonths(month, 1)) {
    result.push(month)
    if (month === to) return result
  }
}
