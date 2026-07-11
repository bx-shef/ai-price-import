import { makeRestCall } from '../utils/b24Rest'
import { extractFrameAuth } from '../utils/frameAuth'
import { searchCatalogProperties } from '../utils/catalogPropertySearch'

// GET /api/catalog-properties?q=<phrase> — search the CALLER'S catalog product
// properties for the supplier-article picker (P7). Auth = the Bitrix24 frame access
// token (Authorization: Bearer) + portal domain (X-B24-Domain), same model as
// /api/settings: B24 scopes that token to the caller's portal, so there's no
// member_id to trust and no cross-portal reach. Read-only (list only), no storage.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const q = typeof getQuery(event).q === 'string' ? getQuery(event).q as string : ''
  const call = makeRestCall(auth.domain, auth.accessToken, globalThis.fetch as never)
  try {
    return await searchCatalogProperties(call, q)
  } catch {
    setResponseStatus(event, 502)
    return { error: 'catalog properties read failed' }
  }
})
