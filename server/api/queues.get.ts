import { getQueue } from '../queue/connection'
import { readQueueCounts } from '../queue/stats'
import type { QueueName } from '../queue/topology'
import { opsTokenOk } from '../utils/operatorSession'

// GET /api/queues — pipeline queue depths for the ops console. Guarded by the app
// token via the X-Check-Token HEADER (never a query param → not in access logs);
// nginx should `deny all` externally. Not the operator-session path (/api/ops/queues).
export default defineEventHandler(async (event) => {
  // process.env (bare name), NOT useRuntimeConfig — Nuxt only maps NUXT_-prefixed vars, so a
  // cfg lookup would always see '' at runtime and 403 even with the token set.
  // ⚠ СВОЯ переменная, а не `B24_APPLICATION_TOKEN`, которой этот роут пользовался раньше: у той
  // переменной есть второй, несвязанный смысл в установке приложения, и заполнив её ради этой
  // служебной страницы, админ ломал бы установку клиентам. Один секрет с двумя смыслами — это не
  // экономия, а ловушка: правильное действие в одном месте оказывается разрушительным в другом.
  // Пусто ⇒ роут закрыт полностью (`opsTokenOk` fail-closed) — это и есть рабочее состояние,
  // человеческий путь в служебную зону идёт через сессию оператора (`/api/ops/queues`).
  const expectedToken = process.env.OPS_CHECK_TOKEN ?? ''
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
