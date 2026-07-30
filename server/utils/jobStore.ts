import type { DiskFileRef } from './disk'
import type { TargetRef } from '~/types/mapping'
import { isRelativePath } from './configurableActivity'
import { parseManualTarget } from '~/utils/manualTarget'

// Per-portal import-job tracking over an injected JobRedis (testable without infra).
//
// STORAGE (#B/#D): jobs live in REDIS with a TTL — NOT Postgres — so nothing accumulates (native PX
// expiry, no sweep). Each job is a hash `import:job:{member}:{jobId}` (status/fileName/result/
// manualOverride/diskFile/notified/createdAt). There is NO server-side per-portal list: the employee's
// browser keeps its own job list in localStorage (app/utils/importHistory.ts) and polls status BY ID
// (getJob) — the status list is only useful to the person who ran the import. The raw bytes / extracted
// text live elsewhere and are deleted at their own stages (docs/PROCESS.md); this is only the
// lightweight per-job status the client polls.

export type JobStatus = 'queued' | 'extracting' | 'processing' | 'done' | 'error'

export interface ImportJob {
  memberId: string
  jobId: string
  status: JobStatus
  fileName: string
  result: string
  /** Same-portal RELATIVE path to the archived source file on the Disk, if it was saved (opt-in
   *  `saveFile`). Lets the UI turn the file name into a link to the original document. Absent when
   *  the file wasn't archived. Always relative (never off-portal) — see detailUrlToRelative. */
  diskUrl?: string
  /** CRM type the employee manually chose for this file, when they did (#269) — shown in the row so
   *  the target is visible next to the outcome. Absent when the routing rules decided. */
  targetEntityTypeId?: number
}

/** Portal id of the person who uploaded the document — so a failure can be told to THEM, not just
 *  left in a list they may never reopen. Never sent to the browser: it is only a chat address. */
export async function getUploaderId(memberId: string, jobId: string, redis: JobRedis): Promise<string | null> {
  const h = await redis.getAll(jobKey(memberId, jobId))
  const raw = h?.uploaderId
  return raw && /^[1-9][0-9]*$/.test(raw) ? raw : null
}

/**
 * Minimal Redis surface the job store needs — injected so the store stays pure/testable with a fake
 * (no ioredis import here; the live adapter lives in jobStoreRedis.ts). All methods are job-oriented
 * so the fake is trivial. `put` writes a subset of hash fields + refreshes TTL; `claim` is an atomic
 * once-only set (HSETNX) for the finalize guard; the index methods keep a capped recent-jobs list.
 */
export interface JobRedis {
  /** HSET the given fields on the hash + (re)set its TTL. Partial updates are fine. */
  put: (key: string, fields: Record<string, string>, ttlMs: number) => Promise<void>
  /** HGETALL → field map, or null when the hash is absent/expired. */
  getAll: (key: string) => Promise<Record<string, string> | null>
  /** HSETNX field='1' + refresh TTL. Returns true only for the FIRST caller (atomic claim). */
  claim: (key: string, field: string, ttlMs: number) => Promise<boolean>
}

/** Job TTL (ms). A job lives for minutes; the generous default keeps a finished result pollable well
 *  past the client's window, then Redis evicts it — nothing accumulates. Env-overridable. */
export const JOB_TTL_MS = (() => {
  const h = Number(process.env.IMPORT_JOB_TTL_HOURS)
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, 720) : 48
  return hours * 60 * 60 * 1000
})()

const jobKey = (memberId: string, jobId: string): string => `import:job:${memberId}:${jobId}`

export async function createJob(
  memberId: string,
  jobId: string,
  fileName: string,
  redis: JobRedis,
  manualOverride?: TargetRef | null,
  uploaderId?: string | null
): Promise<void> {
  await redis.put(jobKey(memberId, jobId), {
    status: 'queued',
    fileName,
    result: '',
    createdAt: String(Date.now()),
    ...(manualOverride ? { manualOverride: JSON.stringify(manualOverride) } : {}),
    ...(uploaderId ? { uploaderId } : {})
  }, JOB_TTL_MS)
}

/** Read the operator's manual import target for a job (set at upload), or undefined. The stored
 *  JSON is re-validated through parseManualTarget so a hand-tampered value can't inject a bad target. */
export async function getManualOverride(memberId: string, jobId: string, redis: JobRedis): Promise<TargetRef | undefined> {
  const h = await redis.getAll(jobKey(memberId, jobId))
  const raw = h?.manualOverride
  if (!raw) return undefined
  try {
    return parseManualTarget(JSON.parse(raw)) ?? undefined
  } catch {
    return undefined
  }
}

/** Persist the archived source-file ref (id + DETAIL_URL) for a job — best-effort (#129 follow-up:
 *  crm-sync links it on the timeline дело). Stored as JSON in the `diskFile` hash field. */
export async function setDiskFile(memberId: string, jobId: string, ref: DiskFileRef, redis: JobRedis): Promise<void> {
  await redis.put(jobKey(memberId, jobId), { diskFile: JSON.stringify({ id: ref.id, detailUrl: ref.detailUrl }) }, JOB_TTL_MS)
}

/** Normalize a stored Disk open-URL to a same-portal RELATIVE path. We now store a CONSTRUCTED relative
 *  URL (`/docs/file/<path>?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER`, see disk.commonDiskFileUrl) → the first
 *  branch returns it verbatim, KEEPING its query (the query is our own static IFRAME flags, no token).
 *  A legacy ABSOLUTE URL is reduced to its path (host+query discarded) — still SSRF-safe. Returns null
 *  for anything that can't be reduced to a clean leading-slash path. */
