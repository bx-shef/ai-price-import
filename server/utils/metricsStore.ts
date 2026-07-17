import type { QueryFn } from './tokenStore'

// Per-portal metric counters over an injected QueryFn (testable without a DB).
// Monotonic increments written by crm-sync; read for the operator dashboard and
// the always-visible motivating metrics (docs/redesign 02 §7.2, etap 8).

/** Canonical counter names — worker (writer) and UI (reader) share this vocabulary. */
export const METRICS = {
  docs: 'docs', // documents processed
  created: 'created', // CRM entities created
  lines: 'lines', // product rows written
  unmatched: 'unmatched', // supplier not found — entity created without a company
  skipped: 'skipped', // idempotent whole-document redeliveries (a duplicate job, nothing re-created)
  errors: 'errors' // documents that hit a hard error
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

/** Reset (delete) all counters for a portal — the operator's «сбросить метрики». Scoped
 * to member_id so one portal never touches another's counters. */
export async function resetCounters(memberId: string, query: QueryFn): Promise<void> {
  await query('DELETE FROM metrics_counter WHERE member_id=$1', [memberId])
}
