import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { readCounters } from '../../utils/metricsStore'
import { computeSavings } from '~/utils/savings'
import { query } from '../../db/client'

// GET /api/import/metrics — per-portal counters + a time/money-saved estimate for the
// in-portal dashboard. Frame-token authenticated and member-scoped (a portal only sees
// its own counters — same auth chain as /api/import/status).
export default defineEventHandler(async (event) => {
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
  const counters = await readCounters(member.memberId, query)
  return { counters, savings: computeSavings(counters) }
})
