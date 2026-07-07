import { describe, expect, it } from 'vitest'
import { isPlausibleTaxId, normalizeTaxId } from '../app/utils/taxId'

describe('normalizeTaxId', () => {
  it('keeps digits only', () => {
    expect(normalizeTaxId('УНП 190 000 000')).toBe('190000000')
    expect(normalizeTaxId('ИНН: 7701234567')).toBe('7701234567')
  })
})

describe('isPlausibleTaxId', () => {
  it('validates by kind length', () => {
    expect(isPlausibleTaxId('190000000', 'UNP')).toBe(true) // BY 9
    expect(isPlausibleTaxId('7701234567', 'INN')).toBe(true) // RU 10
    expect(isPlausibleTaxId('900101000000', 'BIN')).toBe(true) // KZ 12
    expect(isPlausibleTaxId('123', 'UNP')).toBe(false)
  })

  it('rejects mid-range lengths not in the kind set', () => {
    expect(isPlausibleTaxId('12345678901', 'INN')).toBe(false) // 11 (between 10 and 12)
  })

  it('unknown kind → loose length check (8..12)', () => {
    expect(isPlausibleTaxId('12345678')).toBe(true)
    expect(isPlausibleTaxId('1234567890123')).toBe(false) // 13
    expect(isPlausibleTaxId('')).toBe(false)
  })
})
