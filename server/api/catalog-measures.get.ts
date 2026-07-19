import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { makePortalSdkCall, sdkPortalDeps } from '../utils/b24Sdk'
import { listMeasures } from '../utils/measureList'
import { query } from '../db/client'

// GET /api/catalog-measures — list the portal's catalog measures for the units-dictionary
// editor (settings form). Auth = the Bitrix24 frame token (Bearer) + portal domain
// (X-B24-Domain), verified + mapped to member_id (anti-spoof), then read via the portal's
// stored OAuth token over the SDK transport. Admin-only (settings is admin-gated). Read-only.
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
  // Server-side ADMIN gate (mirrors the client-side gate in useSettings/settings.vue).
  if (!resolved.admin) {
    setResponseStatus(event, 403)
    return { error: 'admin only' }
  }
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
  try {
    return { items: await listMeasures(transport.call) }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'measure list failed' }
  }
})
