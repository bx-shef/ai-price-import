import { Queue } from 'bullmq'
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

export function getQueue(name: QueueName): Queue | null {
  const connection = connectionOptions()
  if (!connection) return null
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, {
      connection,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 }
    })
    queues.set(name, q)
  }
  return q
}
