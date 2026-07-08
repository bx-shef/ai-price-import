import { makeRestCall } from '../utils/b24Rest'
import { extractFrameAuth } from '../utils/frameAuth'
import { writeMapping } from '../utils/appSettings'

// POST /api/settings — persist the portal mapping (frame-token authenticated).
// Admin gate is enforced client-side + by B24 token scope; normalise before write.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const body = await readBody(event)
  const mapping = body?.mapping ?? body
  // Fail-closed: an empty/invalid body must NOT silently reset the mapping to defaults.
  if (!mapping || typeof mapping !== 'object') {
    setResponseStatus(event, 400)
    return { error: 'mapping required' }
  }
  const call = makeRestCall(auth.domain, auth.accessToken, globalThis.fetch as never)
  try {
    return { mapping: await writeMapping(call, mapping) }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'settings save failed' }
  }
})
