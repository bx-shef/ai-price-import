import { describe, expect, it } from 'vitest'
import { computeSavings, formatMinutes, SAVINGS_MODEL } from '../app/utils/savings'

describe('computeSavings', () => {
  it('estimates minutes + money from docs and lines', () => {
    // 2 docs (×4) + 10 lines (×1) = 18 min; 18/60×20 = 6 (rounded)
    const s = computeSavings({ docs: 2, lines: 10, created: 2 })
    expect(s.minutesSaved).toBe(2 * SAVINGS_MODEL.minutesPerDoc + 10 * SAVINGS_MODEL.minutesPerLine)
    expect(s.moneySaved).toBe(Math.round((s.minutesSaved / 60) * SAVINGS_MODEL.ratePerHour))
    expect(s.docs).toBe(2)
    expect(s.lines).toBe(10)
    expect(s.created).toBe(2)
    expect(s.currency).toBe(SAVINGS_MODEL.currency)
  })

  it('zero counters → zero savings, no NaN', () => {
    expect(computeSavings({})).toMatchObject({ docs: 0, lines: 0, minutesSaved: 0, moneySaved: 0 })
  })

  it('ignores negative / non-finite counter values', () => {
    const s = computeSavings({ docs: -5, lines: Number.NaN, created: Infinity })
    expect(s).toMatchObject({ docs: 0, lines: 0, created: 0, minutesSaved: 0, moneySaved: 0 })
  })
})

describe('formatMinutes', () => {
  it('formats hours + minutes compactly (RU)', () => {
    expect(formatMinutes(135)).toBe('2 ч 15 мин')
    expect(formatMinutes(120)).toBe('2 ч')
    expect(formatMinutes(45)).toBe('45 мин')
    expect(formatMinutes(0)).toBe('0 мин')
    expect(formatMinutes(-10)).toBe('0 мин')
  })
})
