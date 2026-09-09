import { describe, expect, it } from 'vitest'
import { addMonths } from '../src/engine/calendar'
import { monthLabel } from '../src/renderer/src/views/format'
import {
  parsePickerYear,
  parseVisibleMonths,
  visibleMonthsKey,
} from '../src/renderer/src/lib/budget-navigation'

describe('local budget navigation preferences', () => {
  it('reads only supported counts and isolates budget preference keys', () => {
    expect(
      ['1', '2', '3', null, '', '0', '4', '1.5', '01', 'garbage'].map(parseVisibleMonths),
    ).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 3, 3])
    expect(visibleMonthsKey('first')).not.toBe(visibleMonthsKey('second'))
  })
  it('accepts only whole supported years, preserving early calendar years', () => {
    for (const value of ['', '0', '0000', '-1', '1.5', '1e3', '10000', ' 1'])
      expect(parsePickerYear(value)).toBeNull()
    expect(parsePickerYear('0001')).toBe(1)
    expect(parsePickerYear('99')).toBe(99)
    expect(parsePickerYear('9999')).toBe(9999)
    expect(monthLabel(addMonths('0099-12', 1))).toBe('January 0100')
    expect(monthLabel(addMonths('9999-11', 1))).toBe('December 9999')
    expect(() => addMonths('0001-01', -1)).toThrow('outside calendar range')
    expect(() => addMonths('9999-12', 1)).toThrow('outside calendar range')
  })
})
