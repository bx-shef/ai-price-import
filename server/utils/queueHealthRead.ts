import { QUEUES, type QueueName } from '../queue/topology'
import { FAILURE_WINDOW_MS, type QueueHealthInput } from './queueAlert'

// Reading side of the queue health check. Pure over an injected reader — the live one wraps BullMQ,
// tests use a fake. Kept apart from `queue/stats.ts` on purpose: that one answers an unreachable
// Redis with zeros (the operator page must still render), and here zeros would be a lie that turns
// a total outage into a green screen.

/** Raw shapes we need. Only the fields used — BullMQ's Job carries far more. */
export interface RawPendingJob { timestamp?: number | null }
export interface RawFailedAt { finishedOn?: number | null, processedOn?: number | null }

export interface QueueHealthReader {
  /** Unfinished jobs (waiting + active + delayed). Throws when the queue is unreachable. */
  pending: (name: QueueName) => Promise<RawPendingJob[]>
  /** Recently failed jobs, newest first. Throws when the queue is unreachable. */
  failed: (name: QueueName) => Promise<RawFailedAt[]>
}

/** Cap on how many failed rows we look at. Past the alert threshold the exact number stops
 *  mattering — «упало 40» and «упало 400» call for the same action. */
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

/** How many of these failed inside the window. Rows with no timestamp are not counted — an
 *  undated failure could be from any time, and guessing «сейчас» would raise false alarms. */
export function countRecentFailures(jobs: RawFailedAt[], nowMs: number, windowMs = FAILURE_WINDOW_MS): number {
  let n = 0
  for (const j of jobs) {
    const t = num(j?.finishedOn) ?? num(j?.processedOn)
    if (t === null) continue
    if (nowMs - t <= windowMs && t <= nowMs) n++
  }
  return n
}

/**
 * Read every pipeline queue. One unreachable queue is reported as `unreadable` and does not stop
 * the others — a partial reading is still worth acting on.
 */
export async function readQueueHealth(reader: QueueHealthReader, nowMs: number): Promise<QueueHealthInput[]> {
  const out: QueueHealthInput[] = []
  for (const queue of Object.values(QUEUES) as QueueName[]) {
    try {
      const [pending, failed] = await Promise.all([reader.pending(queue), reader.failed(queue)])
      out.push({
        queue,
        ...summarisePending(pending, nowMs),
        recentFailures: countRecentFailures(failed, nowMs)
      })
    } catch {
      out.push({ queue, unreadable: true, oldestPendingAgeMs: null, pending: 0, recentFailures: 0 })
    }
  }
  return out
}
