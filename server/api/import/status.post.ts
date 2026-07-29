import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { getJob } from '../../utils/jobStore'
import { jobRedis } from '../../utils/jobStoreRedis'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { parseStatusIds } from '../../utils/importStatusIds'
import { bodySizeStatus, edgeSecurityEnabled } from '../../utils/edgeSecurity'
import { query } from '../../db/client'

// POST /api/import/status {ids:[…]} — status of the SPECIFIC jobs the caller asks about (the client
// keeps its own job list in localStorage and polls by id). Frame-token authenticated + member-scoped
// (getJob only reads this portal's jobs). No server-side per-portal list — nothing accumulates.
//
// POST, not GET with ?ids= (#260). Two reasons, both about the id LIST rather than about semantics:
//  • it grew with the history cap — 50 UUIDs ≈ 1.9 KB of query string. That fits today, but the cap is
//    the only thing keeping it under the proxy header buffer, and raising the history to 100-200 (a
//    natural wish) would start returning 414/400 from some proxy, silently and only for active users;
//  • job ids in a URL land in nginx access logs, intermediate proxies and browser history — while our
//    telemetry deliberately never records them. In a request body they stay out of those logs.
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id. Job ids / file names / results are NEVER attached to the span.

/** Plenty for MAX_IDS UUIDs (~2 KB) with room to spare; anything larger is not our client. */
const MAX_STATUS_BODY_BYTES = 16 * 1024

export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.import-status.post', method: 'POST', op: 'import-status.load', domain: auth?.domain },
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
      // Body-size guard: this is the only JSON-reading route without one, and behind nginx the cap is
      // 25 MB (the old query string was bounded by the header buffer). A few KB is plenty for 50 UUIDs.
      const declared = Number(getHeader(event, 'content-length') ?? 0)
      const size = bodySizeStatus(edgeSecurityEnabled(process.env), declared, MAX_STATUS_BODY_BYTES)
      if (size) {
        span.outcome = 'bad_request'
        setResponseStatus(event, size)
        return { error: 'request body too large' }
      }
      const body = await readBody<{ ids?: unknown }>(event).catch(() => null)
      const { ids, requested } = parseStatusIds(body?.ids)
      // Read the requested jobs in PARALLEL (independent Redis reads); drop the ones already expired.
      const memberId = member.memberId
      const resolved = await Promise.all(ids.map(jobId => getJob(memberId, jobId, jobRedis)))
      const jobs = resolved
        .filter((j): j is NonNullable<typeof j> => j !== null)
        .map(j => ({
          jobId: j.jobId,
          status: j.status,
          fileName: j.fileName,
          result: j.result,
          ...(j.diskUrl ? { diskUrl: j.diskUrl } : {}),
          ...(j.targetEntityTypeId ? { targetEntityTypeId: j.targetEntityTypeId } : {})
        }))
      // The cap used to truncate SILENTLY: past it a job simply stopped updating, with no error and no
      // trace anywhere. Report how many were ASKED for, so the client can say it out loud (#260).
      return requested > ids.length ? { jobs, requested, answered: ids.length } : { jobs }
    }
  )
})
