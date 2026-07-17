import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { resetCounters } from '../../utils/metricsStore'
import { query } from '../../db/client'

// POST /api/import/metrics-reset — operator's «сбросить метрики» for THIS portal. Frame-token
// authenticated and member-scoped: only the caller's own counters are cleared (member_id
// is derived from the verified frame token, never trusted from the client).
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
  await resetCounters(member.memberId, query)
  return { ok: true }
})
