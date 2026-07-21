import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { makePortalSdkCall, sdkPortalDeps } from '../utils/b24Sdk'
import { fetchCrmCategories } from '../utils/categoryLookup'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query } from '../db/client'

// GET /api/crm-categories?entityTypeId=N — list the portal's CRM categories (воронки/направления)
// for a target entity type, so the settings routing UI can offer a direction picker
// («тип документа → сущность + направление»). Auth mirrors the catalog-properties picker: the
// Bitrix24 frame access token (Authorization: Bearer) + portal domain (X-B24-Domain), VERIFIED
// (resolveFrameMember → cheap profile call) → member_id, then read over the portal's stored OAuth
// token (SDK transport). member_id derives from the VERIFIED domain (not client-supplied) →
// same-portal only. ADMIN-gated (settings form is admin-only). Read-only, no storage. The payload
// is non-sensitive funnel metadata (ids/names an in-portal user already sees in CRM settings).
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id. The funnel payload is NEVER attached to the span.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.crm-categories.get', method: 'GET', op: 'crm-categories.load', domain: auth?.domain },
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
      if (!resolved.admin) {
        span.outcome = 'forbidden'
        setResponseStatus(event, 403)
        return { error: 'admin only' }
      }
      const entityTypeId = Number(getQuery(event).entityTypeId)
      if (!Number.isInteger(entityTypeId) || entityTypeId <= 0) {
        span.outcome = 'bad_request'
        setResponseStatus(event, 400)
        return { error: 'entityTypeId required (positive integer)' }
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
      // fetchCrmCategories never throws (lead / transient → []), so an empty list just means
      // "no direction to pick" — the UI handles that. No try/catch needed.
      return { categories: await fetchCrmCategories(entityTypeId, transport.call) }
    }
  )
})
