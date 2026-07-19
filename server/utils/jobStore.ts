import type { DiskFileRef } from './disk'
import type { TargetRef } from '~/types/mapping'
import { isRelativePath } from './configurableActivity'
import { parseManualTarget } from '~/utils/manualTarget'

// Per-portal import-job tracking over an injected JobRedis (testable without infra).
//
// STORAGE (#B): jobs live in REDIS with a TTL — NOT Postgres — so nothing accumulates (native PX
// expiry, no sweep) and no per-portal table grows unbounded. Each job is a hash
// `import:job:{member}:{jobId}` (status/fileName/result/manualOverride/diskFile/notified/createdAt);
// a per-member ZSET index `import:jobs:{member}` (score = createdAt, capped) powers listJobs. The raw
// bytes / extracted text still live elsewhere and are deleted at their own stages (docs/redesign 05);
// this is only the lightweight status/meta the /app view polls. Clients aren't launched yet, so there
// is no data to migrate off the dropped table.

export type JobStatus = 'queued' | 'extracting' | 'processing' | 'done' | 'error'

export interface ImportJob {
  memberId: string
  jobId: string
  status: JobStatus
  fileName: string
  result: string
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
  /** ZADD jobId with score, trim to the newest `cap`, refresh the index TTL. */
  indexAdd: (indexKey: string, jobId: string, score: number, cap: number, ttlMs: number) => Promise<void>
  /** ZREVRANGE the newest up-to-`limit` jobIds. */
  indexList: (indexKey: string, limit: number) => Promise<string[]>
}

/** Job TTL (ms). A job lives for minutes; the generous default keeps a finished result pollable well
 *  past the client's window, then Redis evicts it — nothing accumulates. Env-overridable. */
export const JOB_TTL_MS = (() => {
  const h = Number(process.env.IMPORT_JOB_TTL_HOURS)
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, 720) : 48
  return hours * 60 * 60 * 1000
})()

/** Recent-jobs index cap per portal (listJobs shows the newest N). */
const INDEX_CAP = 200

const jobKey = (memberId: string, jobId: string): string => `import:job:${memberId}:${jobId}`
const indexKey = (memberId: string): string => `import:jobs:${memberId}`

export async function createJob(
  memberId: string,
  jobId: string,
  fileName: string,
  redis: JobRedis,
  manualOverride?: TargetRef | null
): Promise<void> {
  const createdAt = Date.now()
  await redis.put(jobKey(memberId, jobId), {
    status: 'queued',
    fileName,
    result: '',
    createdAt: String(createdAt),
    ...(manualOverride ? { manualOverride: JSON.stringify(manualOverride) } : {})
  }, JOB_TTL_MS)
  await redis.indexAdd(indexKey(memberId), jobId, createdAt, INDEX_CAP, JOB_TTL_MS)
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

/** Normalize a Disk DETAIL_URL to a same-portal RELATIVE path. `disk.folder.uploadfile` returns an
 *  ABSOLUTE URL (`https://<portal>/docs/file/…`, live-verified), so we strip it to its path — a
 *  relative `/…` redirect can never leave the portal, so this is SSRF-safe even for a tampered value.
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

function mapJob(memberId: string, jobId: string, h: Record<string, string>): ImportJob {
  return {
    memberId,
    jobId,
    status: (h.status || 'queued') as JobStatus,
    fileName: h.fileName ?? '',
    result: h.result ?? ''
  }
}

/** Recent jobs for a portal (newest first), for the in-portal status view. Expired jobs whose hash
 *  already evicted are skipped (the index entry outlives the hash briefly; it self-trims on cap/TTL). */
export async function listJobs(memberId: string, redis: JobRedis, limit = 50): Promise<ImportJob[]> {
  const capped = Math.max(1, Math.min(200, Math.trunc(limit) || 50))
  const ids = await redis.indexList(indexKey(memberId), capped)
  const out: ImportJob[] = []
  for (const jobId of ids) {
    const h = await redis.getAll(jobKey(memberId, jobId))
    if (h && Object.keys(h).length) out.push(mapJob(memberId, jobId, h))
  }
  return out
}

export async function getJob(memberId: string, jobId: string, redis: JobRedis): Promise<ImportJob | null> {
  const h = await redis.getAll(jobKey(memberId, jobId))
  return h && Object.keys(h).length ? mapJob(memberId, jobId, h) : null
}
