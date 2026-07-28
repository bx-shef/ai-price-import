import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { makePortalSdkCall, sdkPortalDeps } from '../utils/b24Sdk'
import { fetchCrmMode, leadsEnabled } from '../utils/crmMode'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query } from '../db/client'

// GET /api/crm-mode → { leadsEnabled } — whether the portal runs the CLASSIC CRM (with leads) or the
// SIMPLE CRM (without leads). Lets the settings/import UI HIDE the «Лид» target option on a no-leads
// portal (a lead there is auto-converted at once). Frame-token auth (Bearer + X-B24-Domain), VERIFIED
// (resolveFrameMember). NOT admin-gated: the import staging picker is used by regular employees too, and
// the mode is non-sensitive portal metadata. Read-only, no storage.
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed portal
// id. The mode value is NOT attached to the span.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.crm-mode.get', method: 'GET', op: 'crm-mode.load', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const resolved = await resolveFrameMember(auth, { query })
      if (!resolved.ok || !resolved.memberId) {
        span.outcome = 'auth_failed'
        setResponseStatus(event, resolved.status ?? 401)
        return { error: 'frame verification failed' }
      }
      const transport = await makePortalSdkCall(resolved.memberId, sdkPortalDeps({
        query,
        clientId: process.env.B24_CLIENT_ID ?? '',
        clientSecret: process.env.B24_CLIENT_SECRET ?? '',
        encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
        now: () => Date.now()
      }))
      if (!transport) {
        span.outcome = 'conflict'
        setResponseStatus(event, 409)
        return { error: 'portal not authorised (no token)' }
      }
      // fetchCrmMode never throws (→ null on any issue); leadsEnabled fail-open (null → true) so a
      // transient read failure keeps the lead option available rather than hiding it wrongly.
      return { leadsEnabled: leadsEnabled(await fetchCrmMode(transport.call)) }
    }
  )
})
