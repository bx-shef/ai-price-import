// Pure merge of the employee's LOCAL import history (localStorage, 7 days) with the SERVER's live
// job statuses (Redis, 48h). Two stores with different lifetimes meet here, so the rule has to be
// explicit: a remembered row the server no longer knows about is NOT dropped — it becomes `expired`.
// Dropping it silently is what made «Последние операции» look empty after a couple of days (#268).

import type { JobStatus } from './jobStatus'

/** What the browser remembered about a job (subset of ImportHistoryEntry). */
export interface LocalJobRow {
  jobId: string
  fileName: string
  /** ms epoch when the browser recorded it — decides whether «no server status» means «aged out». */
  at: number
  /** B24 domain the job was uploaded from; absent on rows written before the field existed. */
  portal?: string
}
/** What the status endpoint returned for a job. */
export interface ServerJobRow {
  jobId: string
  status: JobStatus
  fileName: string
  result: string
  diskUrl?: string
  targetEntityTypeId?: number
}
/** One row of «Последние операции» — same shape as the server row (the merge only fills gaps). */
export type MergedJobRow = ServerJobRow

/** Shown instead of an outcome on a row whose server-side status has aged out. */
export const EXPIRED_RESULT
  = 'Статус этой загрузки больше не хранится на сервере — прошло больше 48 часов. Документ в CRM это не затрагивает.'

/** Server-side job status TTL (IMPORT_JOB_TTL_HOURS default). Mirrored here to date the `expired` claim. */
export const SERVER_STATUS_TTL_MS = 48 * 60 * 60 * 1000

export interface MergeOptions {
  /** Current portal's B24 domain. Rows from a different portal are never shown as `expired`. */
  portal?: string
  now?: number
  ttlMs?: number
}

/**
 * Merge server statuses into the local history, preserving the local order (newest-first) and the
 * remembered file name.
 *
 * A row missing from the server response is shown as `expired` ONLY when we can actually justify that
 * word: it belongs to THIS portal and it is older than the server's status TTL. Two reasons for the
 * guards, both found in review:
 *  • localStorage is per-ORIGIN, not per-portal — one browser used in two portals shares this list, so
 *    without the portal check portal B would display file names uploaded in portal A;
 *  • a job whose upload never reached the server is remembered locally from the first millisecond —
 *    calling it «статус хранится 48 часов и истёк» would be a plain lie.
 * Anything else missing from the server is dropped, exactly as before.
 */
export function mergeJobRows(local: LocalJobRow[], server: ServerJobRow[], opts: MergeOptions = {}): MergedJobRow[] {
  const { portal, now = Date.now(), ttlMs = SERVER_STATUS_TTL_MS } = opts
  const byId = new Map(server.map(j => [j.jobId, j]))
  const rows: MergedJobRow[] = []
  for (const e of local) {
    const j = byId.get(e.jobId)
    if (!j) {
      const samePortal = !!portal && e.portal === portal
      const agedOut = now - e.at >= ttlMs
      if (samePortal && agedOut) rows.push({ jobId: e.jobId, status: 'expired', fileName: e.fileName, result: EXPIRED_RESULT })
      continue
    }
    rows.push({
      jobId: j.jobId,
      status: j.status,
      fileName: e.fileName || j.fileName,
      result: j.result,
      ...(j.diskUrl ? { diskUrl: j.diskUrl } : {}),
      ...(j.targetEntityTypeId ? { targetEntityTypeId: j.targetEntityTypeId } : {})
    })
  }
  return rows
}
