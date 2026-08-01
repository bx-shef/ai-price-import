import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { commitFeedbackFile, postFeedbackIssue } from '../utils/feedbackGithub'
import { feedbackUploadAllowed } from '../utils/feedbackRepoPrivacy'
import { buildFeedbackIssue, feedbackFilePath, normalizeKind } from '~/utils/feedback'
import { parseJobResult } from '~/utils/jobStatus'
import { query } from '../db/client'
import { METRICS, bumpCounter } from '../utils/metricsStore'
import { getDiskFileId, getJob } from '../utils/jobStore'
import { jobRedis } from '../utils/jobStoreRedis'
import { readUploadBase64 } from '../utils/nodeFileIO'
import { resolveFeedbackEntity, resolveFeedbackOutcome } from '../utils/feedbackEntity'
import { makeBareTokenSdkCall } from '../utils/b24Sdk'
import { downloadDiskFile, type BinaryFetchFn } from '../utils/diskDownload'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import type { FetchFn } from '../utils/b24Rest'

/** jobId shape accepted for the DB lookup (matches the builder's context validation). */
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/

// POST /api/feedback — employee 👍/👎 + comment on the import result → a GitHub issue in the
// configured PRIVATE receiving repo (#182 channel «сотрудник»). Frame-token authenticated (the
// submitter is in-portal). Channel-gated: no config → 503 (widget is hidden client-side too).
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id. The comment / context / file is NEVER attached to the span.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.feedback.post', method: 'POST', op: 'feedback.submit', domain: auth?.domain },
    async (span) => {
      const config = resolveFeedbackConfig()
      if (!config) {
        span.outcome = 'unavailable'
        setResponseStatus(event, 503)
        return { error: 'канал отзывов не настроен' }
      }
      // Auth: prove the submitter belongs to a real installed portal (blocks anonymous spam).
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const member = await resolveFrameMember(auth, { query })
      if (!member.ok || !member.memberId) {
        span.outcome = 'auth_failed'
        setResponseStatus(event, member.status ?? 401)
        return { error: 'authorization failed', reason: member.reason }
      }

      const raw = await readBody(event).catch(() => null) as
        { kind?: unknown, comment?: unknown, attachFile?: unknown, context?: Record<string, unknown> } | null
      const kind = normalizeKind(raw?.kind)
      if (!kind) {
        span.outcome = 'bad_request'
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
      // Duplicate suppression lives in the widget's page state (no persisted client store any more —
      // localStorage dropped, owner rework): it won't offer feedback twice
      // for a jobId it already sent. No server-side search-before-create — it cost a GitHub Search call
      // per submit and was only best-effort anyway (eventual-consistency). Server just files the issue.
      // Server-resolved context from the job's row (never trusted from the client): the created
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
              // Attach the source document itself, so the publisher can reproduce the run — a
              // portal-Disk link is useless to them. Best-effort throughout: any miss just files the
              // issue without a file.
              //
              // Ask GitHub whether the receiver is actually private BEFORE reading any bytes (#200).
              // The slug comes from an env var and nothing else verifies it: one typo, or the repo
              // being flipped to public later, and real invoices become public. Cached, three-state —
              // "could not verify" blocks the upload just like "public" does, but is retried sooner.
              if (await feedbackUploadAllowed(config, fetchImpl)) {
                // OUR retained copy first (#200). The Disk archive only exists when the portal turned
                // `saveFile` on, and it is written only once a document got that far — so the case
                // feedback matters most for, «документ не распознан», had no file at all. The upload
                // bytes are kept for the job's lifetime precisely to close that hole.
                let name = typeof c.fileName === 'string' && c.fileName ? c.fileName : `${jobId}.bin`
                let base64 = await readUploadBase64(member.memberId, jobId)
                if (!base64) {
                  // Swept already (job older than its TTL) → fall back to the Disk archive if the
                  // portal keeps one. Carries the real stored name, so prefer it when present.
                  const diskId = await getDiskFileId(member.memberId, jobId, jobRedis)
                  if (diskId) {
                    const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
                    // redirect:'manual' — never follow a portal's redirect off-host (SSRF on the shared
                    // multitenant backend); AbortSignal.timeout — a slow/huge Disk body must not stall
                    // the 👍/👎 request. Body streamed + capped in downloadDiskFile.
                    const binFetch: BinaryFetchFn = async (url) => {
                      const r = await (globalThis.fetch as typeof fetch)(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
                      return { ok: r.ok, status: r.status, body: r.body as AsyncIterable<Uint8Array> | null }
                    }
                    const dl = await downloadDiskFile(diskId, auth.domain, call, binFetch)
                    if (dl) {
                      name = dl.name
                      base64 = dl.base64
                    }
                  }
                }
                if (base64) {
                  const commit = await commitFeedbackFile(
                    config, feedbackFilePath(jobId, name), base64, `feedback file for job ${jobId}`, fetchImpl
                  )
                  if (commit.ok && commit.htmlUrl) fileUrl = commit.htmlUrl
                }
              }
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
      })
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
      span.outcome = 'upstream_error'
      setResponseStatus(event, result.retryable ? 502 : 500)
      return { error: 'не удалось отправить отзыв' }
    }
  )
})
