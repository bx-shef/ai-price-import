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

  it('null when no usable items (empty rows only)', () => {
    expect(validateExtractedDocument({ items: [] })).toBeNull()
    expect(validateExtractedDocument({ items: [{}, { name: '  ' }] })).toBeNull() // no name, no numbers
    expect(validateExtractedDocument({})).toBeNull()
    expect(validateExtractedDocument(null)).toBeNull()
    expect(validateExtractedDocument('nope')).toBeNull()
  })

  it('keeps nameless rows that carry numbers under a placeholder (1-в-1, no line loss)', () => {
    const doc = validateExtractedDocument({ items: [{ name: 'A', price: 1, quantity: 1 }, { price: 2 }, { name: '  ', quantity: 3 }] })
    expect(doc?.items).toHaveLength(3)
    expect(doc?.items[0]!.name).toBe('A')
    expect(doc?.items[1]).toMatchObject({ name: '(позиция без наименования)', price: 2 })
    expect(doc?.items[2]).toMatchObject({ name: '(позиция без наименования)', quantity: 3 })
  })

  it('preserves an explicit 0% VAT rate (must not be dropped as falsy)', () => {
    const doc = validateExtractedDocument({ items: [{ name: 'экспорт', price: 100, quantity: 1, vatRate: 0 }] })
    expect(doc?.items[0]!.vatRate).toBe(0)
  })

  it('num: blank quantity → default 1; "20%" vatRate → 20; dot-grouped thousands', () => {
    const doc = validateExtractedDocument({ items: [
      { name: 'A', price: 10, quantity: '' }, // blank → 1, not 0
      { name: 'B', price: '1.234.567', quantity: 1, vatRate: '20%' }
    ] })
    expect(doc?.items[0]!.quantity).toBe(1)
    expect(doc?.items[1]).toMatchObject({ price: 1234567, vatRate: 20 })
  })

  it('rejects 4+ letter currency (no silent truncation to 3)', () => {
    expect(validateExtractedDocument({ currency: 'USDT', items: [{ name: 'A', price: 1, quantity: 1 }] })?.currency).toBeUndefined()
    expect(validateExtractedDocument({ currency: 'byn.', items: [{ name: 'A', price: 1, quantity: 1 }] })?.currency).toBe('BYN')
  })

  it('clamps over-long strings (DoS guards)', () => {
    const doc = validateExtractedDocument({
      documentType: 'x'.repeat(300),
      supplier: { name: 'y'.repeat(1000), taxId: '1'.repeat(40) },
      items: [{ name: 'z'.repeat(1000), unit: 'u'.repeat(200), price: 1, quantity: 1 }]
    })
    expect(doc?.documentType!.length).toBe(120)
    expect(doc?.supplier!.name.length).toBe(500)
    expect(doc?.supplier!.taxId!.length).toBe(24)
    expect(doc?.items[0]!.name.length).toBe(500)
    expect(doc?.items[0]!.unit!.length).toBe(64)
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

  it('defensive DoS backstop caps at MAX_ITEMS (runAgent hard-errors before this)', () => {
    // The real no-silent-truncation guard is runAgent (overflow → hard error); this
    // cap is defense-in-depth for any other caller of the pure validator.
    const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => ({ name: `P${i}`, price: 1, quantity: 1 }))
    expect(validateExtractedDocument({ items: many })?.items).toHaveLength(MAX_ITEMS)
  })

  it('ignores priceIncludesVat unless a real boolean', () => {
    expect(validateExtractedDocument({ priceIncludesVat: 'true', items: [{ name: 'A', price: 1, quantity: 1 }] })?.priceIncludesVat).toBeUndefined()
    expect(validateExtractedDocument({ priceIncludesVat: false, items: [{ name: 'A', price: 1, quantity: 1 }] })?.priceIncludesVat).toBe(false)
  })
})
