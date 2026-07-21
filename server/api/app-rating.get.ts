import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { getRatingState } from '../utils/appRatingStore'
import { shouldPrompt } from '../utils/appRatingPolicy'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query, dbEnabled } from '../db/client'

// GET /api/app-rating — should the in-portal «оцените приложение» modal be shown for this portal?
// Frame-token authenticated (member_id derived from the verified domain — never trusted from the
// client). Side-effect-free: it only READS state; the client stamps prompted_at via POST when the
// modal actually renders. Inert (show:false) outside a portal or without a DB.
//
// Wrapped in a manual OTel span (телеметрия, DEFAULT OFF): latency + a PII-safe outcome + hashed
// portal id. No business content on the span.
export default defineEventHandler(async (event) => {
  if (!dbEnabled()) return { show: false } // no store — nothing to prompt, not worth a span
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.app-rating.get', method: 'GET', op: 'app-rating.load', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth' // not in a portal — no nag, no error
        return { show: false }
      }
      const member = await resolveFrameMember(auth, { query })
      if (!member.ok || !member.memberId) {
        span.outcome = 'auth_failed'
        return { show: false }
      }
      const state = await getRatingState(member.memberId, query)
      return { show: shouldPrompt(state, new Date()) }
    }
  )
})
