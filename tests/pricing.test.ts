import { describe, expect, it } from 'vitest'
import { lineGross, computeGrossTotal, reconcilePricing } from '../app/utils/pricing'
import type { DocumentItem } from '../app/types/document'

const item = (over: Partial<DocumentItem> = {}): DocumentItem => ({ name: 'x', price: 1, quantity: 1, ...over })

describe('lineGross', () => {
  it('net line + VAT added on the LINE total (round once)', () => {
    // the reported invoice line: 0.86 × 10000 @20% → 8600 net → 10320 (NOT 10300 from per-unit rounding)
    expect(lineGross(0.86, 10000, 20, false)).toBe(10320)
  })
  it('inclusive price → line is price×qty as-is', () => {
    expect(lineGross(1.03, 10000, 20, true)).toBe(10300)
  })
  it('no VAT rate → net only; clamps non-finite qty to 1', () => {
    expect(lineGross(50, 3, null, false)).toBe(150)
    expect(lineGross(100, NaN, 20, true)).toBe(100)
  })
})

describe('computeGrossTotal', () => {
  it('sums per-line gross under the given inclusion flag', () => {
    const items = [item({ price: 0.86, quantity: 10000, vatRate: 20 }), item({ price: 100, quantity: 1, vatRate: 20 })]
    expect(computeGrossTotal(items, false)).toBe(10320 + 120)
    expect(computeGrossTotal(items, true)).toBe(8600 + 100)
  })
})

describe('reconcilePricing', () => {
  const items = [item({ price: 0.86, quantity: 10000, vatRate: 20 })] // net 8600 / gross 10320

  it('printed total matches the NET interpretation → priceIncludesVat=false, uses the printed total', () => {
    const r = reconcilePricing(items, /* modelFlag */ true, /* statedTotal */ 10320)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(true) // model said true, arithmetic says false
    expect(r.totalMismatch).toBe(false)
  })

  it('printed total matches the GROSS interpretation → priceIncludesVat=true', () => {
    const r = reconcilePricing(items, false, 8600)
    expect(r.priceIncludesVat).toBe(true)
    expect(r.grossTotal).toBe(8600)
    expect(r.corrected).toBe(true)
  })

  it('no printed total → keep the model flag, compute the total', () => {
    expect(reconcilePricing(items, false, undefined)).toMatchObject({ priceIncludesVat: false, grossTotal: 10320, usedStatedTotal: false, corrected: false })
    expect(reconcilePricing(items, true, undefined)).toMatchObject({ priceIncludesVat: true, grossTotal: 8600, usedStatedTotal: false })
  })

  it('printed total matches neither → totalMismatch, do not trust it', () => {
    const r = reconcilePricing(items, false, 99999)
    expect(r.totalMismatch).toBe(true)
    expect(r.usedStatedTotal).toBe(false)
    expect(r.grossTotal).toBe(10320) // falls back to the model-flag computation
  })

  it('absorbs small rounding noise in the printed total (within ~1%)', () => {
    const r = reconcilePricing(items, false, 10320.02)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320.02)
  })
})
