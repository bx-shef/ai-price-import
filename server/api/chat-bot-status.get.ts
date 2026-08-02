import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { getBotId } from '../utils/tokenStore'
import { botIsReady } from '../utils/chatBot'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { dbEnabled, query } from '../db/client'

// GET /api/chat-bot-status → { ready } — does this portal have the app's chat bot (#316/#360)?
//
// Without a bot the app still writes to chats, but as the EMPLOYEE whose token it holds: import
// reports read like a colleague posting about his own uploads, and a failure notice arrives from the
// employee to himself. That degradation used to be visible only in a counter nobody reads, so the
// admin never learned that his portal (free plan, bot limit, rights not granted) is in that state.
//
// Frame-token auth (Bearer + X-B24-Domain), VERIFIED. NOT admin-gated at the route: the value is
// non-sensitive («у портала есть бот» — a boolean), and the UI decides whom to show it to. Reads
// only our own row — NO portal REST call, so the banner costs the portal nothing.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.chat-bot-status.get', method: 'GET', op: 'chat-bot.status', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const resolved = await resolveFrameMember(auth, { query })
      if (!resolved.ok || !resolved.memberId) {
        span.outcome = 'auth_failed'
        setResponseStatus(event, resolved.status ?? 401)
        return { error: 'frame verification failed' }
      }
      // No database → we simply do not know. Fail-open («бот есть») keeps the banner silent: it must
      // never accuse a healthy portal because OUR storage is down.
      if (!dbEnabled()) return { ready: true }
      return { ready: botIsReady(await getBotId(resolved.memberId, query)) }
    }
  )
})
