import { checkCredentials, resolveAuthConfig, signSession } from '../../utils/session'
import { OP_COOKIE, OP_MAX_AGE_S } from '../../utils/operatorSession'

// POST /api/auth/login — operator sign-in. Empty password ⇒ disabled (503).
// Brute-force defense: a per-failure delay here (app-layer backstop) PLUS edge
// rate-limiting required in prod (nginx limit_req) — see docs/AUTH.md.
const FAILURE_DELAY_MS = 400

export default defineEventHandler(async (event) => {
  const cfg = resolveAuthConfig(process.env)
  if (!cfg.password || !cfg.secret) {
    setResponseStatus(event, 503)
    return { error: 'вход оператора отключён' }
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
