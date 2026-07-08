import type { QueryFn } from './tokenStore'

// TTL backstop for client data the live cleanup paths missed (a best-effort delete
// failed, or a job died past its cleanup point). The live paths (agent-run drops
// text, crm-sync drops the doc, extract drops bytes, uninstall purges all) remain
// primary; this is the safety net docs/redesign 05 requires. DI over QueryFn.

export interface SweepResult { text: number, docs: number, jobs: number }

/**
 * Purge expired rows: import_text/import_doc older than `textDocHours` (normally
 * deleted within minutes → anything this old is orphaned), and terminal import_job
 * older than `jobDays` (bounds file_name/result retention). Returns delete counts.
 */
export async function sweepExpired(query: QueryFn, textDocHours = 24, jobDays = 30): Promise<SweepResult> {
  const text = await del(query, `DELETE FROM import_text WHERE created_at < now() - ($1 * interval '1 hour')`, [textDocHours])
  const docs = await del(query, `DELETE FROM import_doc WHERE created_at < now() - ($1 * interval '1 hour')`, [textDocHours])
  const jobs = await del(query, `DELETE FROM import_job WHERE status IN ('done','error') AND created_at < now() - ($1 * interval '1 day')`, [jobDays])
  return { text, docs, jobs }
}

async function del(query: QueryFn, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await query(`${sql} RETURNING 1`, params)
  return rows.length
}
