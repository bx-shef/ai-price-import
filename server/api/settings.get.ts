import { makeBareTokenSdkCall } from '../utils/b24Sdk'
import { extractFrameAuth } from '../utils/frameAuth'
import { verifyFrameToken } from '../utils/resolveFrameMember'
import { readMapping } from '../utils/appSettings'
import { fetchBaseCurrency } from '../utils/portalCurrency'
import { withSpan } from '../utils/telemetrySpan'
import { portalHash } from '../utils/telemetryAttributes'

// GET /api/settings — return the portal mapping + the caller's ADMIN flag (frame-token
// authenticated, verified via verifyFrameToken — token-only, no install/member_id dependency, since
// app.option is scoped by the frame token). Reading is allowed for any portal user (the token is
// portal-scoped, no credentials in the mapping); the `admin` flag lets the client render read-only
// for non-admins — WRITES are enforced admin-only server-side (settings.post).
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id, no request body/business content. Zero overhead when telemetry is off.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  let outcome = 'ok'
  return withSpan(
    'http.settings.get',
    { 'http.method': 'GET', 'http.op': 'settings.load' },
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
      const call = makeBareTokenSdkCall(auth.domain, auth.accessToken)
      try {
        const mapping = await readMapping(call)
        // Base currency is shown NEXT TO the hourly rate, and its absence is the whole reason the
        // «Сэкономлено денег» tile can silently never appear (computeSavings drops the money figure
        // without a currency). Fail-open: a failed currency read must not turn a settings page into
        // a 502 — `null` renders the same warning as «портал не завёл базовую валюту», which is the
        // action the admin needs either way.
        let baseCurrency: string | null = null
        try {
          baseCurrency = await fetchBaseCurrency(call)
        } catch {
          baseCurrency = null
        }
        return { mapping, admin: verified.admin === true, baseCurrency }
      } catch {
        outcome = 'upstream_error'
        setResponseStatus(event, 502)
        return { error: 'settings read failed' }
      }
    },
    // portal.hash computed here (finalize runs ONLY when the span records) → zero cost when off.
    () => ({ 'http.outcome': outcome, 'portal.hash': portalHash(auth?.domain) })
  )
})
