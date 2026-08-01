import { Queue } from 'bullmq'
import type { JobsOptions } from 'bullmq'
import type { QueueName } from './topology'

// Lazy BullMQ connection. Passes connection OPTIONS parsed from REDIS_URL (no direct
// ioredis dependency). No-op-safe: queueEnabled() gates producers/workers.

export interface RedisOptions { host: string, port: number, password?: string, username?: string }

/** Pure: parse a REDIS_URL into BullMQ connection options, or null when unset/invalid. */
export function parseRedisUrl(url: string | undefined): RedisOptions | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return {
      host: u.hostname,
      port: Number(u.port || 6379),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      ...(u.username ? { username: decodeURIComponent(u.username) } : {})
    }
  } catch {
    return null
  }
}

let opts: RedisOptions | null | undefined

export function connectionOptions(): RedisOptions | null {
  if (opts !== undefined) return opts
  opts = parseRedisUrl(process.env.REDIS_URL)
  return opts
}

export function queueEnabled(): boolean {
  return connectionOptions() !== null
}

const queues = new Map<string, Queue>()

/** Job defaults every queue inherits. Exported so the retention numbers are assertable: the alert
 *  rules deliberately do NOT count completed/failed deltas (queueAlert.ts header) precisely because
 *  these are NUMERIC caps — the sets are truncated, so a delta is zero exactly when all is well.
 *  Swapping either to `true`/`false` would silently invalidate that reasoning. */
/*  `satisfies JobsOptions` is load-bearing, not decoration: a spread into `new Queue({...})` loses the
 *  excess-property check an inline literal gets, so a typo like `removeOnCompete` would compile and be
 *  silently ignored by BullMQ. Frozen (outer AND the nested backoff — the spread is shallow, so every
 *  queue shares that one object) because this is exported for tests: a mutation here would leak into
 *  every queue built later by the lazy getQueue. */
export const QUEUE_DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 3,
  backoff: Object.freeze({ type: 'exponential' as const, delay: 5000 }),
  removeOnComplete: 1000,
  removeOnFail: 5000
} satisfies JobsOptions)

export function getQueue(name: QueueName): Queue | null {
  const connection = connectionOptions()
  if (!connection) return null
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, {
      connection,
      defaultJobOptions: { ...QUEUE_DEFAULT_JOB_OPTIONS }
    })
    queues.set(name, q)
  }
  return q
}
