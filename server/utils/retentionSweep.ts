import type { QueryFn } from './tokenStore'

// TTL backstop for client data the live cleanup paths missed (a best-effort delete
// failed, or a job died past its cleanup point). The live paths (agent-run drops
// text, crm-sync drops the doc, extract drops bytes, uninstall purges all) remain
// primary; this is the safety net docs/redesign 05 requires. DI over QueryFn.

export interface SweepResult { text: number, docs: number }

/**
 * Purge expired rows: import_text/import_doc older than `textDocHours` (normally deleted within
 * minutes → anything this old is orphaned). Returns delete counts. NB: import_job is no longer swept
 * here — it moved off Postgres to Redis+TTL (#B), which expires natively (server/utils/jobStore.ts).
 */
export async function sweepExpired(query: QueryFn, textDocHours = 24): Promise<SweepResult> {
  const text = await del(query, `DELETE FROM import_text WHERE created_at < now() - ($1 * interval '1 hour')`, [textDocHours])
  const docs = await del(query, `DELETE FROM import_doc WHERE created_at < now() - ($1 * interval '1 hour')`, [textDocHours])
  return { text, docs }
}

async function del(query: QueryFn, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await query(`${sql} RETURNING 1`, params)
  return rows.length
}
