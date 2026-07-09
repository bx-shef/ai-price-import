import { QUEUES, type QueueName } from './topology'

// Pure queue-counts aggregation for observability (ops console + operator page).
// DI over a CountsReader → unit-tested; the live reader wraps BullMQ getJobCounts.

export interface QueueCounts {
  name: string
  waiting: number
  active: number
  completed: number
  failed: number
  delayed: number
}

/** Read raw counts for one queue (BullMQ getJobCounts shape), or {} when unavailable. */
export type CountsReader = (name: QueueName) => Promise<Record<string, number>>

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** Aggregate counts across all pipeline queues (stable order; missing → zeros). */
export async function readQueueCounts(reader: CountsReader): Promise<QueueCounts[]> {
  const names = Object.values(QUEUES) as QueueName[]
  const out: QueueCounts[] = []
  for (const name of names) {
    let c: Record<string, number>
    try {
      c = await reader(name)
    } catch {
      c = {}
    }
    out.push({
      name,
      waiting: n(c.waiting),
      active: n(c.active),
      completed: n(c.completed),
      failed: n(c.failed),
      delayed: n(c.delayed)
    })
  }
  return out
}
