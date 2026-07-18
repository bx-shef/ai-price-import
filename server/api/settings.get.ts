import { makeBareTokenSdkCall } from '../utils/b24Sdk'
import { extractFrameAuth } from '../utils/frameAuth'
import { verifyFrameToken } from '../utils/resolveFrameMember'
import { readMapping } from '../utils/appSettings'

// GET /api/settings — return the portal mapping + the caller's ADMIN flag (frame-token
// authenticated, verified via verifyFrameToken — token-only, no install/member_id dependency, since
// app.option is scoped by the frame token). Reading is allowed for any portal user (the token is
// portal-scoped, no credentials in the mapping); the `admin` flag lets the client render read-only
// for non-admins — WRITES are enforced admin-only server-side (settings.post).
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const verified = await verifyFrameToken(auth)
  if (!verified.ok) {
    setResponseStatus(event, verified.status ?? 401)
    return { error: 'frame verification failed' }
  }
  const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
  try {
    return { mapping: await readMapping(call), admin: verified.admin === true }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'settings read failed' }
  }
})
