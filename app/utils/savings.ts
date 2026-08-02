import { HOURLY_RATE_AS_OF, HOURLY_RATE_HINTS } from '~/config/hourlyRateHints'

// Pure «сколько сэкономлено» estimate from the per-portal metric counters. Turns raw
// counts (docs processed, product rows written) into a time figure for the in-portal
// dashboard — and, ONLY when the portal admin configured an hourly rate, into money.
// No I/O; unit-tested. Counter vocabulary + formulas: docs/PROCESS.md §7 «Метрики».

/**
 * Time constants. Country-neutral by construction: minutes of manual work the import
 * replaced, not money. Rough defaults — changing them changes the headline figure, so they
 * live in one place and their provenance is documented (docs/PROCESS.md §7).
 */
export const SAVINGS_MODEL = {
  /** Per document: opening, reading, finding the counterparty, creating the CRM entity. */
  minutesPerDoc: 4,
  /** Per product row: manual keying of one line (name, article, qty, price) into CRM. */
  minutesPerLine: 1
} as const

/**
 * Money side of the estimate. Deliberately NOT a constant (#270): the app is multitenant
 * across BY/RU/KZ, so a hard-coded «20 BYN/час» printed a Belarusian rate in a Belarusian
 * currency to a portal whose whole CRM runs in roubles or tenge. There is no honest default —
 * an hourly rate is the portal's own economics — so the money figure exists only when the
 * admin set the rate, and the currency comes from the portal itself, not from us.
 */
export interface SavingsRate {
  /** Operator cost per hour, in the portal's base currency. `null` — not configured. */
  ratePerHour?: number | null
  /** Portal base currency code (crm.currency.list `BASE:'Y'`). `null` — unknown. */
  currency?: string | null
}

export interface Savings {
  docs: number
  lines: number
  created: number
  minutesSaved: number
  /** `null` when no hourly rate is configured (or the currency is unknown) — UI hides the block. */
  moneySaved: number | null
  /** `null` alongside `moneySaved`. */
  currency: string | null
}

/** Estimate time (+ money when configured) from the raw counters map (missing names → 0). */
export function computeSavings(counters: Record<string, number>, rate: SavingsRate = {}): Savings {
  const nn = (v: number | undefined) => (Number.isFinite(v) && (v as number) > 0 ? Math.trunc(v as number) : 0)
  const docs = nn(counters.docs)
  const lines = nn(counters.lines)
  const created = nn(counters.created)
  const minutesSaved = docs * SAVINGS_MODEL.minutesPerDoc + lines * SAVINGS_MODEL.minutesPerLine
  // Both halves required: a rate without a currency prints a bare number whose unit the reader
  // has to guess — the same failure we are fixing, one step milder.
  const perHour = Number(rate.ratePerHour)
  const currency = typeof rate.currency === 'string' && /^[A-Z]{3}$/.test(rate.currency) ? rate.currency : null
  const priced = Number.isFinite(perHour) && perHour > 0 && currency !== null
  return {
    docs,
    lines,
    created,
    minutesSaved,
    moneySaved: priced ? Math.round((minutesSaved / 60) * perHour) : null,
    currency: priced ? currency : null
  }
}

/** Format minutes as a compact RU duration: «2 ч 15 мин», «45 мин», «0 мин». */
export function formatMinutes(minutes: number): string {
  const m = Number.isFinite(minutes) && minutes > 0 ? Math.trunc(minutes) : 0
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h > 0 && rem > 0) return `${h} ч ${rem} мин`
  if (h > 0) return `${h} ч`
  return `${rem} мин`
}

/** Why the «Сэкономлено денег» tile is not shown. `null` — it is shown. */
export type MoneyBlocker = 'no-rate' | 'no-currency'

/**
 * Explain a MISSING money tile.
 *
 * The tile has two independent preconditions — an hourly rate set by the admin and a base currency
 * on the portal — and until now failing either one produced the same thing: nothing. An admin who
 * had just entered a rate saw no tile and no reason, which is exactly how this was reported. The
 * dashboard shows the answer instead.
 *
 * `minutesSaved === 0` is NOT a blocker: nothing has been imported yet, so there is no figure to
 * explain and a hint would only be noise on a fresh portal.
 */
export function moneyBlocker(savings: Savings, rate: SavingsRate = {}): MoneyBlocker | null {
  if (savings.moneySaved !== null) return null
  if (savings.minutesSaved <= 0) return null
  return Number(rate.ratePerHour) > 0 ? 'no-currency' : 'no-rate'
}

/**
 * Reference hourly rate to show under the rate input, for the portal's base currency (#311).
 *
 * A HINT, never a default (see `app/config/hourlyRateHints.ts`). Returns `null` for a currency we
 * have no figure for — a portal in a fourth country gets no hint rather than a rate borrowed from
 * a neighbouring economy, which would be worse than silence.
 *
 * The number is formatted in the RUSSIAN locale on purpose: the admin writes «9,9», and printing
 * «9.9» right above a field that accepts a comma is a small but real way to make a correct entry
 * look wrong.
 */
export function hourlyRateHint(baseCurrency: string | null | undefined): { rate: number, text: string } | null {
  const code = String(baseCurrency ?? '').toUpperCase()
  const rate = HOURLY_RATE_HINTS[code]
  if (typeof rate !== 'number' || !(rate > 0)) return null
  const shown = rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
  // Код валюты идёт ПОСЛЕ числа, как в русском письме: «ориентир для BYN» читалось бы как
  // «ориентир для валюты», хотя ориентир — для ставки, а BYN лишь единица измерения.
  return { rate, text: `Подставлен ориентир: ${shown} ${code} в час (данные на ${HOURLY_RATE_AS_OF}) — из открытых источников. Поставьте свою ставку, если она отличается.` }
}

/**
 * Should the rate field be seeded with the reference figure? (#311)
 *
 * A decision, not a formatting helper, and therefore pure and tested: the version that lived inline
 * in the page was guarded only by «the source file contains these lines», and moving the assignment
 * ABOVE its own guard — i.e. overwriting a hand-entered rate on every page load — passed every test.
 *
 * Four conditions, each closing a way to be wrong:
 *   • `loaded` — before the server copy arrives «no rate» and «settings not here yet» look the same,
 *     and seeding into the second one would overwrite a rate the admin set earlier;
 *   • `isAdmin` — everyone else sees a read-only form, so a seeded number there is a figure on
 *     screen that nobody can save: it would simply be a lie about what the portal is configured to;
 *   • `current` empty — a rate that was entered by hand is never touched;
 *   • `configured` false — seed only while the portal is being set up for the FIRST time. Otherwise
 *     an empty rate is not a storable decision: «Оставьте пусто — плитки не будет» is offered right
 *     under the field, yet the next visit would refill it, and one unrelated «Сохранить» would put
 *     a figure the admin never chose behind a tile presented as the app's own achievement. That is
 *     exactly what #270 removed.
 */
export function shouldPrefillRate(input: {
  loaded: boolean
  isAdmin: boolean
  configured: boolean
  current: number | undefined
  hint: number | null
}): boolean {
  if (!input.loaded || !input.isAdmin || input.configured) return false
  if (Number(input.current) > 0) return false
  return Number(input.hint) > 0
}
