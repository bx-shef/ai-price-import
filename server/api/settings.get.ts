import { makeRestCall } from '../utils/b24Rest'
import { extractFrameAuth } from '../utils/frameAuth'
import { readMapping } from '../utils/appSettings'

// GET /api/settings — return the portal mapping (frame-token authenticated).
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const call = makeRestCall(auth.domain, auth.accessToken, globalThis.fetch as never)
  try {
    return { mapping: await readMapping(call) }
  } catch (err) {
    setResponseStatus(event, 502)
    return { error: (err as Error).message }
  }
})
