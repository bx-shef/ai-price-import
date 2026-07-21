import { makeBareTokenSdkCall } from '../utils/b24Sdk'
import { extractFrameAuth } from '../utils/frameAuth'
import { verifyFrameToken } from '../utils/resolveFrameMember'
import { writeMapping } from '../utils/appSettings'
import { withSpan } from '../utils/telemetrySpan'
import { portalHash } from '../utils/telemetryAttributes'

// POST /api/settings — persist the portal mapping. Frame-token authenticated AND admin-gated
// SERVER-SIDE: verifyFrameToken confirms the frame token controls the portal and reads the caller's
// ADMIN flag from `profile` (the token is the calling user's), so a non-admin portal user cannot
// overwrite settings even with a valid frame token. It does NOT require the portal be installed
// (member_id) — app.option is scoped by the frame token alone — so an install-race/purge window
// doesn't reject a valid admin. Body normalised before write.
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome (incl. the
// admin-gate `forbidden`) + hashed portal id. The mapping body is NEVER attached to the span.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  let outcome = 'ok'
  return withSpan(
    'http.settings.post',
    { 'http.method': 'POST', 'http.op': 'settings.save' },
    async () => {
      if (!auth) {
        outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const verified = await verifyFrameToken(auth)
      if (!verified.ok) {
        outcome = 'auth_failed'
        setResponseStatus(event, verified.status ?? 401)
        return { error: 'frame verification failed' }
      }
      if (!verified.admin) {
        outcome = 'forbidden'
        setResponseStatus(event, 403)
        return { error: 'admin only' }
      }
      const body = await readBody(event)
      const mapping = body?.mapping ?? body
      // Fail-closed: an empty/invalid body must NOT silently reset the mapping to defaults.
      if (!mapping || typeof mapping !== 'object') {
        outcome = 'bad_request'
        setResponseStatus(event, 400)
        return { error: 'mapping required' }
      }
      const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
      try {
        return { mapping: await writeMapping(call, mapping) }
      } catch {
        outcome = 'upstream_error'
        setResponseStatus(event, 502)
        return { error: 'settings save failed' }
      }
    },
    // portal.hash computed here (finalize runs ONLY when the span records) → zero cost when off.
    () => ({ 'http.outcome': outcome, 'portal.hash': portalHash(auth?.domain) })
  )
})
