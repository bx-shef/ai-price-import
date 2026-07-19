import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { getRatingState } from '../utils/appRatingStore'
import { shouldPrompt } from '../utils/appRatingPolicy'
import { query, dbEnabled } from '../db/client'

// GET /api/app-rating — should the in-portal «оцените приложение» modal be shown for this portal?
// Frame-token authenticated (member_id derived from the verified domain — never trusted from the
// client). Side-effect-free: it only READS state; the client stamps prompted_at via POST when the
// modal actually renders. Inert (show:false) outside a portal or without a DB.
export default defineEventHandler(async (event) => {
  if (!dbEnabled()) return { show: false }
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) return { show: false } // not in a portal — no nag, no error
  const member = await resolveFrameMember(auth, { query })
  if (!member.ok || !member.memberId) return { show: false }
  const state = await getRatingState(member.memberId, query)
  return { show: shouldPrompt(state, new Date()) }
})
