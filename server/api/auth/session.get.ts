import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { resolveAuthConfig } from '../../utils/session'

// GET /api/auth/session — is the caller a signed-in operator, and is sign-in enabled.
export default defineEventHandler((event) => {
  const enabled = !!resolveAuthConfig(process.env).password
  const authenticated = operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())
  return { authenticated, enabled }
})
