import { getQueue } from '../../queue/connection'
import { readQueueCounts } from '../../queue/stats'
import type { QueueName } from '../../queue/topology'
import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { readTotals } from '../../utils/metricsStore'
import { query } from '../../db/client'

// GET /api/ops/queues — pipeline queue depths for the operator /queues page.
// Authenticated by the OPERATOR SESSION cookie (the browser path; the app-token
// header path is /api/queues, for consoles/scripts).
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const counts = await readQueueCounts(async (name: QueueName) => {
    const q = getQueue(name)
    return q ? (await q.getJobCounts()) as Record<string, number> : {}
  })
  // Накопительный итог рядом с глубиной очередей (#271-C). Счётчики BullMQ показывают лишь то, что
  // ещё хранится (потолок removeOnComplete/removeOnFail), и читались как «обработано за всё время».
  // Настоящий итог — в наших счётчиках. Best-effort: без базы консоль всё равно должна открыться и
  // показать очереди, поэтому отказ здесь не роняет ответ.
  let totals: Record<string, number> | null
  try {
    totals = await readTotals(query)
  } catch {
    totals = null
  }
  return { queues: counts, totals }
})
