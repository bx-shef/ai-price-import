import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { handleAppRatingOp } from '../../utils/appRatingOpsHandler'
import { clearOpened, clearReviewed, markReviewed } from '../../utils/appRatingStore'
import { query } from '../../db/client'

// POST /api/ops/app-rating { memberId, action } — owner control of the review lifecycle from the
// /queues page (manage, not SQL). Operator SESSION cookie. Actions:
//   'reviewed' → mark a confirmed Market review (stops prompting; reversible via 'unreview');
//   'reset'    → clear opened/prompted so the modal returns (no review appeared after verification).
//   'unreview' → undo a confirmed review (#318 п.2): a mis-click used to need SQL.
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const body = await readBody(event).catch(() => ({})) as { memberId?: unknown, action?: unknown }
  const res = await handleAppRatingOp(body?.memberId, body?.action, {
    markReviewed: id => markReviewed(id, query),
    reset: id => clearOpened(id, query),
    unreview: id => clearReviewed(id, query)
  })
  setResponseStatus(event, res.status)
  return res.body
})
