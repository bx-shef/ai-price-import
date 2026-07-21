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

// POST /api/import/upload — in-portal document upload. Frame-token authenticated and
// bound to a verified portal member_id (no client-trusted id → no cross-portal
// injection). Stores the file, creates a job, enqueues file-extract. docs/redesign 02 §4.
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

      // Refuse early if the pipeline can't run — otherwise we'd store bytes + a job that
      // never processes (orphaned file, job stuck 'queued').
      if (!queueEnabled()) {
        span.outcome = 'unavailable'
        setResponseStatus(event, 503)
        return { error: 'сервис обработки временно недоступен' }
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

      const jobId = randomUUID()
      await createJob(member.memberId, jobId, file.filename, jobRedis, manualOverride)
      await saveUpload(member.memberId, jobId, file.data, nodeFileIO)
      await enqueueExtract({ memberId: member.memberId, jobId, fileId: file.filename })
      return { jobId, status: 'queued' }
    }
  )
})
