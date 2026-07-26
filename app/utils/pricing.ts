import type { DocumentItem } from '~/types/document'

// Pure pricing/VAT reconciliation. Two jobs:
//  1) Compute the document's gross (VAT-inclusive) total the way invoices print it — VAT on the LINE
//     total (Сумма × ставка), rounded once per line — NOT per unit. A tiny unit price × large qty
//     (0.86 × 10000 @20%) is 10 320 per-line but 10 300 if you round the per-unit gross (1.032→1.03)
//     first; the printed document and standard accounting use the per-line figure.
//  2) Reconcile `priceIncludesVat` against the document's PRINTED grand total when it states one. This
//     is DELIBERATELY ASYMMETRIC: the printed total is trusted to confirm the SAFE (net-priced) reading
//     and to correct a model that wrongly said «включает НДС» (adds VAT — the reported deal #37 bug),
//     but it is NOT allowed to flip a «net» model to «inclusive», because the gross-inclusive figure
//     (Σ price×qty) is numerically identical to a net doc's «Итого» subtotal — trusting it there would
//     silently DROP the VAT if the model grabbed «Итого» instead of «Всего к оплате».

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}
/** Clamp to a non-negative finite number — MIRRORS crm-sync's clampNonNeg on the written row so the
 *  reconcile interpretation matches what is actually persisted (negative price/qty are zeroed on both
 *  sides; a non-finite qty falls back to 1, matching buildProductRow). */
function nonNeg(n: number, fallback = 0): number {
  const v = finite(n, fallback)
  return v < 0 ? 0 : v
}

/** Per-line gross (VAT-inclusive) total for one line. Net line = round2(price × qty) with price/qty
 *  clamped non-negative (same as the written row); when the price already includes VAT that IS the
 *  line gross, otherwise VAT is added on the LINE total (rounded once). A non-positive rate = no VAT. */
export function lineGross(price: number, qty: number, rate: number | null | undefined, inclusive: boolean): number {
  const net = round2(nonNeg(price) * nonNeg(qty, 1))
  if (inclusive) return net
  const r = rate == null ? 0 : finite(rate)
  const effRate = r > 0 ? r : 0 // 0 / negative = «Без НДС» (a negative rate is rejected upstream)
  return round2(net * (1 + effRate / 100))
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
  /** True when the model's flag was overridden by the printed total (only ever toward «net»). */
  corrected: boolean
  /** True when a printed total was present but matched NEITHER interpretation (→ warn, don't trust). */
  totalMismatch: boolean
  /** True when the printed total was used verbatim as `grossTotal` (whole document, no skips). */
  usedStatedTotal: boolean
}

/**
 * Reconcile VAT-inclusion + the document total. When the document prints a grand total, use it to
 * confirm the net-priced reading and anchor the entity amount — but NEVER let it flip a «net» model to
 * «inclusive» (see the module note: Σ price×qty ≡ «Итого», so that direction can drop the VAT). No
 * printed total → keep the model's flag and compute the total from the lines.
 */
export function reconcilePricing(items: DocumentItem[], modelFlag: boolean, statedTotal: number | undefined): PricingReconciliation {
  const grossExclusive = computeGrossTotal(items, false) // prices are net → VAT added
  const grossInclusive = computeGrossTotal(items, true) // prices already gross → = Σ round2(price×qty)
  const hasVatEffect = round2(grossExclusive - grossInclusive) > 0 // positive VAT actually changes the total

  const compute = (flag: boolean): number => computeGrossTotal(items, flag)
  const noAnchor = (): PricingReconciliation => ({ priceIncludesVat: modelFlag, grossTotal: compute(modelFlag), corrected: false, totalMismatch: false, usedStatedTotal: false })

  if (statedTotal == null || !Number.isFinite(statedTotal) || statedTotal <= 0) return noAnchor()

  // Tolerance = the legit per-line rounding drift (~0.5 minor unit per line), never more than 1% of the
  // total (so a big invoice's 1% isn't silently accepted as "rounding"). Beyond it, don't trust the number.
  const tol = Math.min(Math.max(0.5, items.length * 0.5), statedTotal * 0.01)
  const matchesExcl = Math.abs(statedTotal - grossExclusive) <= tol
  const matchesIncl = Math.abs(statedTotal - grossInclusive) <= tol

  // Unambiguous EXCLUSIVE: printed total == net-priced gross and NOT the inclusive/net figure. Prices are
  // net; anchor to the printed gross. This is the safe direction (adds VAT) — the deal #37 correction.
  if (matchesExcl && !matchesIncl) {
    return { priceIncludesVat: false, grossTotal: round2(statedTotal), corrected: modelFlag === true, totalMismatch: false, usedStatedTotal: true }
  }
  // Printed total == the inclusive figure (Σ price×qty), NOT the exclusive gross. Ambiguous when VAT
  // exists: it is either the gross of a VAT-inclusive doc OR the NET subtotal («Итого») of a net-priced
  // doc — numerically identical. Trust it as «inclusive» ONLY when the model itself says inclusive;
  // otherwise keep «net» and compute the real gross (net + VAT) — never drop the VAT on a mis-read total.
  if (matchesIncl && !matchesExcl) {
    if (!hasVatEffect) {
      // No VAT differential → the flag is total-neutral; anchor, no «corrected» noise.
      return { priceIncludesVat: false, grossTotal: round2(statedTotal), corrected: false, totalMismatch: false, usedStatedTotal: true }
    }
    if (modelFlag) {
      return { priceIncludesVat: true, grossTotal: round2(statedTotal), corrected: false, totalMismatch: false, usedStatedTotal: true }
    }
    // Model says net + total looks like «Итого» → keep net, DO NOT anchor; real gross = net + VAT.
    return { priceIncludesVat: false, grossTotal: grossExclusive, corrected: false, totalMismatch: false, usedStatedTotal: false }
  }
  // Matches BOTH (only when grossExcl ≈ grossIncl, i.e. no VAT) → anchor; the flag is total-neutral.
  if (matchesExcl && matchesIncl) {
    return { priceIncludesVat: false, grossTotal: round2(statedTotal), corrected: false, totalMismatch: false, usedStatedTotal: true }
  }
  // Matches neither → the printed number is off (mis-extraction / an unmodelled discount). Keep the
  // model flag, compute, and flag the mismatch so crm-sync warns the operator (don't silently trust it).
  return { priceIncludesVat: modelFlag, grossTotal: compute(modelFlag), corrected: false, totalMismatch: true, usedStatedTotal: false }
}
