import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { listRatingStatus } from '../../utils/appRatingStore'
import { buildRatingStatuses } from '../../utils/appRatingStatus'
import { query } from '../../db/client'

// GET /api/ops/app-rating — per-portal «оцените приложение» state for the owner /queues page, so the
// owner MANAGES the review lifecycle from the UI instead of running SQL. Operator SESSION cookie
// (same as the other /api/ops/* routes). Returns NON-SECRET fields only (domain + timestamps).
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  try {
    const rows = await listRatingStatus(query)
    return { portals: buildRatingStatuses(rows) }
  } catch {
    setResponseStatus(event, 502)
    return { error: 'rating status read failed' }
  }
})
