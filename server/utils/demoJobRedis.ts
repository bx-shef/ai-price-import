import IORedis from 'ioredis'
import type { RedisLike } from './demoJobStore'
import type { RedisOptions } from '../queue/connection'

// Live ioredis adapter for the demo job store (GH #78). Isolated here so the store core
// (demoJobStore.ts) stays free of ioredis and unit-testable with a fake RedisLike. The
// connection options are the SAME ones BullMQ parses from REDIS_URL (queue/connection.ts) —
// one Redis, one config source.

/** A tiny keep-alive+lazy client so demo-store failures degrade to a poll 404 (job "gone")
 * rather than crashing the public route. Reuses BullMQ's RedisOptions. */
export function createIoredisRedisLike(conn: RedisOptions): RedisLike {
  const client = new IORedis({
    host: conn.host,
    port: conn.port,
    ...(conn.password ? { password: conn.password } : {}),
    ...(conn.username ? { username: conn.username } : {}),
    lazyConnect: true,
    // Fail fast when Redis is down so the poll route degrades to a clean 404 instead of
    // hanging: bound per-command retries AND refuse to buffer commands while disconnected
    // (enableOfflineQueue:false → a command against a down client rejects at once, caught
    // below). Without this, offline commands queue behind the connect timeout/backoff and
    // add seconds of latency to the public route.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false
  })
  // A connection error must not take down the process; the store methods below swallow
  // per-call errors (a failed poll just reads as "gone").
  client.on('error', err => console.error('[demo-jobstore] redis error:', err instanceof Error ? err.message : err))

  // Every method swallows infra errors and degrades safely (a Redis outage reads as a
  // job that never persisted → the client's poll returns 404 "gone", not a 500). The
  // demo is best-effort by design; it must never take down the public route.
  const warn = (op: string, e: unknown): void =>
    console.error(`[demo-jobstore] redis ${op} failed:`, e instanceof Error ? e.message : e)

  return {
    async setPx(key, value, ttlMs) {
      try {
        await client.set(key, value, 'PX', ttlMs)
      } catch (e) {
        warn('setPx', e)
      }
    },
    async setPxIfExists(key, value, ttlMs) {
      try {
        const res = await client.set(key, value, 'PX', ttlMs, 'XX')
        return res === 'OK'
      } catch (e) {
        warn('setPxIfExists', e)
        return false
      }
    },
    async get(key) {
      try {
        return await client.get(key)
      } catch (e) {
        warn('get', e)
        return null
      }
    }
  }
}
