import { makeBareTokenSdkCall } from '../utils/b24Sdk'
import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { writeMapping } from '../utils/appSettings'
import { query } from '../db/client'

// POST /api/settings — persist the portal mapping. Frame-token authenticated AND admin-gated
// SERVER-SIDE: resolveFrameMember verifies the frame token controls the portal and reads the
// caller's ADMIN flag from `profile` (the token is the calling user's), so a non-admin portal user
// cannot overwrite settings even with a valid frame token. Body normalised before write.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const resolved = await resolveFrameMember(auth, { query })
  if (!resolved.ok) {
    setResponseStatus(event, resolved.status ?? 401)
    return { error: 'frame verification failed' }
  }
  if (!resolved.admin) {
    setResponseStatus(event, 403)
    return { error: 'admin only' }
  }
  const body = await readBody(event)
  const mapping = body?.mapping ?? body
  // Fail-closed: an empty/invalid body must NOT silently reset the mapping to defaults.
  if (!mapping || typeof mapping !== 'object') {
    setResponseStatus(event, 400)
    return { error: 'mapping required' }
  }
  const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
  try {
    return { mapping: await writeMapping(call, mapping) }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'settings save failed' }
  }
})
