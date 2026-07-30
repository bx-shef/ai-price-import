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
  // Объём обработки рядом с глубиной очередей (#271-C). Счётчики BullMQ показывают лишь то, что ещё
  // хранится (потолок removeOnComplete/removeOnFail), и читались как «обработано за всё время».
  // Настоящее число — в наших счётчиках.
  //
  // Отказ базы НЕ роняет ответ (консоль должна открыться и показать очереди), но и не притворяется
  // пустотой: отдаём признак `totalsFailed`, иначе «база недоступна» на экране неотличимо от «ещё
  // ничего не обработано» — ровно та немота, которую чинили в #271-E.
  let totals: Record<string, number> | null = null
  let totalsFailed = false
  try {
    totals = await readTotals(query)
  } catch {
    totalsFailed = true
  }
  return { queues: counts, totals, totalsFailed }
})
