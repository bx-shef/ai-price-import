import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { commitFeedbackFile, postFeedbackIssue } from '../utils/feedbackGithub'
import { feedbackUploadAllowed } from '../utils/feedbackRepoPrivacy'
import { buildFeedbackIssue, feedbackFilePath, normalizeKind } from '~/utils/feedback'
import { portalHash } from '../utils/telemetryAttributes'
import { parseJobResult } from '~/utils/jobStatus'
import { query } from '../db/client'
import { METRICS, bumpCounter } from '../utils/metricsStore'
import { getJob } from '../utils/jobStore'
import { jobRedis } from '../utils/jobStoreRedis'
import { resolveFeedbackEntity, resolveFeedbackOutcome } from '../utils/feedbackEntity'
import { checkFeedbackRate, feedbackRateMessage } from '../utils/uploadRateLimit'
import { ATTACH_MISSING_NOTICE, checkAttachBudget } from '../utils/feedbackRepoBudget'
import { feedbackIntakeGate, parseClientFile } from '../utils/feedbackIntake'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import type { FetchFn } from '../utils/b24Rest'

/** jobId shape accepted for the DB lookup (matches the builder's context validation). */
const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/

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

      // Rate + size gate BEFORE the body is read (#349/#351 review) — the decision itself is a pure
      // function so it can be tested; the handler only performs its verdict.
      const refusal = feedbackIntakeGate({
        rate: await checkFeedbackRate(member.memberId, member.userId, Date.now()),
        declaredLength: Number(getHeader(event, 'content-length') || 0),
        rateMessage: feedbackRateMessage
      })
      if (refusal) {
        span.outcome = refusal.outcome
        setResponseStatus(event, refusal.status)
        if (refusal.retryAfterSec !== undefined) setResponseHeader(event, 'retry-after', refusal.retryAfterSec)
        return { error: refusal.error }
      }

      const raw = await readBody(event).catch(() => null) as
        { kind?: unknown, comment?: unknown, attachFile?: unknown, file?: unknown, context?: Record<string, unknown> } | null
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
      // The bytes now come FROM THE PAGE (#349): the extract worker deletes the upload as soon as the
      // text is out, so there is nothing on our disk to read back — and «документ не распознан» has no
      // Disk archive either. The browser still holds the File it sent, so it sends it again, once, and
      // only when the employee explicitly answered «с файлом».
      const clientFile = parseClientFile(raw?.file)
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
      // Псевдоним портала (#417): и метка задачи, и каталог файлов. Считается СЕРВЕРОМ из
      // проверенного фрейм-токена — подменить его телом запроса нельзя, поэтому чистка по
      // построению не может выйти за пределы своего портала.
      const portalTag = portalHash(member.memberId)
      let outcome: { status?: string, outcome?: string, notes?: string } = {}
      let fileUrl: string | undefined
      /** Told to the employee whenever the file did NOT go out (#354) — «принято» без оговорки
       *  прочиталось бы как «документ ушёл». */
      let attachNotice: string | undefined
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
                // Байты присылает САМА СТРАНИЦА (#349) — своей копии документа у нас нет.
                // ⚠ Запасного пути через архив на Диске БОЛЬШЕ НЕТ (#458): архива не существует,
                // документ вкладывается прямо в дело таймлайна. Значит вкладка, перезагруженная до
                // отправки отзыва, файла не даст — и виджет обязан честно предложить выбрать его
                // вручную, а не отправлять отзыв «пустым», выдавая это за успех.
                const name = clientFile?.name || (typeof c.fileName === 'string' && c.fileName ? c.fileName : `${jobId}.bin`)
                const base64 = clientFile?.base64
                if (base64) {
                  // Global hourly ceiling on the RECEIVER (#354) — checked HERE, immediately before
                  // the commit, and not earlier. Earlier it metered intent instead of cost: a review
                  // whose bytes never materialised (page sent none, no Disk archive, privacy probe
                  // said no) still spent the ceiling, so 60 tiny bodies with `attachFile:true` could
                  // turn attachments off for every tenant at zero cost to whoever sent them. A
                  // ceiling worth exhausting must cost the sender what it protects.
                  //
                  // Over the ceiling the review is still filed — only without its file, and the
                  // employee is told so: the text of a review is worth more than the file, and a
                  // silent drop would leave them believing the document went out.
                  const budget = await checkAttachBudget(member.memberId, Date.now())
                  if (!budget.allowed) {
                    attachNotice = budget.notice
                  } else {
                    const commit = await commitFeedbackFile(
                      config, feedbackFilePath(portalTag, jobId, name), base64, `feedback file for job ${jobId}`, fetchImpl
                    )
                    if (commit.ok && commit.htmlUrl) fileUrl = commit.htmlUrl
                  }
                }
              }
            }
          }
        } catch { /* best-effort: less context rather than a failed submission */ }
      }
      // Просили приложить файл, а ссылки на него нет — значит он не ушёл: задание истекло, страница
      // байт не прислала, архива на Диске нет или приёмник не подтверждён приватным. Причины разные,
      // исход для человека один, и он обязан быть назван. Ставится ПОСЛЕ всей ветки: раньше здесь
      // молчали везде, кроме исчерпанного предела.
      if (attachFile && !fileUrl && !attachNotice) attachNotice = ATTACH_MISSING_NOTICE
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
        appVersion: c.appVersion,
        // Псевдоним портала — чтобы отзывы клиента можно было найти по его обращению (#417).
        portalTag
      })
      const result = await postFeedbackIssue(config, payload, fetchImpl)
      if (result.ok) {
        // Telemetry (#192 п.4): record the fact that a rating was sent — BOTH 👍 and 👎, so the
        // /metrics dashboard shows feedback volume, not just problems. Best-effort: a counter write
        // must never fail an already-created issue.
        await bumpCounter(member.memberId, kind === 'up' ? METRICS.feedbackUp : METRICS.feedbackDown, 1, query)
          .catch(() => {})
        // `notice` тянется до виджета: файл выброшен молча — человек будет уверен, что документ ушёл.
        return { ok: true, number: result.number, ...(attachNotice ? { notice: attachNotice } : {}) }
      }
      // Never surface GitHub's body/URL/token — only a generic message + the retry hint.
      console.warn(`[feedback] github issue failed: status=${result.status} retryable=${result.retryable}`)
      span.outcome = 'upstream_error'
      setResponseStatus(event, result.retryable ? 502 : 500)
      return { error: 'не удалось отправить отзыв' }
    }
  )
})
