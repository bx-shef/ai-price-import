import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { makePortalSdkCall, sdkPortalDeps } from '../utils/b24Sdk'
import { fetchCrmStages } from '../utils/stageLookup'
import { query } from '../db/client'

// GET /api/crm-stages?entityTypeId=N&categoryId=M — list the portal's stages (стадии) for a target
// entity type + direction, so the settings/import UI can offer a stage picker. Auth mirrors
// crm-categories/catalog-properties: frame token (Authorization: Bearer + X-B24-Domain), VERIFIED
// (resolveFrameMember → member_id), admin-gated, read over the portal's OAuth token. Read-only,
// no storage. categoryId is optional (lead / deal default funnel don't need one).
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const resolved = await resolveFrameMember(auth, { query })
  if (!resolved.ok || !resolved.memberId) {
    setResponseStatus(event, resolved.status ?? 401)
    return { error: 'frame verification failed' }
  }
  if (!resolved.admin) {
    setResponseStatus(event, 403)
    return { error: 'admin only' }
  }
  const entityTypeId = Number(getQuery(event).entityTypeId)
  if (!Number.isInteger(entityTypeId) || entityTypeId <= 0) {
    setResponseStatus(event, 400)
    return { error: 'entityTypeId required (positive integer)' }
  }
  // categoryId is optional; a non-integer/absent one becomes null (lead / deal default funnel).
  const rawCat = getQuery(event).categoryId
  const catNum = Number(rawCat)
  const categoryId = rawCat != null && rawCat !== '' && Number.isInteger(catNum) && catNum >= 0 ? catNum : null

  const transport = await makePortalSdkCall(resolved.memberId, sdkPortalDeps({
    query,
    clientId: process.env.B24_CLIENT_ID ?? '',
    clientSecret: process.env.B24_CLIENT_SECRET ?? '',
    encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
    now: () => Date.now()
  }))
  if (!transport) {
    setResponseStatus(event, 409)
    return { error: 'portal not authorised (no token)' }
  }
  // fetchCrmstages never throws (→ [] on any issue), so an empty list just means "no stages to pick".
  return { stages: await fetchCrmStages(entityTypeId, categoryId, transport.call) }
})
