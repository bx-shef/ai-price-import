import { makeBareTokenSdkCall } from '../utils/b24Sdk'
import { extractFrameAuth } from '../utils/frameAuth'
import { readMapping } from '../utils/appSettings'

// GET /api/settings — return the portal mapping (frame-token authenticated).
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
  try {
    return { mapping: await readMapping(call) }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'settings read failed' }
  }
})
