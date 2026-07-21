import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { getJob } from '../../utils/jobStore'
import { jobRedis } from '../../utils/jobStoreRedis'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'

// GET /api/import/status?ids=a,b,c — status of the SPECIFIC jobs the caller asks about (the client
// keeps its own job list in localStorage and polls by id). Frame-token authenticated + member-scoped
// (getJob only reads this portal's jobs). No server-side per-portal list — nothing accumulates.
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id. Job ids / file names / results are NEVER attached to the span.

const JOB_ID_RE = /^[A-Za-z0-9-]{1,64}$/
const MAX_IDS = 50

export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.import-status.get', method: 'GET', op: 'import-status.load', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const member = await resolveFrameMember(auth, { query })
      if (!member.ok || !member.memberId) {
        span.outcome = 'auth_failed'
        console.warn(`[import/status] auth fail: reason=${member.reason} domain=${auth.domain} status=${member.status}`)
        setResponseStatus(event, member.status ?? 401)
        return { error: 'authorization failed', reason: member.reason }
      }
      const idsParamRaw = getQuery(event).ids
      const ids = (typeof idsParamRaw === 'string' ? idsParamRaw.split(',') : [])
        .map(s => s.trim())
        .filter(s => JOB_ID_RE.test(s))
        .slice(0, MAX_IDS)
      // Read the requested jobs in PARALLEL (independent Redis reads); drop the ones already expired.
      const memberId = member.memberId
      const resolved = await Promise.all(ids.map(jobId => getJob(memberId, jobId, jobRedis)))
      const jobs = resolved
        .filter((j): j is NonNullable<typeof j> => j !== null)
        .map(j => ({ jobId: j.jobId, status: j.status, fileName: j.fileName, result: j.result }))
      return { jobs }
    }
  )
})
