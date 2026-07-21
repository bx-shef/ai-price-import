import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { resetCounters } from '../../utils/metricsStore'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'

// POST /api/import/metrics-reset — operator's «сбросить метрики» for THIS portal. Frame-token
// authenticated, member-scoped (member_id derived from the verified token, never trusted from the
// client), and ADMIN-gated: resetting a portal's lifetime counters is destructive, so a non-admin
// portal user cannot zero them (403), same posture as the settings write.
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.import-metrics-reset.post', method: 'POST', op: 'metrics.reset', domain: auth?.domain },
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
      if (!member.admin) {
        span.outcome = 'forbidden'
        setResponseStatus(event, 403)
        return { error: 'admin only' }
      }
      await resetCounters(member.memberId, query)
      return { ok: true }
    }
  )
})
