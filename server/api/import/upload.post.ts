import { randomUUID } from 'node:crypto'
import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { validateUploadFile } from '~/utils/importUpload'
import { createJob } from '../../utils/jobStore'
import { saveUpload } from '../../utils/fileStore'
import { nodeFileIO } from '../../utils/nodeFileIO'
import { enqueueExtract } from '../../queue/producers'
import { query } from '../../db/client'
import type { FetchFn } from '../../utils/b24Rest'

// POST /api/import/upload — in-portal document upload. Frame-token authenticated and
// bound to a verified portal member_id (no client-trusted id → no cross-portal
// injection). Stores the file, creates a job, enqueues file-extract. docs/redesign 02 §4.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const member = await resolveFrameMember(auth, { fetchFn: globalThis.fetch as unknown as FetchFn, query })
  if (!member.ok || !member.memberId) {
    setResponseStatus(event, member.status ?? 401)
    return { error: 'authorization failed' }
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

  const jobId = randomUUID()
  await createJob(member.memberId, jobId, file.filename, query)
  await saveUpload(member.memberId, jobId, file.data, nodeFileIO)
  await enqueueExtract({ memberId: member.memberId, jobId, fileId: file.filename })
  return { jobId, status: 'queued' }
})
