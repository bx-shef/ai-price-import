import type { QueryFn } from './tokenStore'

// TTL backstop for client data the live cleanup paths missed (a best-effort delete
// failed, or a job died past its cleanup point). The live paths (agent-run drops
// text, crm-sync drops the doc, extract drops bytes, uninstall purges all) remain
// primary; this is the safety net docs/redesign 05 requires. DI over QueryFn.

export interface SweepResult { text: number, docs: number, tombstones: number }

/**
 * Purge expired rows:
 *  - import_text/import_doc older than `textDocHours` (normally deleted within minutes →
 *    anything this old is orphaned).
 *  - portal_tombstone older than `tombstoneDays` (#77): the event-ordering guard only needs to
 *    outlive a late/retried install job for the SAME uninstall — hours in practice. A tombstone
 *    months old can no longer be raced (B24 does not retry online events for that long), so we
 *    cap growth: one row accrues per permanently-uninstalled portal otherwise. `deleted_ts` is a
 *    B24 event `ts` in unix SECONDS, compared against `EXTRACT(EPOCH FROM now())` (also seconds).
 *    The comparison is unit-safe by construction: were a value ever stored in ms (far larger than
 *    a seconds threshold) it would simply never be swept — conservative, never deleting a
 *    still-relevant tombstone early.
 * Returns delete counts. NB: import_job is no longer swept here — it moved off Postgres to
 * Redis+TTL (#B), which expires natively (server/utils/jobStore.ts).
 */
export async function sweepExpired(query: QueryFn, textDocHours = 24, tombstoneDays = 30): Promise<SweepResult> {
  const text = await del(query, `DELETE FROM import_text WHERE created_at < now() - ($1 * interval '1 hour')`, [textDocHours])
  const docs = await del(query, `DELETE FROM import_doc WHERE created_at < now() - ($1 * interval '1 hour')`, [textDocHours])
  const tombstones = await del(query, `DELETE FROM portal_tombstone WHERE deleted_ts < EXTRACT(EPOCH FROM now()) - ($1 * 86400)`, [tombstoneDays])
  return { text, docs, tombstones }
}

async function del(query: QueryFn, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await query(`${sql} RETURNING 1`, params)
  return rows.length
}
