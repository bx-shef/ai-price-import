import type { QueryFn } from './tokenStore'

// Per-portal metric counters over an injected QueryFn (testable without a DB).
// Monotonic increments written by crm-sync; read for the operator dashboard and
// the always-visible motivating metrics (docs/PROCESS.md §7).

/** Canonical counter names — worker (writer) and UI (reader) share this vocabulary. */
export const METRICS = {
  docs: 'docs', // documents processed
  created: 'created', // CRM entities created
  lines: 'lines', // product rows written
  unmatched: 'unmatched', // supplier not found — entity created without a company
  skipped: 'skipped', // idempotent whole-document redeliveries (a duplicate job, nothing re-created)
  errors: 'errors', // documents that hit a hard error
  feedbackUp: 'feedback_up', // employee feedback: 👍 sent on a result (#192 п.4)
  feedbackDown: 'feedback_down' // employee feedback: 👎 sent on a result (#192 п.4)
} as const

export type MetricName = typeof METRICS[keyof typeof METRICS]

/** Increment a counter by `by` (created if absent). Non-finite/zero is a no-op. */
export async function bumpCounter(memberId: string, name: string, by: number, query: QueryFn): Promise<void> {
  const delta = Math.trunc(by)
  if (!Number.isFinite(delta) || delta === 0) return
  await query(
    `INSERT INTO metrics_counter (member_id, name, value) VALUES ($1,$2,$3)
     ON CONFLICT (member_id, name) DO UPDATE SET value = metrics_counter.value + EXCLUDED.value`,
    [memberId, name, delta]
  )
}

/** Read all counters for a portal as a plain map (missing names absent). */
export async function readCounters(memberId: string, query: QueryFn): Promise<Record<string, number>> {
  const { rows } = await query('SELECT name, value FROM metrics_counter WHERE member_id=$1', [memberId])
  const out: Record<string, number> = {}
  for (const r of rows) out[String(r.name)] = Number(r.value) || 0
  return out
}

/** Counters the operator console renders. Anything else stays out of the response (#271-C). */
const TOTALS_SHOWN: readonly string[] = [METRICS.docs, METRICS.created, METRICS.lines, METRICS.errors]

/**
 * Sum every portal's counters into one map — the operator console's volume figure (#271-C).
 *
 * Deliberately NOT member-scoped: this is the cross-tenant view behind the operator password, the
 * one place that legitimately aggregates all portals. Every user-facing path stays scoped by
 * `member_id` (see readCounters).
 *
 * Two honest caveats, deliberately NOT dressed up as guarantees:
 *  - it is an aggregate, not an anonymiser. The same screen lists the installed portals, so with one
 *    or two tenants the total IS that tenant's figure. Cross-tenant volume is fine for the publisher
 *    reading their own console; it must not be sold as «нельзя понять, чей это объём».
 *  - it is NOT «за всё время». Uninstalling a portal deletes its rows (deletePortal), so the number
 *    goes DOWN when a tenant leaves. The UI says «по установленным сейчас порталам».
 *
 * Only the counters the console actually shows are returned — no reason to ship feedback/unmatched
 * volume to a screen that never renders it.
 */
export async function readTotals(query: QueryFn): Promise<Record<string, number>> {
  const { rows } = await query('SELECT name, SUM(value)::bigint AS value FROM metrics_counter GROUP BY name', [])
  const out: Record<string, number> = {}
  for (const r of rows) {
    const name = String(r.name)
    if (TOTALS_SHOWN.includes(name)) out[name] = Number(r.value) || 0
  }
  return out
}

/** Reset (delete) all counters for a portal — the operator's «сбросить метрики». Scoped
 * to member_id so one portal never touches another's counters. */
export async function resetCounters(memberId: string, query: QueryFn): Promise<void> {
  await query('DELETE FROM metrics_counter WHERE member_id=$1', [memberId])
}
