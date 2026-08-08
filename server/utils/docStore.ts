import type { QueryFn } from './tokenStore'
import type { ExtractedDocument } from '~/types/document'
import type { RoutingSignals } from '~/utils/routing'

// Store the agent's extracted document between agent-run and crm-sync, keyed by
// job (per-portal). This keeps full document text/data OUT of the queue payload
// (docs/PROCESS.md §5). DI over QueryFn.

/**
 * Сохранённый разбор документа.
 *
 * ⚠ `failure` — причина, по которой документ РАЗОБРАТЬ НЕ УДАЛОСЬ (#459). Такое задание всё равно
 * доходит до стадии записи: сущность и дело создаются на каждую загрузку, иначе неудача не
 * оставит в портале следа и не попадёт в журнал импортов. Поле, а не пустой `doc`: «разобрали и
 * получилось пусто» и «разобрать не смогли» — разные исходы, и по пустому документу отличить их
 * было бы нечем.
 */
export interface StoredDoc { doc: ExtractedDocument, signals: RoutingSignals, failure?: string }

export async function saveDocument(memberId: string, jobId: string, payload: StoredDoc, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO import_doc (member_id, job_id, payload) VALUES ($1,$2,$3)
     ON CONFLICT (member_id, job_id) DO UPDATE SET payload = EXCLUDED.payload`,
    [memberId, jobId, JSON.stringify(payload)]
  )
}

export async function getDocument(memberId: string, jobId: string, query: QueryFn): Promise<StoredDoc | null> {
  const { rows } = await query('SELECT payload FROM import_doc WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
  const p = rows[0]?.payload
  if (!p) return null
  const parsed = typeof p === 'string' ? safeParse(p) : p as StoredDoc
  if (!parsed || typeof parsed !== 'object') return null
  const doc = (parsed as StoredDoc).doc
  // A row with a payload but no `doc` is malformed — treat as absent, not a
  // half-populated {doc: undefined} that would crash the crm-sync orchestration.
  if (!doc || typeof doc !== 'object') return null
  return { doc, signals: (parsed as StoredDoc).signals ?? {} }
}

/** Delete a job's stored document (after crm-sync / on cleanup). */
export async function deleteDocument(memberId: string, jobId: string, query: QueryFn): Promise<void> {
  await query('DELETE FROM import_doc WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
