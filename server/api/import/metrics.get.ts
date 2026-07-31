import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { readCounters } from '../../utils/metricsStore'
import { computeSavings, moneyBlocker } from '~/utils/savings'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'
import { makeBareTokenSdkCall } from '../../utils/b24Sdk'
import { readMapping } from '../../utils/appSettings'
import { fetchBaseCurrency } from '../../utils/portalCurrency'
import { resolveSavingsRate } from '../../utils/savingsRate'

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
      // Money side is optional and cosmetic (#270): compute time first, then ask the portal for a
      // rate only if there is anything to price. Memoized per portal — see savingsRate.ts.
      const timeOnly = computeSavings(counters)
      const rate = await resolveSavingsRate(member.memberId, timeOnly.minutesSaved, {
        readRate: async () => (await readMapping(makeBareTokenSdkCall(auth.domain, auth.accessToken))).savings?.ratePerHour ?? null,
        readCurrency: () => fetchBaseCurrency(makeBareTokenSdkCall(auth.domain, auth.accessToken))
      })
      const savings = rate.ratePerHour ? computeSavings(counters, rate) : timeOnly
      // Tell the dashboard WHY there is no money figure. Without it, «ставку задал, плитки нет» is
      // indistinguishable from «в портале нет базовой валюты» — the dashboard just shows nothing.
      return { counters, savings, moneyBlocker: moneyBlocker(savings, rate) }
    }
  )
})
