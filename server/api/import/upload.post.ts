import { randomUUID } from 'node:crypto'
import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { createJob } from '../../utils/jobStore'
import { jobRedis } from '../../utils/jobStoreRedis'
import { saveUpload } from '../../utils/fileStore'
import { nodeFileIO } from '../../utils/nodeFileIO'
import { enqueueExtract } from '../../queue/producers'
import { queueEnabled } from '../../queue/connection'
import { MAX_UPLOAD_BYTES, validateUploadFile } from '~/utils/importUpload'
import { parseManualTarget } from '~/utils/manualTarget'
import { bodySizeStatus, edgeSecurityEnabled } from '../../utils/edgeSecurity'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'
import { checkUploadRate, uploadRateMessage } from '../../utils/uploadRateLimit'

/** A plain UUID (v1–v5) — the only shape accepted for a client-supplied jobId (Redis key safety). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/import/upload — in-portal document upload. Frame-token authenticated and
// bound to a verified portal member_id (no client-trusted id → no cross-portal
// injection). Stores the file, creates a job, enqueues file-extract. docs/PROCESS.md
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id. The file bytes / name / target are NEVER attached to the span.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.import-upload.post', method: 'POST', op: 'import-upload.enqueue', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const member = await resolveFrameMember(auth, { query })
      if (!member.ok || !member.memberId) {
        span.outcome = 'auth_failed'
        console.warn(`[import/upload] auth fail: reason=${member.reason} domain=${auth.domain} status=${member.status}`)
        setResponseStatus(event, member.status ?? 401)
        return { error: 'authorization failed', reason: member.reason }
      }

      // ⚠ Гейта «портал принял условия» здесь БОЛЬШЕ НЕТ (#438, решение владельца 2026-08-05).
      // Принятие собирает Маркет Битрикс24 ДО установки — тремя галочками со ссылками в диалоге
      // установки; п. 2.7 Лицензионного соглашения считает его заключённым С МОМЕНТА УСТАНОВКИ, а
      // п. 4.3.2 («Загружая Документ») даёт подтверждение прав на КАЖДЫЙ документ — конклюдентно,
      // самим актом загрузки. Запись о принятии видна издателю в личном кабинете Маркета.
      // ⚠ Не восстанавливать: собственная проверка здесь недостижима по построению — без принятия
      // нет установки, без установки нет токена портала, а без него запрос не проходит проверку
      // фрейм-токена строкой выше. Условие, которое не может оказаться ложным, защищает не
      // приложение, а видимость проверки — и стоило лишнего обращения к базе на каждый документ.

      // Refuse early if the pipeline can't run — otherwise we'd store bytes + a job that
      // never processes (orphaned file, job stuck 'queued'). Checked BEFORE the rate limit so a
      // refusal we caused ourselves does not spend the caller's quota.
      if (!queueEnabled()) {
        span.outcome = 'unavailable'
        setResponseStatus(event, 503)
        return { error: 'сервис обработки временно недоступен' }
      }

      // Bound how fast one person can submit (PROCESS.md §6.8). Checked right after the identity is
      // proven and BEFORE the body is buffered — refusing after reading 25 МБ would do the work the
      // limit exists to avoid. Keyed per portal user, so one colleague's batch cannot throttle another.
      const rate = await checkUploadRate(member.memberId, member.userId, Date.now())
      if (!rate.allowed) {
        // Its OWN outcome, not 'forbidden': lumping it with the admin gate would make «нас душит
        // лимит» indistinguishable from «этот сотрудник не админ» in telemetry — and the rate of
        // this refusal is exactly what tells us whether the threshold is set right.
        span.outcome = 'rate_limited'
        setResponseStatus(event, 429)
        setResponseHeader(event, 'retry-after', Math.ceil(rate.retryAfterMs / 1000))
        return { error: uploadRateMessage(rate.retryAfterMs) }
      }

      // Pre-check the declared size before buffering the whole multipart body (DoS). On the no-nginx
      // target (edge security on) also require a Content-Length — a chunked body with none would buffer
      // unbounded (nginx's client_max_body_size backstop is absent). Behind nginx nginx handles it.
      const declared = Number(getHeader(event, 'content-length') || 0)
      const bodyStatus = bodySizeStatus(edgeSecurityEnabled(process.env), declared, MAX_UPLOAD_BYTES + 1_000_000)
      if (bodyStatus === 411) {
        span.outcome = 'bad_request'
        setResponseStatus(event, 411)
        return { error: 'не указан размер запроса' }
      }
      if (bodyStatus === 413) {
        span.outcome = 'bad_request'
        setResponseStatus(event, 413)
        return { error: 'файл слишком большой' }
      }

      const form = await readMultipartFormData(event)
      const file = form?.find(p => p.name === 'file' && p.filename)
      if (!file || !file.filename || !file.data?.length) {
        span.outcome = 'bad_request'
        setResponseStatus(event, 400)
        return { error: 'файл не передан' }
      }
      const v = validateUploadFile({ name: file.filename, size: file.data.length })
      if (!v.ok) {
        span.outcome = 'bad_request'
        setResponseStatus(event, 400)
        return { error: v.error }
      }

      // Optional manual target («куда импортировать» chosen by the operator) — a `target` form field
      // carrying JSON {entityTypeId, categoryId?, stageId?}. Untrusted → validated to a safe TargetRef
      // (or dropped) by parseManualTarget; when set it overrides the routing rules for THIS job only.
      const targetPart = form?.find(p => p.name === 'target')
      const manualOverride = targetPart?.data?.length ? parseManualTarget(targetPart.data.toString('utf8')) : null

      // Idempotency key: the client MAY supply a stable jobId (a UUID it keeps for a given staged file
      // across retries). Reusing it makes a retry idempotent — crm-sync's marker (originId/xmlId = jobId)
      // finds the prior create → no duplicate CRM entity, and the client can record the job before the
      // response (never an invisible import). Must be a plain UUID (it becomes part of the Redis key
      // `import:job:{member}:{jobId}` — reject anything else so a client can't inject key structure). The
      // key is member-scoped, so it can only touch the caller's own portal namespace.
      const clientJobId = form?.find(p => p.name === 'jobId')?.data?.toString('utf8').trim()
      const jobId = clientJobId && UUID_RE.test(clientJobId) ? clientJobId : randomUUID()
      // Who uploaded it — so a failure can be told to THEM personally, not just left in a list they
      // may never reopen (бэклог §1). Comes from the verified frame token's own `profile`, never
      // from the request body. Never returned to the browser: it is only a chat address.
      await createJob(member.memberId, jobId, file.filename, jobRedis, manualOverride, member.userId)
      await saveUpload(member.memberId, jobId, file.data, nodeFileIO)
      await enqueueExtract({ memberId: member.memberId, jobId, fileId: file.filename })
      return { jobId, status: 'queued' }
    }
  )
})
