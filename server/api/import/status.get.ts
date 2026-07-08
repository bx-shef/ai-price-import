import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { listJobs } from '../../utils/jobStore'
import { query } from '../../db/client'
import type { FetchFn } from '../../utils/b24Rest'

// GET /api/import/status — recent import jobs for the portal (in-portal status view).
// Frame-token authenticated + member-scoped (a portal only sees its own jobs).
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
  const jobs = await listJobs(member.memberId, query)
  return {
    jobs: jobs.map(j => ({ jobId: j.jobId, status: j.status, fileName: j.fileName, result: j.result }))
  }
})
