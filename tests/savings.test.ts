import { describe, expect, it } from 'vitest'
import { computeSavings, formatMinutes, SAVINGS_MODEL } from '../app/utils/savings'

describe('computeSavings', () => {
  it('estimates minutes from docs and lines', () => {
    const s = computeSavings({ docs: 2, lines: 10, created: 2 })
    expect(s.minutesSaved).toBe(2 * SAVINGS_MODEL.minutesPerDoc + 10 * SAVINGS_MODEL.minutesPerLine)
    expect(s.docs).toBe(2)
    expect(s.lines).toBe(10)
    expect(s.created).toBe(2)
  })

  it('zero counters → zero savings, no NaN', () => {
    expect(computeSavings({})).toMatchObject({ docs: 0, lines: 0, minutesSaved: 0, moneySaved: null })
  })

  it('ignores negative / non-finite counter values', () => {
    const s = computeSavings({ docs: -5, lines: Number.NaN, created: Infinity })
    expect(s).toMatchObject({ docs: 0, lines: 0, created: 0, minutesSaved: 0 })
  })
})

// #270: money used to be a hard-coded 20 BYN/hour shown to RU/KZ portals too. Now it exists only
// when the portal supplied BOTH halves — its own rate and its own base currency.
describe('computeSavings — money only when the portal configured it', () => {
  it('no rate → no money figure and no currency', () => {
    const s = computeSavings({ docs: 2, lines: 10 }, { currency: 'RUB' })
    expect(s.moneySaved).toBeNull()
    expect(s.currency).toBeNull()
  })

  it('rate without a known currency → still no money (a bare number has no unit)', () => {
    expect(computeSavings({ docs: 2, lines: 10 }, { ratePerHour: 30, currency: null }).moneySaved).toBeNull()
    expect(computeSavings({ docs: 2, lines: 10 }, { ratePerHour: 30, currency: 'рубли' }).moneySaved).toBeNull()
  })

  it('rate + portal currency → money in THAT currency', () => {
    // 2×4 + 10×1 = 18 мин; 18/60 × 30 = 9
    const s = computeSavings({ docs: 2, lines: 10 }, { ratePerHour: 30, currency: 'RUB' })
    expect(s.moneySaved).toBe(9)
    expect(s.currency).toBe('RUB')
  })

  it('non-positive / broken rate is not money', () => {
    for (const ratePerHour of [0, -5, Number.NaN, Infinity]) {
      expect(computeSavings({ docs: 5 }, { ratePerHour, currency: 'KZT' }).moneySaved).toBeNull()
    }
  })

  it('no BYN anywhere in the defaults', () => {
    expect(JSON.stringify(SAVINGS_MODEL)).not.toContain('BYN')
    expect(computeSavings({ docs: 3, lines: 3 }).currency).toBeNull()
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
