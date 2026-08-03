import { ALL_QUEUES } from '~/utils/opsMonitor'
// Pure decision core for queue alerting (BACKLOG.md §1 «Алертинг очередей»).
//
// `/queues` shows a SNAPSHOT: how many jobs are waiting right now. A snapshot cannot tell apart the
// two states that actually matter — «навалило работы, но она разгребается» (fine) and «навалило
// работы, и она не двигается» (broken: dead worker, wedged portal token, provider outage). Both
// look like a big number.
//
// TWO WRONG DESIGNS PRECEDED THIS ONE. Both are worth keeping written down, because both looked
// obviously right and neither was:
//
//  1. **Дельта `completed`/`failed` между замерами.** Those are not counters — they are the sizes of
//     retained sets, capped by `removeOnComplete: 1000` / `removeOnFail: 5000`
//     (server/queue/connection.ts). On a busy queue `completed` pins at its cap and stops growing,
//     so the delta is zero exactly while everything works: a permanent false alarm under normal
//     load, and silence during a real outage once `failed` hit its own cap. An operator retrying a
//     failed job made the delta NEGATIVE, alerting the moment somebody fixed something.
//  2. **Порог по размеру хвоста (50+ ждущих).** Ties the alarm to volume, so it can only ever fire
//     for big portals. `b24-events` carries installs and uninstalls — единицы событий; with its
//     worker dead, portals silently lose their tokens and the backlog never reaches 50. A quiet
//     portal's crm-sync could stand still for a day behind five waiting jobs. The loudest failures
//     are the quietest ones.
//
// What is measured instead is **how long the oldest unfinished job has been sitting there**. It
// needs no retained history (job timestamps survive any trimming), no previous snapshot, and no
// assumption about traffic: one job stuck for twenty minutes is a fault on a one-portal install and
// on a hundred-portal one alike, while a thousand fresh jobs draining normally stay silent because
// the oldest of them is young.

/** Age of the oldest unfinished job that means «не двигается». Generous on purpose: one document
 *  can legitimately take minutes (extraction + LLM + the portal's ~2 req/s limiter), and a burst
 *  queues behind that. What it must never be is «зависит от размера портала». */
export const STALL_AGE_MS = 20 * 60 * 1000
/**
 * Failures within the look-back window that mean «падает системно».
 *
 * Low because of what actually lands in BullMQ's `failed` set, and what `countRecentFailures` then
 * keeps of it.
 *
 * A rejection the app works out ITSELF — unreadable file, empty text, unrecognised document, no VAT
 * rate in the portal, no such currency — never reaches `failed`: the handler records the reason and
 * RETURNS normally (`failJob` in queue/handlers.ts), and the uploader is told directly (#289).
 *
 * A rejection that arrives as a REST ERROR from the portal — no rights, entity type unavailable,
 * portal no longer authorised — DOES throw and does exhaust its attempts. Those are excluded a
 * layer below, by `isServiceFailure` in queueHealthRead.ts: they are deterministic per portal, so
 * counting them would tie this alert to the number of misconfigured tenants rather than to our
 * health. What is left is our own breakage: Redis gone, the transport failing, a worker dying.
 *
 * The first version used 10 per 15 minutes, borrowed from «один кривой документ — не повод будить».
 * That intuition was about a population this rule never sees, and the threshold it produced made
 * the rule near-unreachable for a small service: at a few documents an hour, everything could be
 * broken and the count would stay at one or two. Three of OUR failures in an hour is a fault.
 */
export const FAILURE_ALERT_THRESHOLD = 3
/**
 * How far back failures are counted. An hour rather than fifteen minutes for the same reason: at a
 * few documents an hour, a fifteen-minute window can be empty even while everything is broken.
 */
export const FAILURE_WINDOW_MS = 60 * 60 * 1000

export type QueueAlertKind = 'stalled' | 'failing' | 'unreadable'

export interface QueueAlert {
  kind: QueueAlertKind
  queue: string
  /** Ready-to-show Russian sentence; the caller decides where it goes. */
  text: string
}

