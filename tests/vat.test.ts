import { describe, expect, it } from 'vitest'
import { matchVatRate, parsePortalVatRates } from '../app/utils/vat'

// Real shape from a live portal (crm.vat.list): Без НДС (null), 0%, 22%.
const ROWS = [
  { ID: '1', NAME: 'Без НДС', RATE: null },
  { ID: '3', NAME: 'НДС 0%', RATE: '0.00' },
  { ID: '5', NAME: 'НДС 22%', RATE: '22.00' }
]

describe('parsePortalVatRates', () => {
  it('parses null RATE as «Без НДС»', () => {
    const rates = parsePortalVatRates(ROWS)
    expect(rates[0]).toEqual({ id: '1', name: 'Без НДС', rate: null })
    expect(rates[2]!.rate).toBe(22)
  })
})

describe('matchVatRate', () => {
  const rates = parsePortalVatRates(ROWS)

  it('matches a numeric document rate present in the portal', () => {
    expect(matchVatRate(22, rates)?.id).toBe('5')
    expect(matchVatRate(0, rates)?.id).toBe('3')
  })

  it('matches «без НДС» (null)', () => {
    expect(matchVatRate(null, rates)?.id).toBe('1')
  })

  it('returns null when the portal has no such rate (→ error chat)', () => {
    expect(matchVatRate(25, rates)).toBeNull()
  })
})
