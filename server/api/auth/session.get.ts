import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { resolveAuthConfig } from '../../utils/session'

// GET /api/auth/session — is the caller a signed-in operator, and is sign-in enabled.
//
// «Enabled» must match what the login route actually enforces: it needs BOTH the password and the
// session secret (login.post.ts refuses with 503 without either). Reporting only the password left
// a config — password set, secret empty — where the form said «go ahead» and every attempt came back
// refused: exactly the defect the disabled-form work set out to remove (#271-M).
export default defineEventHandler((event) => {
  const cfg = resolveAuthConfig(process.env)
  const enabled = !!cfg.password && !!cfg.secret
  const authenticated = operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())
  return { authenticated, enabled }
})
