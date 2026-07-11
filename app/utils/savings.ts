// Pure «сколько сэкономлено» estimate from the per-portal metric counters. Turns raw
// counts (docs processed, product rows written) into a motivating time + money figure
// for the in-portal dashboard. Constants are rough, documented defaults — the owner can
// tune them later (design/text pass). No I/O; unit-tested.

/** Tunable estimate constants. Minutes a human would spend that the import saved. */
export const SAVINGS_MODEL = {
  /** Per document: opening, reading, finding the counterparty, creating the CRM entity. */
  minutesPerDoc: 4,
  /** Per product row: manual keying of one line (name, article, qty, price) into CRM. */
  minutesPerLine: 1,
  /** Operator cost, currency units per hour (BYN). Adjust to the portal's economics. */
  ratePerHour: 20,
  /** Currency label shown next to the money figure. */
  currency: 'BYN'
} as const

export interface Savings {
  docs: number
  lines: number
  created: number
  minutesSaved: number
  moneySaved: number
  currency: string
}

/** Estimate time + money saved from the raw counters map (missing names → 0). */
export function computeSavings(counters: Record<string, number>): Savings {
  const nn = (v: number | undefined) => (Number.isFinite(v) && (v as number) > 0 ? Math.trunc(v as number) : 0)
  const docs = nn(counters.docs)
  const lines = nn(counters.lines)
  const created = nn(counters.created)
  const minutesSaved = docs * SAVINGS_MODEL.minutesPerDoc + lines * SAVINGS_MODEL.minutesPerLine
  const moneySaved = Math.round((minutesSaved / 60) * SAVINGS_MODEL.ratePerHour)
  return { docs, lines, created, minutesSaved, moneySaved, currency: SAVINGS_MODEL.currency }
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
