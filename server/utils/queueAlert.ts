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
/** Failures within the look-back window that mean «падает системно», not «один кривой документ». */
export const FAILURE_ALERT_THRESHOLD = 10
/** How far back failures are counted. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000

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
 *  - **failing** — too many jobs failed within the look-back window. Jobs ending in failure are
 *    deliberately NOT counted as a stall (the queue is moving), because reporting one breakage
 *    under two names teaches people to read neither.
 */
export function evaluateQueueHealth(queues: QueueHealthInput[], _nowMs?: number): QueueAlert[] {
  const out: QueueAlert[] = []

  for (const q of queues) {
    if (q.unreadable) {
      out.push({
        kind: 'unreadable',
        queue: q.queue,
        text: `очередь «${q.queue}» не читается — состояние конвейера неизвестно (проверьте Redis)`
      })
      continue
    }

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
        text: `очередь «${q.queue}»: ${q.recentFailures} задач упало за последние ${minutes(FAILURE_WINDOW_MS)} мин`
      })
    }
  }

  return out
}
