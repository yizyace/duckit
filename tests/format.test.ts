import { describe, expect, it } from 'vitest'
import { monthLabel } from '../src/renderer/src/views/format'
describe('renderer month labels', () => {
  it('reads a calendar month as a name and a four-digit year', () => {
    expect(monthLabel('2026-09')).toBe('September 2026')
    expect(monthLabel('2026-01')).toBe('January 2026')
    expect(monthLabel('2026-12')).toBe('December 2026')
  })
  it('labels the ends of the supported calendar', () => {
    expect(monthLabel('0001-01')).toBe('January 0001')
    expect(monthLabel('9999-12')).toBe('December 9999')
  })
})
