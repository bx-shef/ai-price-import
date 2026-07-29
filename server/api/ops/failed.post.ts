import { getQueue } from '../../queue/connection'
import { decideFailedAction } from '../../queue/failedJobs'
import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'

// POST /api/ops/failed {queue, id, action} — «повторить» или «отбросить» упавшую задачу (#271-B).
// Оператор видел число ошибок, но сделать с ними ничего не мог.
//
// Имя очереди приходит из браузера, поэтому сверяется со списком очередей конвейера: по нему нельзя
// дотянуться до постороннего ключа в Redis. Авторизация — сессия оператора.
export default defineEventHandler(async (event) => {
  const authorized = operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())
  const body = await readBody<unknown>(event).catch(() => null)
  // Всё решение (авторизация + проверка очереди, идентификатора и действия) — в чистой функции,
  // чтобы тестами проверялась именно проводка, а не валидаторы по отдельности.
  const decision = decideFailedAction(authorized, body)
  if (decision.status !== 200) {
    setResponseStatus(event, decision.status)
    return { error: decision.status === 401 ? 'unauthorized' : 'bad request' }
  }
  const q = getQueue(decision.queue)
  if (!q) {
    setResponseStatus(event, 503)
    return { error: 'queue unavailable' }
  }
  const job = await q.getJob(decision.id)
  // Задачи уже нет — например, её успел разобрать другой оператор или вымело хранение. Это не
  // ошибка запроса: сообщаем как есть, чтобы список просто обновился.
  if (!job) return { ok: false, reason: 'gone' }
  if (decision.action === 'retry') await job.retry()
  else await job.remove()
  return { ok: true }
})
