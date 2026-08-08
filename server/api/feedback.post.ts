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
import { feedbackIntakeGate } from '../utils/feedbackIntake'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { fetchActivityFile, downloadAttachment } from '../utils/activityFileFetch'
import { originatorCode } from '../utils/originMarker'
import { sdkPortalDeps, makePortalSdkCall } from '../utils/b24Sdk'
import { MAX_FEEDBACK_FILE_BYTES } from '~/config/uploadFormats'
import type { FetchFn } from '../utils/b24Rest'

/**
 * Portal REST bound to the installed portal's own OAuth token.
 *
 * ⚠ Именно токеном ПОРТАЛА, а не фрейм-токеном сотрудника — по той же причине, что и в журнале
 * (#458): фрейм-токен несёт права своего пользователя, и дело в недоступной ему карточке просто не
 * вернулось бы, то есть вложение терялось бы у одних людей и находилось у других. Сужение до
 * «своих» делает НАШ фильтр по `RESPONSIBLE_ID`, и оно явное.
 */
function feedbackPortalCall(memberId: string) {
  return makePortalSdkCall(memberId, sdkPortalDeps({
    query,
    clientId: process.env.B24_CLIENT_ID ?? '',
    clientSecret: process.env.B24_CLIENT_SECRET ?? '',
    encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
    now: () => Date.now()
  })).then(t => (t ? (method: string, params: Record<string, unknown>) => t.call(method, params) : null))
}

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
      // ⚠ Тело запроса БАЙТ БОЛЬШЕ НЕ НЕСЁТ (#461): документ читается из дела таймлайна ниже.
      // Отсюда и снятый кап вложения — он держался ровно на том, что base64 ехал внутри JSON и
      // упирался в предел тела роута.
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
          }
        } catch { /* best-effort: less context rather than a failed submission */ }
      }
      // ВЛОЖЕНИЕ — отдельной веткой, НЕ внутри «нашлось ли задание» (#461). Задание живёт 48 часов,
      // а дело с документом — сколько его держит портал; вложенная ветка теряла бы файл ровно у
      // старого импорта, про который отзыв особенно ценен.
      if (jobId && attachFile) {
        try {
          // Attach the source document itself, so the publisher can reproduce the run.
          //
          // Ask GitHub whether the receiver is actually private BEFORE reading any bytes (#200).
          // The slug comes from an env var and nothing else verifies it: one typo, or the repo
          // being flipped to public later, and real invoices become public. Cached, three-state —
          // "could not verify" blocks the upload just like "public" does, but is retried sooner.
          const call = await feedbackPortalCall(member.memberId)
          if (call && await feedbackUploadAllowed(config, fetchImpl)) {
            // Байты берутся ИЗ ДЕЛА ТАЙМЛАЙНА (#461), а не из памяти страницы. Своей копии
            // документа у нас нет (воркер удаляет её сразу, #349), архива на Диске больше не
            // существует (#458) — зато у КАЖДОГО импорта, включая неразобранный, есть дело с
            // вложенным документом. Прежний путь через страницу оставлял дыру: перезагрузил
            // вкладку до отправки отзыва — и отзыв уходил без того, по чему прогон только и
            // можно воспроизвести.
            // ⚠ Сужение по сотруднику из ПРОВЕРЕННОГО фрейм-токена живёт внутри `fetchActivityFile`:
            // `jobId` присылает клиент, и без него чужой идентификатор задания вытянул бы чужой
            // документ.
            const got = await fetchActivityFile(jobId, member.userId, {
              call,
              download: downloadAttachment,
              originatorCode: originatorCode(process.env.IMPORT_ORIGINATOR_ID),
              maxBytes: MAX_FEEDBACK_FILE_BYTES
            })
            // В журнал идёт только КЛАСС промаха: имя файла и адрес вложения — данные клиента.
            if (!got.ok) console.warn(`[feedback] attachment miss: ${got.miss}`)
            if (got.ok) {
              // Global hourly ceiling on the RECEIVER (#354) — checked HERE, immediately before
              // the commit, and not earlier. Earlier it metered intent instead of cost: a review
              // whose bytes never materialised still spent the ceiling, so 60 tiny bodies with
              // `attachFile:true` could turn attachments off for every tenant at zero cost to
              // whoever sent them. A ceiling worth exhausting must cost the sender what it protects.
              //
              // Over the ceiling the review is still filed — only without its file, and the
              // employee is told so: the text of a review is worth more than the file, and a
              // silent drop would leave them believing the document went out.
              const budget = await checkAttachBudget(member.memberId, Date.now())
              if (!budget.allowed) {
                attachNotice = budget.notice
              } else {
                const commit = await commitFeedbackFile(
                  config, feedbackFilePath(portalTag, jobId, got.file.name), got.file.base64,
                  `feedback file for job ${jobId}`, fetchImpl
                )
                if (commit.ok && commit.htmlUrl) fileUrl = commit.htmlUrl
              }
            }
          }
        } catch { /* best-effort: отзыв важнее вложения и уходит в любом случае */ }
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
