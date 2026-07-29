import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { makePortalSdkCall, sdkPortalDeps } from '../utils/b24Sdk'
import { fetchSmartProcessTypes, probeSmartInvoiceEnabled } from '../utils/typeLookup'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query } from '../db/client'

// GET /api/crm-types → { types: SmartProcessType[] } — the portal's smart processes (СПА) as a NAMED list
// (entityTypeId + title + hasCategories/hasStages) so the settings/import target picker can offer them by
// name instead of a raw entityTypeId. Frame-token auth (Bearer + X-B24-Domain), VERIFIED
// (resolveFrameMember). NOT admin-gated: the import staging picker is used by regular employees too, and
// the SPA list is non-sensitive portal metadata. Read-only, no storage.
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed portal
// id. The type list is NOT attached to the span.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.crm-types.get', method: 'GET', op: 'crm-types.load', domain: auth?.domain },
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
      // fetchSmartProcessTypes never throws (→ [] on any issue). The smart-invoice probe answers
      // «is this fixed type available here» — null (inconclusive) keeps the option visible (#269).
      const [types, smartInvoice] = await Promise.all([
        fetchSmartProcessTypes(transport.call),
        probeSmartInvoiceEnabled(transport.call)
      ])
      return { types, smartInvoice: smartInvoice !== false }
    }
  )
})
