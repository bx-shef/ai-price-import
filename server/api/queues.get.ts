import { getQueue } from '../queue/connection'
import { readQueueCounts } from '../queue/stats'
import type { QueueName } from '../queue/topology'
import { opsTokenOk } from '../utils/operatorSession'

// GET /api/queues — pipeline queue depths for the ops console. Guarded by the app
// token via the X-Check-Token HEADER (never a query param → not in access logs);
// nginx should `deny all` externally. Not the operator-session path (/api/ops/queues).
export default defineEventHandler(async (event) => {
  // process.env (bare name), NOT useRuntimeConfig — Nuxt only maps NUXT_-prefixed vars,
  // so cfg.b24ApplicationToken is always '' at runtime and the token check would 403
  // even when B24_APPLICATION_TOKEN is set. Matches envCheck / events.post.ts.
  const expectedToken = process.env.B24_APPLICATION_TOKEN ?? ''
  if (!opsTokenOk(expectedToken, String(getHeader(event, 'x-check-token') || ''))) {
    setResponseStatus(event, 403)
    return { error: 'forbidden' }
  }
  const counts = await readQueueCounts(async (name: QueueName) => {
    const q = getQueue(name)
    return q ? (await q.getJobCounts()) as Record<string, number> : {}
  })
  return { queues: counts }
})
