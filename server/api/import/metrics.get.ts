import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { readCounters } from '../../utils/metricsStore'
import { computeSavings } from '~/utils/savings'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'

// GET /api/import/metrics — per-portal counters + a time/money-saved estimate for the
// in-portal dashboard. Frame-token authenticated and member-scoped (a portal only sees
// its own counters — same auth chain as /api/import/status).
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id. The counters payload is NEVER attached to the span.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.import-metrics.get', method: 'GET', op: 'metrics.load', domain: auth?.domain },
    async (span) => {
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
      const counters = await readCounters(member.memberId, query)
      return { counters, savings: computeSavings(counters) }
    }
  )
})
