// VAT model. Rates come ONLY from the portal (crm.vat.list); the document rate
// must match one of them, otherwise it is an error (→ error chat).
// See docs/redesign/02-target-architecture.md «Модель НДС».

/** A VAT rate as returned by crm.vat.list (RATE is null for «Без НДС»). */
export interface PortalVatRate {
  id: string
  name: string
  /** Percent, or null for «Без НДС». */
  rate: number | null
}

/** Parse crm.vat.list result rows into typed rates. */
export function parsePortalVatRates(rows: Array<{ ID: string, NAME: string, RATE: string | null }>): PortalVatRate[] {
  return rows.map(r => ({
    id: String(r.ID),
    name: r.NAME,
    rate: r.RATE === null || r.RATE === '' ? null : Number(r.RATE)
  }))
}

/**
 * Match a document VAT rate against the portal's available rates.
 * `docRate`: percent from the document, or null for «без НДС».
 * Returns the matching portal rate, or null when the portal has no such rate
 * (caller reports an error to the error chat).
 */
export function matchVatRate(docRate: number | null, portalRates: PortalVatRate[]): PortalVatRate | null {
  // `null` = explicit «без НДС» → matches the null-rate portal entry.
  // A non-finite number (NaN from a failed parse) is UNRECOGNISED, not tax-exempt:
  // return null so the caller reports an error, never silently «Без НДС».
  if (typeof docRate === 'number' && !Number.isFinite(docRate)) return null
  const target = docRate === null ? null : Number(docRate)
  return portalRates.find(r => r.rate === target) ?? null
}
