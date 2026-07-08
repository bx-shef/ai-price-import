import { Queue } from 'bullmq'
import type { QueueName } from './topology'

// Lazy BullMQ connection. Passes connection OPTIONS parsed from REDIS_URL (no direct
// ioredis dependency). No-op-safe: queueEnabled() gates producers/workers.

let opts: { host: string, port: number, password?: string, username?: string } | null | undefined

export function connectionOptions() {
  if (opts !== undefined) return opts
  const url = process.env.REDIS_URL
  if (!url) {
    opts = null
    return opts
  }
  const u = new URL(url)
  opts = {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: u.password } : {}),
    ...(u.username ? { username: u.username } : {})
  }
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
