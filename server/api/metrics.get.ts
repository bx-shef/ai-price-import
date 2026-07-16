import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { readCounters } from '../utils/metricsStore'
import { query } from '../db/client'
import { summarizeMetrics } from '~/utils/metricsView'
import type { FetchFn } from '../utils/b24Rest'

// GET /api/metrics — per-portal metric counters for the in-portal view (motivating figures on
// /app + detailed /metrics). Frame-token authenticated + member-scoped: a portal only ever sees
// its OWN counters (member_id from the verified frame token, never from the client).
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  if (!auth) {
    setResponseStatus(event, 401)
    return { error: 'frame auth required' }
  }
  const member = await resolveFrameMember(auth, { fetchFn: globalThis.fetch as unknown as FetchFn, query })
  if (!member.ok || !member.memberId) {
    console.warn(`[metrics] auth fail: reason=${member.reason} domain=${auth.domain} status=${member.status}`)
    setResponseStatus(event, member.status ?? 401)
    return { error: 'authorization failed', reason: member.reason }
  }
  const counters = await readCounters(member.memberId, query)
  return summarizeMetrics(counters)
})
