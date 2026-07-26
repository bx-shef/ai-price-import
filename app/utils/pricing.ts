import type { DocumentItem } from '~/types/document'

// Pure pricing/VAT reconciliation. Two jobs:
//  1) Compute the document's gross (VAT-inclusive) total the way invoices print it — VAT on the LINE
//     total (Сумма × ставка), rounded once per line — NOT per unit. A tiny unit price × large qty
//     (0.86 × 10000 @20%) is 10 320 per-line but 10 300 if you round the per-unit gross (1.032→1.03)
//     first; the printed document and standard accounting use the per-line figure.
//  2) Reconcile `priceIncludesVat` against the document's PRINTED grand total when it states one — so a
//     model that guessed the flag wrong is corrected by arithmetic, and the entity total is anchored to
//     the document's own number instead of a re-derived (and possibly rounding-drifted) one.

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}

/** Per-line gross (VAT-inclusive) total for one line. Net line = round2(price × qty); when the price
 *  already includes VAT that IS the line gross, otherwise VAT is added on the LINE total (rounded once,
 *  matching how documents print «Сумма НДС» = Сумма × ставка). */
export function lineGross(price: number, qty: number, rate: number | null | undefined, inclusive: boolean): number {
  const net = round2(finite(price) * finite(qty, 1))
  if (inclusive) return net
  const r = rate == null ? 0 : finite(rate)
  return round2(net * (1 + r / 100))
}

/** Sum of per-line gross across items under a given VAT-inclusion assumption. */
export function computeGrossTotal(items: DocumentItem[], priceIncludesVat: boolean): number {
  let sum = 0
  for (const it of items) sum += lineGross(it.price, it.quantity, it.vatRate ?? null, priceIncludesVat)
  return round2(sum)
}

export interface PricingReconciliation {
  /** The authoritative VAT-inclusion flag (model's, or corrected by the printed total). */
  priceIncludesVat: boolean
  /** Authoritative gross total for the whole document — the printed total when trusted, else computed. */
  grossTotal: number
  /** True when the model's flag was overridden by the printed total. */
  corrected: boolean
  /** True when a printed total was present but matched NEITHER interpretation (→ warn, don't trust). */
  totalMismatch: boolean
  /** True when the printed total was used verbatim as `grossTotal` (whole document, no skips). */
  usedStatedTotal: boolean
}

/**
 * Reconcile VAT-inclusion + the document total. When the document prints a grand total, trust the
 * arithmetic: compare the printed total against the net-priced and gross-priced interpretations and
 * pick the matching one — this corrects a model that set `priceIncludesVat` wrong, and anchors the
 * total to the printed figure (no per-unit rounding drift). No printed total → keep the model's flag
 * and compute the total from the lines.
 */
export function reconcilePricing(items: DocumentItem[], modelFlag: boolean, statedTotal: number | undefined): PricingReconciliation {
  const grossExclusive = computeGrossTotal(items, false)
  const grossInclusive = computeGrossTotal(items, true)
  if (statedTotal != null && Number.isFinite(statedTotal) && statedTotal > 0) {
    const dEx = Math.abs(statedTotal - grossExclusive)
    const dIn = Math.abs(statedTotal - grossInclusive)
    // ~1% (min 0.5 minor units) absorbs rounding/format noise but rejects a grossly mis-extracted total.
    const tol = Math.max(0.5, statedTotal * 0.01)
    if (dEx <= tol || dIn <= tol) {
      const priceIncludesVat = dIn < dEx // closer interpretation wins; tie (e.g. 0% VAT) → excluded (false)
      return { priceIncludesVat, grossTotal: round2(statedTotal), corrected: priceIncludesVat !== modelFlag, totalMismatch: false, usedStatedTotal: true }
    }
    // Printed total matches neither interpretation → likely a mis-extracted number; don't trust it.
    return { priceIncludesVat: modelFlag, grossTotal: computeGrossTotal(items, modelFlag), corrected: false, totalMismatch: true, usedStatedTotal: false }
  }
  return { priceIncludesVat: modelFlag, grossTotal: computeGrossTotal(items, modelFlag), corrected: false, totalMismatch: false, usedStatedTotal: false }
}
