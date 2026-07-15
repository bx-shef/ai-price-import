import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { makePortalSdkCall, sdkPortalDeps } from '../utils/b24Sdk'
import { searchCatalogProperties } from '../utils/catalogPropertySearch'
import { query } from '../db/client'

// GET /api/catalog-properties?q=<phrase> — search the portal's catalog product
// properties for the supplier-article picker (P7). Auth = the Bitrix24 frame access
// token (Authorization: Bearer) + portal domain (X-B24-Domain). We VERIFY that token
// controls the domain (resolveFrameMember → cheap `profile` call), map it to the
// installed portal's member_id, then read via the portal's stored OAuth token over the
// SDK transport (full-list pagination, same path as crm-sync). Read-only, no storage.
//
// member_id is derived from the VERIFIED domain (not client-supplied) → same-portal only,
// no cross-portal reach. NB: the read uses the portal's app-install OAuth token, so it sees
// catalog metadata regardless of the caller's own CRM rights — acceptable here: the payload
// is non-sensitive schema (property names/codes, visible to anyone browsing the catalog) and
// this endpoint backs the ADMIN-gated settings picker (SettingsForm useIsAdmin). It matches
// the app's server-side-OAuth read model (settings/app.option, crm-sync).
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  // Verify the frame token controls this portal + resolve member_id (anti-spoof).
  const resolved = await resolveFrameMember(auth, { fetchFn: globalThis.fetch as never, query })
  if (!resolved.ok || !resolved.memberId) {
    setResponseStatus(event, resolved.status ?? 401)
    return { error: 'frame verification failed' }
  }
  // Read via the portal's stored OAuth token (SDK transport). Missing token ⇒ the app
  // isn't fully installed for this portal — treat like a failed verification.
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
  const q = typeof getQuery(event).q === 'string' ? getQuery(event).q as string : ''
  try {
    return await searchCatalogProperties(transport, q)
  } catch {
    setResponseStatus(event, 502)
    return { error: 'catalog properties read failed' }
  }
})