/** One queue as the health check sees it. Every field survives BullMQ's retention caps. */
export interface QueueHealthInput {
  queue: string
  /**
   * True when the queue could not be read at all (Redis down, connection refused).
   *
   * This MUST be distinct from «прочитали, там пусто». The counts reader answers an unreachable
   * Redis with zeros (server/queue/stats.ts), which is the most dangerous possible lie here: the
   * whole pipeline being dead would render as an empty, healthy queue — a green screen during a
   * total outage.
   */
  unreadable?: boolean
  /** Age of the oldest job not yet finished (waiting / active / delayed), ms. `null` — очередь пуста. */
  oldestPendingAgeMs: number | null
  /** How many jobs are unfinished — for the message only; never a condition. */
  pending: number
  /** Failures within `FAILURE_WINDOW_MS`. Counted by timestamp, not by set size. */
  recentFailures: number
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/**
 * Judge one reading of the pipeline. Empty list = healthy, so the caller can report unconditionally.
 *
 * Three rules:
 *
 *  - **unreadable** — the queue could not be read. Reported instead of, not alongside, the others:
 *    with no data every other verdict would be invented.
 *  - **stalled** — the oldest unfinished job has been sitting longer than `STALL_AGE_MS`.
 *    `delayed` counts as unfinished: a job bouncing in retry-backoff is not progress.
 *  - **failing** — jobs are exhausting their retries. Not counted as a stall (the queue IS moving),
 *    because reporting one breakage under two names teaches people to read neither. See
 *    `FAILURE_ALERT_THRESHOLD` for why the number is small: rejected documents never reach this
 *    population, so anything here is already abnormal.
 */
/**
 * Имя очереди для эпизода «конвейер не читается» — общий источник с экраном оператора.
 *
 * `unreadable` — ВСЕГДА один эпизод на весь конвейер, сколько бы очередей ни выпало. Это не
 * упрощение, а требование к ключу: он обязан быть устойчив к смене ФОРМЫ аварии.
 */
export { ALL_QUEUES } from '~/utils/opsMonitor'

/** Сколько имён очередей печатать в тексте частичной аварии, прежде чем свернуть в «и ещё N». */
const MAX_NAMED_QUEUES = 3

export function evaluateQueueHealth(queues: QueueHealthInput[], _nowMs?: number): QueueAlert[] {
  const out: QueueAlert[] = []

  // ⚠ Нечитаемость — ОДИН эпизод, а не по штуке на очередь. Две живые находки подряд, обе про
  // «канал шумит громче всего на самой тяжёлой аварии»:
  //
  //  1. Прогон 2026-08-02: остановили Redis — пришло ЧЕТЫРЕ тревоги и потом ЧЕТЫРЕ
  //     «восстановилось». Очереди не независимы, они живут в одном Redis: он лёг — «не читается»
  //     верно для каждой.
  //  2. Первая правка схлопывала только ПОЛНУЮ аварию, оставляя пер-очередные эпизоды для
  //     частичной, — и от этого ключ эпизода стал зависеть от ЧИСЛА выпавших очередей. Разбор
  //     показал сценарий: полная авария → частичная → снова полная. На третьем шаге весь конвейер
  //     мёртв, а канал шлёт «✅ очереди снова читаются» (ключ `*` пропал из текущего замера, значит
  //     «восстановился»), сама же тревога глохнет в `MIN_REANNOUNCE_MS`. Зелёная галочка посреди
  //     полной аварии — худший из возможных исходов, и до правки его не было.
  //
  // Поэтому ключ фиксирован (`ALL_QUEUES`) и не зависит ни от числа выпавших очередей, ни от того,
  // какие именно выпали. Меняется только ТЕКСТ: он и называет имена, когда их немного.
  //
  // ⚠ Гард на `queues.length > 0` обязателен: `[].every(…)` истинно, и пустой замер объявил бы
  // полную аварию.
  const unreadable = queues.filter(q => q.unreadable)
  if (unreadable.length > 0) {
    const all = unreadable.length === queues.length
    const names = unreadable.slice(0, MAX_NAMED_QUEUES).map(q => `«${q.queue}»`).join(', ')
    const rest = unreadable.length - MAX_NAMED_QUEUES
    out.push({
      kind: 'unreadable',
      queue: ALL_QUEUES,
      text: all
        ? 'очереди не читаются — состояние конвейера неизвестно (проверьте Redis)'
        : `не читаются очереди: ${names}${rest > 0 ? ` и ещё ${rest}` : ''} — состояние этой части конвейера неизвестно`
    })
  }

  // ⚠ Нечитаемые очереди пропускаем, а ЧИТАЕМЫЕ проверяем как обычно: ранний выход из-за общей
  // аварии похоронил бы настоящий простой на живой очереди. Сегодня это ещё и недостижимо
  // (`readQueueHealth` обнуляет счётчики нечитаемой очереди), но премисса «все очереди в одном
  // Redis» — утверждение, а не гарантия, и держаться за неё в коде не стоит.
  for (const q of queues) {
    if (q.unreadable) continue

    if (q.oldestPendingAgeMs !== null && q.oldestPendingAgeMs > STALL_AGE_MS) {
      out.push({
        kind: 'stalled',
        queue: q.queue,
        text: `очередь «${q.queue}» не разгребается: ${q.pending} задач ждут, самая старая — уже ${minutes(q.oldestPendingAgeMs)} мин`
      })
    }

    if (q.recentFailures >= FAILURE_ALERT_THRESHOLD) {
      out.push({
        kind: 'failing',
        queue: q.queue,
        text: `очередь «${q.queue}»: ${q.recentFailures} задач исчерпали все попытки за последний час`
      })
    }
  }

  return out
}
