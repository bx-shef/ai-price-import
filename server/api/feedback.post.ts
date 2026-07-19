import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { findFeedbackIssueByCode, postFeedbackIssue } from '../utils/feedbackGithub'
import { buildFeedbackIssue, feedbackDedupCode, normalizeKind } from '~/utils/feedback'
import { parseJobResult } from '~/utils/jobStatus'
import { query } from '../db/client'
import { METRICS, bumpCounter } from '../utils/metricsStore'
import { getDiskFileUrl, getJob } from '../utils/jobStore'
import { jobRedis } from '../utils/jobStoreRedis'
import { absPortalUrl, resolveFeedbackEntity, resolveFeedbackOutcome } from '../utils/feedbackEntity'
import type { FetchFn } from '../utils/b24Rest'

/** jobId shape accepted for the DB lookup (matches the builder's context validation). */
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/

// POST /api/feedback — employee 👍/👎 + comment on the import result → a GitHub issue in the
// configured PRIVATE receiving repo (#182 channel «сотрудник»). Frame-token authenticated (the
// submitter is in-portal). Channel-gated: no config → 503 (widget is hidden client-side too).
export default defineEventHandler(async (event) => {
  const config = resolveFeedbackConfig()
  if (!config) {
    setResponseStatus(event, 503)
    return { error: 'канал отзывов не настроен' }
  }
  // Auth: prove the submitter belongs to a real installed portal (blocks anonymous spam).
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const member = await resolveFrameMember(auth, { query })
  if (!member.ok || !member.memberId) {
    setResponseStatus(event, member.status ?? 401)
    return { error: 'authorization failed', reason: member.reason }
  }

  const raw = await readBody(event).catch(() => null) as
    { kind?: unknown, comment?: unknown, attachFile?: unknown, context?: Record<string, unknown> } | null
  const kind = normalizeKind(raw?.kind)
  if (!kind) {
    setResponseStatus(event, 400)
    return { error: 'неизвестная оценка' }
  }
  // Context (jobId/file/version) is client-supplied and rendered inert by the builder; the
  // receiving repo is private so client data is permitted (see feedback.ts module header).
  const c = raw?.context ?? {}
  // Server-resolved context from the job's DURABLE row (never trusted from the client): the created
  // entity link (#192 п.2), the triage outcome (#192 п.1) and — only with the employee's explicit
  // consent (#192 п.3) — the source-file link that was archived to the portal Disk. Best-effort:
  // a missing/expired job simply yields no extra context. jobId is client-supplied → validate first.
  const jobId = typeof c.jobId === 'string' && JOB_ID_RE.test(c.jobId) ? c.jobId : ''
  const attachFile = raw?.attachFile === true
  const fetchImpl = globalThis.fetch as unknown as FetchFn
  // Dedup (#192) FIRST, before any job-context DB reads: a stable code from portal + jobId is embedded
  // in the issue title. If an issue with this code already exists (same file already rated), SKIP here —
  // don't file a duplicate, re-count telemetry, or waste the getJob/getDiskFileUrl reads below.
  // Fail-open: a search error yields no code-match and we proceed (a rare dup beats a lost report).
  const dedupCode = feedbackDedupCode(member.memberId, jobId)
  if (dedupCode) {
    const existing = await findFeedbackIssueByCode(config, dedupCode, fetchImpl)
    if (existing.found) return { ok: true, duplicate: true, number: existing.number, url: existing.url }
  }
  // Server-resolved context from the job's DURABLE row (never trusted from the client): the created
  // entity link (#192 п.2), the triage outcome (#192 п.1) and — only with the employee's explicit
  // consent (#192 п.3) — the source-file link that was archived to the portal Disk. Best-effort:
  // a missing/expired job simply yields no extra context.
  let entity: { entityType?: string, entityId?: string, entityUrl?: string } = {}
  let outcome: { status?: string, outcome?: string, notes?: string } = {}
  let fileUrl: string | undefined
  if (jobId) {
    try {
      const job = await getJob(member.memberId, jobId, jobRedis)
      if (job) {
        const view = parseJobResult(job.result)
        entity = resolveFeedbackEntity(view, auth.domain)
        outcome = resolveFeedbackOutcome(view, job.status)
        if (attachFile) {
          // getDiskFileUrl returns a same-portal RELATIVE path (SSRF-guarded) or null (file not
          // archived — the raw upload is deleted after extraction, so only Disk-saved files survive).
          const rel = await getDiskFileUrl(member.memberId, jobId, jobRedis)
          if (rel) fileUrl = absPortalUrl(rel, auth.domain)
        }
      }
    } catch { /* best-effort: less context rather than a failed submission */ }
  }
  const payload = buildFeedbackIssue(kind, raw?.comment, {
    jobId: c.jobId,
    fileName: c.fileName,
    status: outcome.status,
    outcome: outcome.outcome,
    notes: outcome.notes,
    fileUrl,
    entityType: entity.entityType,
    entityId: entity.entityId,
    entityUrl: entity.entityUrl,
    appVersion: c.appVersion
  }, dedupCode)
  const result = await postFeedbackIssue(config, payload, fetchImpl)
  if (result.ok) {
    // Telemetry (#192 п.4): record the fact that a rating was sent — BOTH 👍 and 👎, so the
    // /metrics dashboard shows feedback volume, not just problems. Best-effort: a counter write
    // must never fail an already-created issue.
    await bumpCounter(member.memberId, kind === 'up' ? METRICS.feedbackUp : METRICS.feedbackDown, 1, query)
      .catch(() => {})
    return { ok: true, number: result.number }
  }
  // Never surface GitHub's body/URL/token — only a generic message + the retry hint.
  console.warn(`[feedback] github issue failed: status=${result.status} retryable=${result.retryable}`)
  setResponseStatus(event, result.retryable ? 502 : 500)
  return { error: 'не удалось отправить отзыв' }
})
