import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { resetCounters } from '../../utils/metricsStore'
import { handleMetricsReset } from '../../utils/metricsResetHandler'
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
      // Решение — в чистой функции с внедрёнными эффектами (#411): текстовый гард по исходнику
      // пропускал и инверсию условия, и потерянный `return`, а оба полностью снимают защиту.
      const member = auth ? await resolveFrameMember(auth, { query }) : null
      const result = await handleMetricsReset({
        member,
        reset: memberId => resetCounters(memberId, query)
      })
      span.outcome = result.outcome
      if (result.status !== 200) setResponseStatus(event, result.status)
      return result.body
    }
  )
})
