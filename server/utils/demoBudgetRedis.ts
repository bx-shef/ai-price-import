import IORedis from 'ioredis'
import type { RedisOptions } from '../queue/connection'
import type { BudgetStore } from './demoBudget'

// Live ioredis adapter for the demo daily budget (#321). Same isolation pattern as
// demoJobRedis.ts: the core (demoBudget.ts) stays ioredis-free and unit-testable; the same
// REDIS_URL/options as BullMQ (one Redis, one config source). Errors degrade to `null`, which
// the core answers with its in-memory fallback — a Redis outage must never 500 the public demo,
// and must not read as «бюджет исчерпан» either.

export function createIoredisBudgetStore(conn: RedisOptions): BudgetStore {
  const client = new IORedis({
    host: conn.host,
    port: conn.port,
    ...(conn.password ? { password: conn.password } : {}),
    ...(conn.username ? { username: conn.username } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false
  })
  client.on('error', err => console.error('[demo-budget] redis error:', err instanceof Error ? err.message : err))
  return {
    async incrWithTtl(key, ttlSec) {
      try {
        const n = await client.incr(key)
        // Arm the TTL on the key's first tick only; if THAT call fails the counter still works for
        // the day and the stale key is capped at one extra row.
        if (n === 1) await client.expire(key, ttlSec).catch(() => {})
        return n
      } catch (e) {
        console.error('[demo-budget] redis incr failed:', e instanceof Error ? e.message : e)
        return null
      }
    }
  }
}
