import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { readCounters } from '../../utils/metricsStore'
import { computeSavings } from '~/utils/savings'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'
import { makeBareTokenSdkCall } from '../../utils/b24Sdk'
import { readMapping } from '../../utils/appSettings'
import { fetchBaseCurrency } from '../../utils/portalCurrency'
import type { FrameAuth } from '../../utils/frameAuth'
import type { SavingsRate } from '~/utils/savings'

/**
 * Hourly rate + currency for the money estimate (#270). Both come from the portal: the rate from
 * its own settings, the currency from `crm.currency.list` (BASE) — never from a constant, because
 * one deployment serves BY/RU/KZ portals.
 *
 * Fail-open to «time only»: if settings or the currency can't be read, we return an empty rate and
 * the dashboard drops the money block. Showing time without money is a smaller lie than showing an
 * amount in a currency we guessed — and the counters themselves must not fail over a cosmetic add-on.
 * The currency call is skipped entirely when no rate is configured (the common case).
 */
async function resolveSavingsRate(auth: FrameAuth): Promise<SavingsRate> {
  try {
    const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
    const ratePerHour = (await readMapping(call)).savings?.ratePerHour ?? null
    if (!ratePerHour) return {}
    return { ratePerHour, currency: await fetchBaseCurrency(call) }
  } catch {
    return {}
  }
}

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
      return { counters, savings: computeSavings(counters, await resolveSavingsRate(auth)) }
    }
  )
})
