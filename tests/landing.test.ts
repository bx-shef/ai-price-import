import { describe, expect, it } from 'vitest'
import { copyrightYears, LANDING_FEATURES, LANDING_STEPS, LANDING_SUBTITLE } from '../app/utils/landing'

describe('landing content', () => {
  it('has 3 how-it-works steps in order and 4 features', () => {
    expect(LANDING_STEPS.map(s => s.n)).toEqual([1, 2, 3])
    expect(LANDING_FEATURES).toHaveLength(4)
    expect(LANDING_SUBTITLE).toMatch(/1-в-1/)
  })
})

describe('copyrightYears', () => {
  it('single year when same, range otherwise', () => {
    expect(copyrightYears(2026, 2026)).toBe('2026')
    expect(copyrightYears(2024, 2026)).toBe('2024–2026')
    expect(copyrightYears(2027, 2026)).toBe('2026') // clamp future start
  })
})
