import { OP_COOKIE, operatorAllowed } from '../../../utils/operatorSession'
import { reauthPortal } from '../../../utils/portalReauth'
import { handleTokenRefresh } from '../../../utils/tokenRefreshHandler'
import { query } from '../../../db/client'

// POST /api/ops/tokens/refresh { memberId } — force-refresh one portal's OAuth token from the
// owner /queues page (#132), replacing the SSH dev-script. Operator SESSION cookie (same as the
// other /api/ops/* routes). Refresh runs under the per-portal advisory lock (#35), persists
// UPDATE-only, and returns a NON-SECRET outcome — the token never leaves the server.
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const body = await readBody(event).catch(() => ({})) as { memberId?: unknown }
  const clientId = process.env.B24_CLIENT_ID ?? ''
  const clientSecret = process.env.B24_CLIENT_SECRET ?? ''
  const res = await handleTokenRefresh(body?.memberId, {
    configured: !!(clientId && clientSecret),
    reauth: memberId => reauthPortal(memberId, {
      query,
      fetchFn: globalThis.fetch as never,
      encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
      clientId,
      clientSecret,
      now: () => Date.now()
    })
  })
  setResponseStatus(event, res.status)
  return res.body
})
