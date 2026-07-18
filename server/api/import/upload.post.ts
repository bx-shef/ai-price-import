import { randomUUID } from 'node:crypto'
import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { createJob } from '../../utils/jobStore'
import { saveUpload } from '../../utils/fileStore'
import { nodeFileIO } from '../../utils/nodeFileIO'
import { enqueueExtract } from '../../queue/producers'
import { queueEnabled } from '../../queue/connection'
import { MAX_UPLOAD_BYTES, validateUploadFile } from '~/utils/importUpload'
import { parseManualTarget } from '~/utils/manualTarget'
import { query } from '../../db/client'

// POST /api/import/upload — in-portal document upload. Frame-token authenticated and
// bound to a verified portal member_id (no client-trusted id → no cross-portal
// injection). Stores the file, creates a job, enqueues file-extract. docs/redesign 02 §4.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const member = await resolveFrameMember(auth, { query })
  if (!member.ok || !member.memberId) {
    console.warn(`[import/upload] auth fail: reason=${member.reason} domain=${auth.domain} status=${member.status}`)
    setResponseStatus(event, member.status ?? 401)
    return { error: 'authorization failed', reason: member.reason }
  }

  // Refuse early if the pipeline can't run — otherwise we'd store bytes + a job that
  // never processes (orphaned file, job stuck 'queued').
  if (!queueEnabled()) {
    setResponseStatus(event, 503)
    return { error: 'сервис обработки временно недоступен' }
  }
  // Pre-check the declared size before buffering the whole multipart body (DoS).
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (declared && declared > MAX_UPLOAD_BYTES + 1_000_000) {
    setResponseStatus(event, 413)
    return { error: 'файл слишком большой' }
  }

  const form = await readMultipartFormData(event)
  const file = form?.find(p => p.name === 'file' && p.filename)
  if (!file || !file.filename || !file.data?.length) {
    setResponseStatus(event, 400)
    return { error: 'файл не передан' }
  }
  const v = validateUploadFile({ name: file.filename, size: file.data.length })
  if (!v.ok) {
    setResponseStatus(event, 400)
    return { error: v.error }
  }

  // Optional manual target («куда импортировать» chosen by the operator) — a `target` form field
  // carrying JSON {entityTypeId, categoryId?, stageId?}. Untrusted → validated to a safe TargetRef
  // (or dropped) by parseManualTarget; when set it overrides the routing rules for THIS job only.
  const targetPart = form?.find(p => p.name === 'target')
  const manualOverride = targetPart?.data?.length ? parseManualTarget(targetPart.data.toString('utf8')) : null

  const jobId = randomUUID()
  await createJob(member.memberId, jobId, file.filename, query, manualOverride)
  await saveUpload(member.memberId, jobId, file.data, nodeFileIO)
  await enqueueExtract({ memberId: member.memberId, jobId, fileId: file.filename })
  return { jobId, status: 'queued' }
})
