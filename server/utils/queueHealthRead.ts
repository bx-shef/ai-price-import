import { QUEUES, type QueueName } from '../queue/topology'
import { FAILURE_WINDOW_MS, type QueueHealthInput } from './queueAlert'

// Reading side of the queue health check. Pure over an injected reader — the live one wraps BullMQ,
// tests use a fake. Kept apart from `queue/stats.ts` on purpose: that one answers an unreachable
// Redis with zeros (the operator page must still render), and here zeros would be a lie that turns
// a total outage into a green screen.

/** Raw shapes we need. Only the fields used — BullMQ's Job carries far more. */
export interface RawPendingJob { timestamp?: number | null }
export interface RawFailedAt {
  finishedOn?: number | null
  processedOn?: number | null
  /** Why it died. Used only to tell OUR breakage from one portal's misconfiguration. */
  failedReason?: string | null
}

/**
 * Portal answers that mean «этот клиент настроил у себя не то», not «сервис сломан».
 *
 * They matter because they are DETERMINISTIC: a deleted smart process or revoked rights produce the
 * same refusal on all three attempts and on every document that portal sends. Counting them would
 * tie the alert to the number of misconfigured tenants — one client with a wrong setting would page
 * us hourly, forever, about something only that client can fix. The person who needs to know
 * already does: they get the failure in their own chat (PROCESS.md §6.8).
 *
 * This is the same principle as the stall rule refusing to depend on portal size: an alert must
 * describe the health of the service, not the shape of its clients.
 */
const PORTAL_SIDE_PATTERNS = [
  // `[\s_]` — Битрикс отдаёт и `ACCESS_DENIED`, и «Access denied».
  /access[\s_]*denied/i,
  /нет\s+прав/i,
  /сущность\s+crm\s+не\s+поддерживается/i,
  /entity\s+.*not\s+supported/i,
  /смарт-процесс\s+не\s+найден/i,
  /портал\s+не\s+авторизован/i
]

/**
 * Does this failure say something about OUR service?
 *
 * Unknown wording counts as ours — fail-open. A refusal we have not seen before is more likely a
 * new way for the service to break than a new way for a client to misconfigure theirs, and a
 * missing alert costs more than an extra one.
 */
export function isServiceFailure(reason: unknown): boolean {
  const r = String(reason ?? '')
  return !PORTAL_SIDE_PATTERNS.some(re => re.test(r))
}

export interface QueueHealthReader {
  /** Unfinished jobs (waiting + active + delayed). Throws when the queue is unreachable. */
  pending: (name: QueueName) => Promise<RawPendingJob[]>
  /** Recently failed jobs, newest first. Throws when the queue is unreachable. */
  failed: (name: QueueName) => Promise<RawFailedAt[]>
}

/**
 * Cap on how many failed rows we look at.
 *
 * Safe only because BullMQ's `getFailed(start, end)` returns rows **newest first**
 * (`getJobs(['failed'], …, asc = false)`), so the cap trims the OLD tail — the rows that are outside
 * the look-back window anyway. Were it ascending, a big outage would fill the cap with ancient
 * failures, the recent ones would never be read, and the count would drop to zero exactly when it
 * matters most.
 *
 * Past the alert threshold the exact number stops mattering: «упало 40» and «упало 400» call for
 * the same action.
 */
export const MAX_FAILED_SCAN = 200

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Age of the oldest job, and how many there are. Jobs without a usable timestamp are counted but
 *  cannot age — better than inventing an age and alerting on it. */
export function summarisePending(jobs: RawPendingJob[], nowMs: number): { pending: number, oldestPendingAgeMs: number | null } {
  let oldest: number | null = null
  for (const j of jobs) {
    const t = num(j?.timestamp)
    if (t === null) continue
    // A clock skew (job stamped in the future) must not read as a huge age.
    const age = Math.max(0, nowMs - t)
    if (oldest === null || age > oldest) oldest = age
  }
  return { pending: jobs.length, oldestPendingAgeMs: oldest }
}

/** How many of these failed inside the window AND say something about our service. Rows with no
 *  timestamp are not counted — an undated failure could be from any time, and guessing «сейчас»
 *  would raise false alarms. Portal-side refusals are excluded, see `isServiceFailure`. */
export function countRecentFailures(jobs: RawFailedAt[], nowMs: number, windowMs = FAILURE_WINDOW_MS): number {
  let n = 0
  for (const j of jobs) {
    const t = num(j?.finishedOn) ?? num(j?.processedOn)
    if (t === null) continue
    if (!(nowMs - t <= windowMs && t <= nowMs)) continue
    if (!isServiceFailure(j?.failedReason)) continue
    n++
  }
  return n
}

/**
 * Сколько ждать чтения ОДНОЙ очереди, прежде чем считать её нечитаемой.
 *
 * ⚠ Это не перестраховка, а починка живого дефекта. Прогон 2026-08-02: остановили Redis, тревога
 * пришла через ~15 минут вместо ожидаемых ≤5. Разбор сошёлся с арифметикой: BullMQ строит ioredis
 * с дефолтными 20 повторами и стратегией `max(min(exp(n),20000),1000)` мс, а `enableOfflineQueue`
 * держит команды в очереди вместо отказа — одна команда на мёртвом Redis отвергается примерно
 * через 4 минуты. Очереди читались ПОСЛЕДОВАТЕЛЬНО, четыре штуки ⇒ ~16 минут.
 *
 * Всё это время проверка висела внутри, следующие тики отбрасывались охраной от наложения, а
 * `/queues` продолжал показывать доаварийный вердикт «всё хорошо» — та самая зелёная картинка
 * посреди полной аварии, против которой написан весь модуль.
 */
export const QUEUE_READ_TIMEOUT_MS = 10_000

/** Ограничить ожидание: истекло — считаем нечитаемым, а не ждём милости ioredis. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('queue read timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/**
 * Read every pipeline queue. One unreachable queue is reported as `unreadable` and does not stop
 * the others — a partial reading is still worth acting on.
 *
 * ⚠ Очереди читаются ПАРАЛЛЕЛЬНО и каждая с таймаутом: на мёртвом Redis последовательный обход
 * складывал задержки очередей друг с другом (см. `QUEUE_READ_TIMEOUT_MS`). Параллельно и с
 * ограничением весь замер укладывается в один таймаут, каким бы ни было число очередей.
 */
export async function readQueueHealth(
  reader: QueueHealthReader,
  nowMs: number,
  timeoutMs = QUEUE_READ_TIMEOUT_MS
): Promise<QueueHealthInput[]> {
  const names = Object.values(QUEUES) as QueueName[]
  return await Promise.all(names.map(async (queue): Promise<QueueHealthInput> => {
    try {
      const [pending, failed] = await Promise.all([
        withTimeout(reader.pending(queue), timeoutMs),
        withTimeout(reader.failed(queue), timeoutMs)
      ])
      return {
        queue,
        ...summarisePending(pending, nowMs),
        recentFailures: countRecentFailures(failed, nowMs)
      }
    } catch {
      return { queue, unreadable: true, oldestPendingAgeMs: null, pending: 0, recentFailures: 0 }
    }
  }))
}