/**
 * Should the operator be told that the timeline дело is going out without the «Исходный файл»
 * button? Only when the admin actually asked for the file to be kept — otherwise there is nothing
 * to miss (#263).
 *
 * Since the extract stage archives BEFORE handing the job on, a missing link here means something
 * genuinely went wrong. Deliberately says «нет ссылки на копию», NOT «загрузка не удалась»: the
 * link can also be absent when the upload succeeded but the reference didn't persist, when the job
 * store is unreachable, or when `saveFile` was switched on between the two stages. Naming a cause
 * we haven't established would send the operator looking in the wrong place.
 */
export function shouldWarnMissingArchive(saveFile: boolean, sourceFileUrl: string | null | undefined): boolean {
  return saveFile === true && !sourceFileUrl
}

export function detailUrlToRelative(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null
  if (isRelativePath(url)) return url // safe relative path (shared guard) — query preserved
  try {
    const u = new URL(url) // absolute → take the PATH only; host+query discarded, so the redirect
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null // stays on-portal
    const path = u.pathname
    return isRelativePath(path) ? path : null
  } catch {
    return null // protocol-relative («//host») / garbage → no button
  }
}

/** Read the archived source file's DETAIL_URL for a job as a same-portal RELATIVE path, or null. */
export async function getDiskFileUrl(memberId: string, jobId: string, redis: JobRedis): Promise<string | null> {
  const h = await redis.getAll(jobKey(memberId, jobId))
  const raw = h?.diskFile
  if (!raw) return null
  try {
    return detailUrlToRelative((JSON.parse(raw) as { detailUrl?: unknown })?.detailUrl)
  } catch {
    return null
  }
}

/** Read the archived source file's Disk file id for a job (for the #332 byte-upload download), or null. */
export async function getDiskFileId(memberId: string, jobId: string, redis: JobRedis): Promise<number | null> {
  const h = await redis.getAll(jobKey(memberId, jobId))
  const raw = h?.diskFile
  if (!raw) return null
  try {
    const id = Number((JSON.parse(raw) as { id?: unknown })?.id)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export async function setJobStatus(memberId: string, jobId: string, status: JobStatus, result: string, redis: JobRedis): Promise<void> {
  await redis.put(jobKey(memberId, jobId), { status, result }, JOB_TTL_MS)
}

/**
 * Atomically CLAIM the one-time «finalize» (success chat + timeline дело) for a job (#164): HSETNX the
 * `notified` field — exactly one caller flips absent→'1' and gets `true`, everyone after gets `false`.
 * So a retry resuming after a post-create failure, or a concurrent stalled redelivery, still finalizes
 * exactly once. If Redis is unavailable the claim returns false → fail toward «missed notice over
 * double post» (the accepted trade in #164).
 *
 * NB (TTL-bounded, #B): the claim now lives on the job hash, so the once-only memory lasts JOB_TTL_MS
 * (default 48h), not 30 days as the old Postgres row did. This is safe because BullMQ's own job
 * retention window is far shorter than the TTL — a redelivery arrives (and re-claims) only while the
 * hash is still alive. A redelivery AFTER the hash expired (astronomically rare — the BullMQ job is
 * long gone by then) would re-claim and re-post; bump IMPORT_JOB_TTL_HOURS if you configure unusually
 * long queue retention.
 */
export async function claimJobNotify(memberId: string, jobId: string, redis: JobRedis): Promise<boolean> {
  return redis.claim(jobKey(memberId, jobId), 'notified', JOB_TTL_MS)
}

/** Same once-only claim, for the FAILURE notification. A separate field from `notified`: success
 *  and failure are different events, and a job that failed was never notified as a success. */
export async function claimJobFailNotify(memberId: string, jobId: string, redis: JobRedis): Promise<boolean> {
  return redis.claim(jobKey(memberId, jobId), 'failNotified', JOB_TTL_MS)
}

function mapJob(memberId: string, jobId: string, h: Record<string, string>): ImportJob {
  // Surface the archived Disk file as a same-portal RELATIVE path (never off-portal) so the UI can
  // link the file name to the original document. Bad/absent → omitted.
  let diskUrl: string | null = null
  if (h.diskFile) {
    try {
      diskUrl = detailUrlToRelative((JSON.parse(h.diskFile) as { detailUrl?: unknown })?.detailUrl)
    } catch { /* malformed → no link */ }
  }
  // The manually chosen target, so the row can show WHERE the file was sent (#269). By the time a
  // result (or an error) appears, the employee no longer remembers what they picked — especially in a
  // batch, where every file has its own target. Re-validated, same as getManualOverride.
  let targetEntityTypeId: number | undefined
  if (h.manualOverride) {
    try {
      targetEntityTypeId = parseManualTarget(JSON.parse(h.manualOverride))?.entityTypeId
    } catch { /* malformed → no target shown */ }
  }
  return {
    memberId,
    jobId,
    status: (h.status || 'queued') as JobStatus,
    fileName: h.fileName ?? '',
    result: h.result ?? '',
    ...(diskUrl ? { diskUrl } : {}),
    ...(targetEntityTypeId ? { targetEntityTypeId } : {})
  }
}

export async function getJob(memberId: string, jobId: string, redis: JobRedis): Promise<ImportJob | null> {
  const h = await redis.getAll(jobKey(memberId, jobId))
  return h && Object.keys(h).length ? mapJob(memberId, jobId, h) : null
}
