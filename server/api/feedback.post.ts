import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { postFeedbackIssue } from '../utils/feedbackGithub'
import { buildFeedbackIssue, normalizeKind } from '~/utils/feedback'
import { parseJobResult } from '~/utils/jobStatus'
import { query } from '../db/client'
import { METRICS, bumpCounter } from '../utils/metricsStore'
import { getJob } from '../utils/jobStore'
import { resolveFeedbackEntity } from '../utils/feedbackEntity'
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
    { kind?: unknown, comment?: unknown, context?: Record<string, unknown> } | null
  const kind = normalizeKind(raw?.kind)
  if (!kind) {
    setResponseStatus(event, 400)
    return { error: 'неизвестная оценка' }
  }
  // Context (jobId/file/version) is client-supplied and rendered inert by the builder; the
  // receiving repo is private so client data is permitted (see feedback.ts module header).
  const c = raw?.context ?? {}
  // Entity link (#192 п.2): resolve the CREATED entity SERVER-SIDE from the job's stored result,
  // NOT from the client (durable + trustworthy). Best-effort — a missing/expired job or a run that
  // created nothing simply yields no link. The jobId is client-supplied → validate before the query.
  const jobId = typeof c.jobId === 'string' && JOB_ID_RE.test(c.jobId) ? c.jobId : ''
  let entity: { entityType?: string, entityId?: string, entityUrl?: string } = {}
  if (jobId) {
    try {
      const job = await getJob(member.memberId, jobId, query)
      if (job) entity = resolveFeedbackEntity(parseJobResult(job.result), auth.domain)
    } catch { /* best-effort: no link rather than a failed submission */ }
  }
  const payload = buildFeedbackIssue(kind, raw?.comment, {
    jobId: c.jobId,
    fileName: c.fileName,
    entityType: entity.entityType,
    entityId: entity.entityId,
    entityUrl: entity.entityUrl,
    appVersion: c.appVersion
  })
  const result = await postFeedbackIssue(config, payload, globalThis.fetch as unknown as FetchFn)
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
