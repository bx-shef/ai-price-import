/**
 * Reference hourly rates of a procurement assistant, by the portal's BASE currency (#311).
 *
 * These are a HINT under the input, never a default value. The distinction is the whole point:
 * the money tile is presented to the client as what the app achieved, so a figure the admin never
 * chose would be the app asserting what someone's employee costs — and the numbers come from open
 * sources and go stale. #270 removed a hard-coded BYN rate for exactly this reason; silently
 * seeding one back per currency would undo it.
 *
 * The same table lives in `docs/PROCESS.md` §7.1 as the human-facing reference. Two copies is a
 * known risk, so `tests/hourlyRateHints.test.ts` parses the document table and compares — a rate
 * or a date updated on one side only turns CI red.
 *
 * ⚠ Refreshing these is a scheduled task (#313, next check 01.02.2027). `AS_OF` is shown to the
 * admin verbatim: a stale reference WITHOUT a date misleads harder than no reference at all,
 * because it reads as current. If the table is ever dropped from the docs, drop it here too — an
 * empty map degrades to «no hint», which is the pre-#311 behaviour and perfectly fine.
 */

/** Date the figures were collected, as shown to the admin. Bump together with the rates. */
export const HOURLY_RATE_AS_OF = '01.08.2026'

/** ISO 4217 code → reference rate per hour, in that currency. */
export const HOURLY_RATE_HINTS: Readonly<Record<string, number>> = {
  RUB: 445,
  BYN: 9.9,
  KZT: 1440
}
