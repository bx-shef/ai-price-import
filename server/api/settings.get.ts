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
  // Reported as its own span attribute: a portal-wide breakage of the currency read leaves
  // `http.outcome` green (the settings load itself succeeded), so it would be invisible otherwise.
  let currencyFailed = false
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
        // Base currency is shown NEXT TO the hourly rate, and its absence is the whole reason the
        // «Сэкономлено денег» tile can silently never appear (computeSavings drops the money figure
        // without a currency). Read in PARALLEL with the mapping — sequential would double the
        // latency of the settings page for every user, admin or not.
        //
        // A FAILED read is reported apart from «валюты нет» (`currencyUnknown`). Fail-open is right —
        // a currency read must not turn the settings page into a 502 — but collapsing the two states
        // would have the page assert «в портале нет базовой валюты» on a timeout and send the admin
        // to create a currency that already exists.
        const [mapping, currency] = await Promise.all([
          readMapping(call),
          fetchBaseCurrency(call).then(c => ({ code: c, failed: false })).catch(() => ({ code: null, failed: true }))
        ])
        currencyFailed = currency.failed
        return { mapping, admin: verified.admin === true, baseCurrency: currency.code, currencyUnknown: currency.failed }
      } catch {
        outcome = 'upstream_error'
        setResponseStatus(event, 502)
        return { error: 'settings read failed' }
      }
    },
    // portal.hash computed here (finalize runs ONLY when the span records) → zero cost when off.
    () => ({ 'http.outcome': outcome, 'http.currency_read': currencyFailed ? 'failed' : 'ok', 'portal.hash': portalHash(auth?.domain) })
  )
})
