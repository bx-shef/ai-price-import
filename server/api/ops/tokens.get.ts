import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { listPortalStatus } from '../../utils/tokenStore'
import { buildPortalStatuses } from '../../utils/portalStatus'
import { query } from '../../db/client'

// GET /api/ops/tokens — installed-portal authorization status for the owner /queues page (#132),
// a no-SSH replacement for reading token health off the server. Authenticated by the OPERATOR
// SESSION cookie (same as /api/ops/queues). Returns NON-SECRET fields only — domain / member_id /
// refresh-token expiry health — and never a token (listPortalStatus excludes the token columns).
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  try {
    const rows = await listPortalStatus(query)
    return { portals: buildPortalStatuses(rows, Date.now()) }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'portal status read failed' }
  }
})
