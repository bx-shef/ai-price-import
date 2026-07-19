import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { markOpened, markPrompted } from '../utils/appRatingStore'
import { query, dbEnabled } from '../db/client'

// POST /api/app-rating — record a rating-prompt lifecycle event for this portal.
//   { action: 'prompted' } — the modal was shown (throttle for RATING_REPROMPT_DAYS).
//   { action: 'opened' }   — the user clicked «Оценить» → we opened the Market page. Suppresses the
//                            modal until an owner manually verifies whether a review appeared.
// Frame-token authenticated (member_id from the verified domain). Non-fatal: a failed state write
// must never break the UX, so the client ignores errors — but we still return a status for clarity.
export default defineEventHandler(async (event) => {
  if (!dbEnabled()) {
    setResponseStatus(event, 503)
    return { error: 'db disabled' }
  }
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const member = await resolveFrameMember(auth, { query })
  if (!member.ok || !member.memberId) {
    setResponseStatus(event, member.status ?? 401)
    return { error: 'authorization failed', reason: member.reason }
  }

  const body = await readBody(event).catch(() => null) as { action?: unknown } | null
  const action = body?.action
  if (action === 'prompted') {
    await markPrompted(member.memberId, query)
    return { ok: true }
  }
  if (action === 'opened') {
    await markOpened(member.memberId, query)
    return { ok: true }
  }
  setResponseStatus(event, 400)
  return { error: 'unknown action' }
})
