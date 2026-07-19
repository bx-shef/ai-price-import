import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { handleAppRatingOp } from '../../utils/appRatingOpsHandler'
import { clearOpened, markReviewed } from '../../utils/appRatingStore'
import { query } from '../../db/client'

// POST /api/ops/app-rating { memberId, action } — owner control of the review lifecycle from the
// /queues page (manage, not SQL). Operator SESSION cookie. Actions:
//   'reviewed' → mark a confirmed Market review (terminal, stops prompting);
//   'reset'    → clear opened/prompted so the modal returns (no review appeared after verification).
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const body = await readBody(event).catch(() => ({})) as { memberId?: unknown, action?: unknown }
  const res = await handleAppRatingOp(body?.memberId, body?.action, {
    markReviewed: id => markReviewed(id, query),
    reset: id => clearOpened(id, query)
  })
  setResponseStatus(event, res.status)
  return res.body
})
