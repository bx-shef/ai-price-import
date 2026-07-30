import type { SavingsRate } from '~/utils/savings'

// Hourly rate + currency behind the «Сэкономлено денег» tile (#270). Pure core with DI: the
// dashboard asks for this on every open, and without a memo the cosmetic tile would cost the
// portal two extra REST calls (app.option.get + crm.currency.list) per request — three sequential
// round-trips on a route that used to make one. Neither value changes in practice.

/** How long a portal's rate/currency stays cached. Both are «set once and forget» values. */
export const SAVINGS_RATE_TTL_MS = 10 * 60 * 1000

/** What the live loader must supply. Both calls hit the portal. */
export interface SavingsRateSource {
  /** Configured hourly rate, or `null` when the admin never set one. */
  readRate: () => Promise<number | null>
  /** Portal base currency, or `null` when it can't be determined. */
  readCurrency: () => Promise<string | null>
}

interface Entry { at: number, value: SavingsRate }
const cache = new Map<string, Entry>()

/** Drop a portal's cached rate (uninstall / settings write). Also used by tests. */
export function evictSavingsRate(memberId?: string): void {
  if (memberId) cache.delete(memberId)
  else cache.clear()
}

/**
 * Resolve the rate for one portal, memoized per `memberId`.
 *
 * Two short-circuits keep the common cases free of REST traffic:
 *  - `minutesSaved === 0` — a portal that imported nothing would render «0 <валюта>», so there is
 *    nothing worth two portal calls; this is also exactly the state a hammering caller sits in.
 *  - no configured rate — the currency call is skipped entirely (it only labels the money figure).
 *
 * Fail-open: any error yields «time only». Showing time without money is a smaller lie than an
 * amount in a currency we guessed, and the counters must never fail over a cosmetic add-on.
 */
export async function resolveSavingsRate(
  memberId: string,
  minutesSaved: number,
  source: SavingsRateSource,
  now: number = Date.now()
): Promise<SavingsRate> {
  if (!(minutesSaved > 0)) return {}
  const hit = cache.get(memberId)
  if (hit && now - hit.at < SAVINGS_RATE_TTL_MS) return hit.value
  let value: SavingsRate = {}
  try {
    const ratePerHour = await source.readRate()
    // A rate of 0/null means «no money figure» — do not pay for the currency lookup.
    if (ratePerHour && ratePerHour > 0) value = { ratePerHour, currency: await source.readCurrency() }
  } catch {
    // Cache the miss too: a portal whose settings read keeps failing must not turn every
    // dashboard open into another doomed pair of REST calls.
    value = {}
  }
  cache.set(memberId, { at: now, value })
  return value
}
