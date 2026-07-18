import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { resetCounters } from '../../utils/metricsStore'
import { query } from '../../db/client'

// POST /api/import/metrics-reset — operator's «сбросить метрики» for THIS portal. Frame-token
// authenticated, member-scoped (member_id derived from the verified token, never trusted from the
// client), and ADMIN-gated: resetting a portal's lifetime counters is destructive, so a non-admin
// portal user cannot zero them (403), same posture as the settings write.
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
  if (!member.admin) {
    setResponseStatus(event, 403)
    return { error: 'admin only' }
  }
  await resetCounters(member.memberId, query)
  return { ok: true }
})
