import { checkCredentials, resolveAuthConfig, signSession } from '../../utils/session'
import { OP_COOKIE, OP_MAX_AGE_S } from '../../utils/operatorSession'
import { createRateLimiter } from '../../utils/demoRateLimit'
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, edgeSecurityEnabled, edgeTrustXff, rateLimitKey } from '../../utils/edgeSecurity'

// POST /api/auth/login — operator sign-in. Empty password ⇒ disabled (503).
// Brute-force defense: a per-failure delay here (app-layer backstop) PLUS edge
// rate-limiting. In prod that edge limit is nginx `limit_req`; on the no-nginx
// "black hole" target (APP_EDGE_SECURITY on) we enforce it in-app below — keyed on
// the real TCP peer (socket.remoteAddress), since without a trusted proxy X-Forwarded-For
// is client-spoofable. Behind nginx this app-limiter stays OFF (else it'd bucket every
// client under the shared proxy IP). See docs/AUTH.md.
const FAILURE_DELAY_MS = 400

// Module-scoped so the window persists across requests (single-process best-effort, like demoRateLimit).
const loginLimiter = createRateLimiter(LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS)

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!cfg.password || !cfg.secret) {
    setResponseStatus(event, 503)
    return { error: 'вход оператора отключён' }
  }
  if (edgeSecurityEnabled(process.env)) {
    const ip = rateLimitKey(true, edgeTrustXff(process.env), getHeader(event, 'x-forwarded-for'), event.node.req.socket.remoteAddress)
    const decision = loginLimiter.check(ip, Date.now())
    if (!decision.allowed) {
      setResponseStatus(event, 429)
      setResponseHeader(event, 'Retry-After', Math.ceil(decision.retryAfterMs / 1000))
      return { error: 'слишком много попыток входа, попробуйте позже' }
    }
  }
  const body = await readBody(event)
  const password = String((body as { password?: unknown })?.password ?? '')
  if (!checkCredentials(password, cfg)) {
    await new Promise(resolve => setTimeout(resolve, FAILURE_DELAY_MS)) // slow guessing
    setResponseStatus(event, 401)
    return { error: 'неверный пароль' }
  }
  setCookie(event, OP_COOKIE, signSession(cfg.secret, Date.now()), {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: OP_MAX_AGE_S
  })
  return { ok: true }
})
