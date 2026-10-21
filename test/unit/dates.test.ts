import { describe, expect, it } from 'vitest'
import { addDays, isDate, nights, nightsBetween, todayIn, weekday } from '../../src/domain/dates.js'

describe('dates', () => {
  it('validates', () => {
    expect(isDate('2055-01-20')).toBe(true)
    expect(isDate('2055-02-30')).toBe(false)
    expect(isDate('20.01.2055')).toBe(false)
  })
  it('uses the hotel time zone for today', () => {
    expect(todayIn(new Date('2054-10-21T22:30:00Z'), 'Europe/Moscow')).toBe('2054-10-22')
  })
  it('counts nights', () => {
    expect(nightsBetween('2054-12-31', '2055-01-03')).toBe(3)
    expect(nights('2054-12-31', '2055-01-02')).toEqual(['2054-12-31', '2055-01-01'])
    expect(addDays('2054-10-22', 180)).toBe('2055-04-20')
    expect(weekday('2054-10-22')).toBe('чт')
  })
})
