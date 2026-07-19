import type { QueryFn } from './tokenStore'
import type { DiskFileRef } from './disk'
import type { TargetRef } from '~/types/mapping'
import { isRelativePath } from './configurableActivity'
import { parseManualTarget } from '~/utils/manualTarget'

// Per-portal import-job tracking over an injected QueryFn (testable without a DB).

export type JobStatus = 'queued' | 'extracting' | 'processing' | 'done' | 'error'

export interface ImportJob {
  memberId: string
  jobId: string
  status: JobStatus
  fileName: string
  result: string
}

export async function createJob(
  memberId: string,
  jobId: string,
  fileName: string,
  query: QueryFn,
  manualOverride?: TargetRef | null
): Promise<void> {
  await query(
    `INSERT INTO import_job (member_id, job_id, status, file_name, manual_override)
     VALUES ($1,$2,'queued',$3,$4)
     ON CONFLICT (member_id, job_id) DO NOTHING`,
    [memberId, jobId, fileName, manualOverride ? JSON.stringify(manualOverride) : null]
  )
}

/** Read the operator's manual import target for a job (set at upload), or undefined. The stored
 *  JSON is re-validated through parseManualTarget so a hand-tampered row can't inject a bad target. */
export async function getManualOverride(memberId: string, jobId: string, query: QueryFn): Promise<TargetRef | undefined> {
  const { rows } = await query('SELECT manual_override FROM import_job WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
  const raw = rows[0]?.manual_override
  if (raw == null) return undefined
  // pg returns JSONB already parsed (object); tolerate a string too.
  return parseManualTarget(raw) ?? undefined
}

/** Persist the archived source-file ref (id + DETAIL_URL) for a job — best-effort (#129 follow-up:
 *  crm-sync links it on the timeline дело). Stored as JSON in `import_job.disk_file`. */
export async function setDiskFile(memberId: string, jobId: string, ref: DiskFileRef, query: QueryFn): Promise<void> {
  await query(
    'UPDATE import_job SET disk_file=$3, updated_at=now() WHERE member_id=$1 AND job_id=$2',
    [memberId, jobId, JSON.stringify({ id: ref.id, detailUrl: ref.detailUrl })]
  )
}

/** Normalize a Disk DETAIL_URL to a same-portal RELATIVE path. `disk.folder.uploadfile` returns an
 *  ABSOLUTE URL (`https://<portal>/docs/file/…`, live-verified), so we strip it to its path — a
 *  relative `/…` redirect can never leave the portal, so this is SSRF-safe even for a tampered row.
 *  Returns null for anything that can't be reduced to a clean leading-slash path. */
export function detailUrlToRelative(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null
  if (isRelativePath(url)) return url // already a safe relative path (shared guard)
  try {
    const u = new URL(url) // absolute → take the PATH only; host+query discarded, so the redirect
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null // stays on-portal and can't
    const path = u.pathname // ever surface a query token (DETAIL_URL has none, DOWNLOAD_URL isn't stored)
    return isRelativePath(path) ? path : null
  } catch {
    return null // protocol-relative («//host») / garbage → no button
  }
}

/** Read the archived source file's DETAIL_URL for a job as a same-portal RELATIVE path, or null. */
export async function getDiskFileUrl(memberId: string, jobId: string, query: QueryFn): Promise<string | null> {
  const { rows } = await query('SELECT disk_file FROM import_job WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
  const raw = rows[0]?.disk_file
  if (raw == null) return null
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  }
  return detailUrlToRelative((obj as { detailUrl?: unknown })?.detailUrl)
}

export async function setJobStatus(memberId: string, jobId: string, status: JobStatus, result: string, query: QueryFn): Promise<void> {
  await query(
    'UPDATE import_job SET status=$3, result=$4, updated_at=now() WHERE member_id=$1 AND job_id=$2',
    [memberId, jobId, status, result]
  )
}

/**
 * Atomically CLAIM the one-time «finalize» (success chat + timeline дело) for a job (#164).
 * Flips `notified` false→true in a single UPDATE and RETURNs the row only to the winner, so
 * exactly one run finalizes even under a retry that resumes after a post-create failure or a
 * concurrent stalled redelivery: the first caller gets `true`, everyone after gets `false`.
 * A missing job row (anomalous — the row is created at ingestion) also yields `false` → the
 * notification is skipped rather than risking a post without a tracked job (fail toward
 * «missed notice over double post», the accepted trade in #164).
 */
export async function claimJobNotify(memberId: string, jobId: string, query: QueryFn): Promise<boolean> {
  const { rows } = await query(
    `UPDATE import_job SET notified=true, updated_at=now()
     WHERE member_id=$1 AND job_id=$2 AND notified=false
     RETURNING job_id`,
    [memberId, jobId]
  )
  return rows.length > 0
}

function mapJob(r: Record<string, unknown>): ImportJob {
  return {
    memberId: String(r.member_id),
    jobId: String(r.job_id),
    status: String(r.status) as JobStatus,
    fileName: String(r.file_name ?? ''),
    result: String(r.result ?? '')
  }
}

/** Recent jobs for a portal (newest first), for the in-portal status view. */
export async function listJobs(memberId: string, query: QueryFn, limit = 50): Promise<ImportJob[]> {
  const capped = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
  const { rows } = await query(
    `SELECT * FROM import_job WHERE member_id=$1 ORDER BY created_at DESC LIMIT ${capped}`,
    [memberId]
  )
  return rows.map(mapJob)
}

export async function getJob(memberId: string, jobId: string, query: QueryFn): Promise<ImportJob | null> {
  const { rows } = await query('SELECT * FROM import_job WHERE member_id=$1 AND job_id=$2', [memberId, jobId])
  return rows[0] ? mapJob(rows[0]) : null
}
