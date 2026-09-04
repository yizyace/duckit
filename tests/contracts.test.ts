import { describe, it, expect } from 'vitest'
import {
  budgetSchema,
  dateSchema,
  monthSchema,
  minorSchema,
  commandSchema,
} from '../src/shared/contracts'
import { demoBudget } from '../src/shared/demo'
describe('transport contracts', () => {
  it('keeps exact amounts as decimal minor-unit strings', () => {
    expect(budgetSchema.parse(demoBudget()).transactions[0]?.amount).toBe('420000')
    expect(minorSchema.parse('900719925474099312345')).toBe('900719925474099312345')
    for (const value of [0.1, '1.2', '01', '-0', 'NaN'])
      expect(minorSchema.safeParse(value).success).toBe(false)
  })
  it('validates calendar dates without timezones', () => {
    expect(dateSchema.safeParse('2024-02-29').success).toBe(true)
    expect(monthSchema.safeParse('0000-01').success).toBe(false)
    for (const value of ['2025-02-29', '2026-04-31', '0000-01-01', '2026-01-00'])
      expect(dateSchema.safeParse(value).success).toBe(false)
  })
  it('requires revision and retry identity on commands', () => {
    expect(commandSchema.safeParse({ changes: [{ type: 'undo' }] }).success).toBe(false)
  })
})
