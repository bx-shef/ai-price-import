import type { SavingsRate } from '~/utils/savings'

// Hourly rate + currency behind the «Сэкономлено денег» tile (#270). Pure core with DI: the
// dashboard asks for this on every open, and without a memo the cosmetic tile would cost the
// portal two extra REST calls (app.option.get + crm.currency.list) per request — three sequential
// round-trips on a route that used to make one. Neither value changes in practice.

/** How long a fully resolved rate+currency stays cached. Both are «set once and forget» values. */
export const SAVINGS_RATE_TTL_MS = 10 * 60 * 1000
/**
 * How long an INCOMPLETE answer stays cached — no rate, no base currency, or a failed read.
 *
 * Much shorter on purpose. Every one of those states is one the admin is about to fix, and the fix
 * happens OUTSIDE this app: creating a base currency in CRM settings sends no request here, so
 * nothing evicts, and with the full TTL the tile stayed missing for ten more minutes right after
 * the user did exactly what the warning told them to. A minute still bounds a portal whose reads
 * keep failing to one doomed pair of calls per minute.
 */
export const SAVINGS_RATE_MISS_TTL_MS = 60 * 1000

/** What the live loader must supply. Both calls hit the portal. */
export interface SavingsRateSource {
  /** Configured hourly rate, or `null` when the admin never set one. */
  readRate: () => Promise<number | null>
  /** Portal base currency, or `null` when it can't be determined. */
  readCurrency: () => Promise<string | null>
}

interface Entry { at: number, ttl: number, value: SavingsRate }
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
  if (hit && now - hit.at < hit.ttl) return hit.value
  let value: SavingsRate = {}
  // The two reads are kept APART on purpose. Sharing one `try` meant a failed currency call threw
  // away a rate that had already been read successfully — and the dashboard then told the admin
  // «укажите стоимость часа», i.e. instructed them to fix something that was not broken.
  let ratePerHour: number | null = null
  let failed = false
  try {
    ratePerHour = await source.readRate()
  } catch {
    failed = true
  }
  if (ratePerHour && ratePerHour > 0) {
    let currency: string | null = null
    try {
      currency = await source.readCurrency()
    } catch {
      failed = true
    }
    value = { ratePerHour, currency }
  }
  // TTL by case, not by «полнота ответа»:
  //  - «ставка не задана» — обычное устойчивое состояние большинства порталов, и его исправление
  //    ПРОХОДИТ ЧЕРЕЗ НАС (сохранение настроек сбрасывает кэш), поэтому держим долго: короткий TTL
  //    здесь означал бы вдесятеро больше вызовов к порталу навсегда и ни на что не влиял;
  //  - нет базовой валюты или чтение упало — исправляют СНАРУЖИ (валюта заводится в CRM), к нам
  //    запрос при этом не приходит, поэтому перечитываем через минуту.
  const ttl = failed || (value.ratePerHour && !value.currency) ? SAVINGS_RATE_MISS_TTL_MS : SAVINGS_RATE_TTL_MS
  cache.set(memberId, { at: now, ttl, value })
  return value
}
