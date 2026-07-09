import type { QueryFn } from './tokenStore'

// Raw extracted DOCUMENT_TEXT store, keyed by job (per-portal). Written by
// file-extract, read by agent-run, then dropped once the extracted structure is
// persisted — the text never rides in a queue payload (docs/redesign 02 §7.3, 05).
// DI over QueryFn (testable without a DB).

export async function saveText(memberId: string, jobId: string, text: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO import_text (member_id, job_id, text) VALUES ($1,$2,$3)
     ON CONFLICT (member_id, job_id) DO UPDATE SET text = EXCLUDED.text`,
    [memberId, jobId, text]
  )
}

export async function getText(memberId: string, jobId: string, query: QueryFn): Promise<string | null> {
  const { rows } = await query('SELECT text FROM import_text WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
  const t = rows[0]?.text
  return typeof t === 'string' && t.length ? t : null
}

/** Drop a job's raw text (after agent-run persists the extracted structure). */
export async function deleteText(memberId: string, jobId: string, query: QueryFn): Promise<void> {
  await query('DELETE FROM import_text WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
}
