import { getQueue } from '../../queue/connection'
import { MAX_FAILED_PER_QUEUE, readFailedJobs } from '../../queue/failedJobs'
import type { QueueName } from '../../queue/topology'
import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'

// GET /api/ops/failed — упавшие задачи с причиной и временем для операторской консоли (#271-B).
// Раньше на экране было только число «ошибки: N», провалиться в которое было нельзя.
// Авторизация — сессия оператора (тот же путь, что у /api/ops/queues).
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const { jobs, unavailable } = await readFailedJobs(async (name: QueueName, limit) => {
    const q = getQueue(name)
    return q ? await q.getFailed(0, limit - 1) : []
  })
  return { jobs, unavailable, perQueueLimit: MAX_FAILED_PER_QUEUE }
})
