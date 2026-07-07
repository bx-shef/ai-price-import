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

  it('unknown kind → loose length check', () => {
    expect(isPlausibleTaxId('12345678')).toBe(true)
    expect(isPlausibleTaxId('')).toBe(false)
  })
})
