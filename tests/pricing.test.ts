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
  it('DISCOUNT line (negative price) contributes negatively — NOT clamped to 0', () => {
    // A discount of −20 @20% must subtract 24 from the gross (else the deal amount inflates).
    expect(lineGross(-20, 1, 20, false)).toBe(-24)
    expect(lineGross(-20, 1, null, false)).toBe(-20)
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

  it('printed GROSS total («Всего к оплате») matches the net-priced gross → false + anchor (deal #37)', () => {
    const r = reconcilePricing(items, /* modelFlag */ true, /* statedTotal */ 10320)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(true) // model said true, the printed gross proves net
    expect(r.totalMismatch).toBe(false)
  })

  it('SAFETY: model says net + total looks like «Итого» (net subtotal) → STAY net, do NOT drop VAT', () => {
    // The dangerous mis-read: the LLM grabs «Итого» 8600 (net) into total instead of «Всего к оплате».
    // grossInclusive (Σ price×qty) == 8600, so it is indistinguishable from a net subtotal. We must NOT
    // flip to «inclusive» (that would set opportunity 8600, dropping the 1720 VAT).
    const r = reconcilePricing(items, /* modelFlag */ false, /* statedTotal */ 8600)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320) // real gross = net + VAT, NOT the printed net subtotal
    expect(r.usedStatedTotal).toBe(false)
    expect(r.corrected).toBe(false)
  })

  it('genuine inclusive doc: model says inclusive + total matches the inclusive figure → trust true', () => {
    const r = reconcilePricing(items, /* modelFlag */ true, /* statedTotal */ 8600)
    expect(r.priceIncludesVat).toBe(true)
    expect(r.grossTotal).toBe(8600)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(false)
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

  it('absorbs per-line rounding noise but NOT a materially wrong total (capped tolerance, #5)', () => {
    // within the rounding budget (~0.5/line) → trusted
    expect(reconcilePricing(items, false, 10320.02)).toMatchObject({ usedStatedTotal: true, priceIncludesVat: false, grossTotal: 10320.02 })
    // a big invoice off by 50 (would pass an uncapped 1% = large) → NOT trusted, mismatch flagged
    const big = [item({ price: 1000, quantity: 100, vatRate: 20 })] // net 100000 / gross 120000
    const r = reconcilePricing(big, false, 120050) // 50 over the true gross, > capped tol (0.5)
    expect(r.usedStatedTotal).toBe(false)
    expect(r.totalMismatch).toBe(true)
  })

  it('no-VAT document with a total → anchor, but NO spurious «corrected» warning (#3)', () => {
    const exempt = [item({ price: 100, quantity: 2, vatRate: 0 })] // net == gross == 200
    const r = reconcilePricing(exempt, /* modelFlag */ true, /* statedTotal */ 200)
    expect(r.grossTotal).toBe(200)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(false) // VAT-neutral → the flag is irrelevant, no correction noise
  })
})
