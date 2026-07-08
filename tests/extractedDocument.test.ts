import { describe, expect, it } from 'vitest'
import { MAX_ITEMS, validateExtractedDocument } from '../app/utils/extractedDocument'

describe('validateExtractedDocument', () => {
  it('normalises a well-formed document', () => {
    const doc = validateExtractedDocument({
      documentType: 'накладная',
      currency: 'byn',
      priceIncludesVat: true,
      supplier: { name: 'ООО "Ромашка"', taxId: '190-000-000', taxIdKind: 'unp' },
      items: [{ name: 'Болт', article: 'A1', quantity: '2', price: '10,50', unit: 'шт', vatRate: 20 }]
    })
    expect(doc).toEqual({
      documentType: 'накладная',
      currency: 'BYN',
      priceIncludesVat: true,
      supplier: { name: 'ООО "Ромашка"', taxId: '190000000', taxIdKind: 'UNP' },
      items: [{ name: 'Болт', article: 'A1', quantity: 2, price: 10.5, unit: 'шт', vatRate: 20 }]
    })
  })

  it('null when no usable items', () => {
    expect(validateExtractedDocument({ items: [] })).toBeNull()
    expect(validateExtractedDocument({ items: [{ price: 1 }] })).toBeNull() // no name
    expect(validateExtractedDocument({})).toBeNull()
    expect(validateExtractedDocument(null)).toBeNull()
    expect(validateExtractedDocument('nope')).toBeNull()
  })

  it('drops nameless rows but keeps valid ones', () => {
    const doc = validateExtractedDocument({ items: [{ name: 'A', price: 1, quantity: 1 }, { price: 2 }, { name: '  ', price: 3 }] })
    expect(doc?.items).toHaveLength(1)
    expect(doc?.items[0]!.name).toBe('A')
  })

  it('defaults price=0 / quantity=1 on missing/invalid numbers', () => {
    const doc = validateExtractedDocument({ items: [{ name: 'A', price: 'x', quantity: null }] })
    expect(doc?.items[0]).toMatchObject({ price: 0, quantity: 1 })
  })

  it('parses mixed thousands/decimal separators', () => {
    const doc = validateExtractedDocument({ items: [
      { name: 'A', price: '1 234,56', quantity: 1 },
      { name: 'B', price: '1,234.56', quantity: 1 },
      { name: 'C', price: '2.000', quantity: 1 }
    ] })
    expect(doc?.items.map(i => i.price)).toEqual([1234.56, 1234.56, 2.000])
  })

  it('rejects junk currency / bad taxIdKind; keeps digits-only taxId', () => {
    const doc = validateExtractedDocument({ currency: 'рубли', supplier: { name: 'X', taxId: 'УНП 500', taxIdKind: 'ZZZ' }, items: [{ name: 'A', price: 1, quantity: 1 }] })
    expect(doc?.currency).toBeUndefined()
    expect(doc?.supplier).toEqual({ name: 'X', taxId: '500' })
  })

  it('drops supplier with no name; supplier without taxId keeps name only', () => {
    expect(validateExtractedDocument({ supplier: { taxId: '1' }, items: [{ name: 'A', price: 1, quantity: 1 }] })?.supplier).toBeUndefined()
    expect(validateExtractedDocument({ supplier: { name: 'Y' }, items: [{ name: 'A', price: 1, quantity: 1 }] })?.supplier).toEqual({ name: 'Y' })
  })

  it('caps items at MAX_ITEMS (DoS guard)', () => {
    const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => ({ name: `P${i}`, price: 1, quantity: 1 }))
    expect(validateExtractedDocument({ items: many })?.items).toHaveLength(MAX_ITEMS)
  })

  it('ignores priceIncludesVat unless a real boolean', () => {
    expect(validateExtractedDocument({ priceIncludesVat: 'true', items: [{ name: 'A', price: 1, quantity: 1 }] })?.priceIncludesVat).toBeUndefined()
    expect(validateExtractedDocument({ priceIncludesVat: false, items: [{ name: 'A', price: 1, quantity: 1 }] })?.priceIncludesVat).toBe(false)
  })
})
