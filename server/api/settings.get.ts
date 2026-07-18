import { makeBareTokenSdkCall } from '../utils/b24Sdk'
import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { readMapping } from '../utils/appSettings'
import { query } from '../db/client'

// GET /api/settings — return the portal mapping + the caller's ADMIN flag (frame-token
// authenticated, verified via resolveFrameMember). Reading is allowed for any portal user (the
// token is portal-scoped, no credentials in the mapping), but the `admin` flag lets the client show
// a read-only notice for non-admins — WRITES are enforced admin-only server-side (settings.post).
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
  const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
  try {
    return { mapping: await readMapping(call), admin: resolved.admin === true }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'settings read failed' }
  }
})
