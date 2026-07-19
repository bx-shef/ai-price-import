import IORedis from 'ioredis'
import type { JobRedis } from './jobStore'
import { connectionOptions, type RedisOptions } from '../queue/connection'

// Live + in-memory adapters for the import-job store (#B: import_job moved off Postgres to Redis+TTL).
// Isolated here so jobStore.ts stays ioredis-free and unit-testable with a fake JobRedis. The Redis
// connection is the SAME one BullMQ parses from REDIS_URL (queue/connection.ts) — one Redis, one config.

/** ioredis-backed JobRedis. Every method swallows infra errors and degrades safely (status tracking
 *  is best-effort — a Redis blip reads as «job gone», never a 500 on the in-portal route). */
export function createIoredisJobRedis(conn: RedisOptions): JobRedis {
  const client = new IORedis({
    host: conn.host,
    port: conn.port,
    ...(conn.password ? { password: conn.password } : {}),
    ...(conn.username ? { username: conn.username } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false
  })
  client.on('error', err => console.error('[jobstore] redis error:', err instanceof Error ? err.message : err))
  const warn = (op: string, e: unknown): void =>
    console.error(`[jobstore] redis ${op} failed:`, e instanceof Error ? e.message : e)

  return {
    async put(key, fields, ttlMs) {
      if (!Object.keys(fields).length) return
      try {
        await client.hset(key, fields)
        await client.pexpire(key, ttlMs)
      } catch (e) {
        warn('put', e)
      }
    },
    async getAll(key) {
      try {
        const h = await client.hgetall(key)
        return h && Object.keys(h).length ? h : null
      } catch (e) {
        warn('getAll', e)
        return null
      }
    },
    async claim(key, field, ttlMs) {
      try {
        const n = await client.hsetnx(key, field, '1')
        await client.pexpire(key, ttlMs)
        return n === 1
      } catch (e) {
        warn('claim', e)
        return false // fail toward «missed notice over double post» (#164)
      }
    },
    async indexAdd(index, jobId, score, cap, ttlMs) {
      try {
        await client.zadd(index, score, jobId)
        await client.zremrangebyrank(index, 0, -(cap + 1)) // keep only the newest `cap`
        await client.pexpire(index, ttlMs)
      } catch (e) {
        warn('indexAdd', e)
      }
    },
    async indexList(index, limit) {
      try {
        return await client.zrevrange(index, 0, limit - 1)
      } catch (e) {
        warn('indexList', e)
        return []
      }
    }
  }
}

/** In-memory JobRedis (single-instance, no infra). Jobs do NOT survive a restart and are NOT shared
 *  across replicas — fine for dev / a single backend container; prod sets REDIS_URL. TTL is honored so
 *  nothing accumulates in-process either. */
export function createMemoryJobRedis(now: () => number = Date.now): JobRedis {
  const hashes = new Map<string, { fields: Record<string, string>, exp: number }>()
  const indexes = new Map<string, { entries: Map<string, number>, exp: number }>()
  const liveHash = (key: string) => {
    const e = hashes.get(key)
    if (!e) return null
    if (e.exp <= now()) {
      hashes.delete(key)
      return null
    }
    return e
  }
  const liveIndex = (key: string) => {
    const e = indexes.get(key)
    if (!e) return null
    if (e.exp <= now()) {
      indexes.delete(key)
      return null
    }
    return e
  }
  return {
    async put(key, fields, ttlMs) {
      if (!Object.keys(fields).length) return
      const e = liveHash(key) ?? { fields: {}, exp: 0 }
      Object.assign(e.fields, fields)
      e.exp = now() + ttlMs
      hashes.set(key, e)
    },
    async getAll(key) {
      const e = liveHash(key)
      return e ? { ...e.fields } : null
    },
    async claim(key, field, ttlMs) {
      const e = liveHash(key) ?? { fields: {}, exp: 0 }
      const fresh = e.fields[field] === undefined
      if (fresh) e.fields[field] = '1'
      e.exp = now() + ttlMs
      hashes.set(key, e)
      return fresh
    },
    async indexAdd(index, jobId, score, cap, ttlMs) {
      const e = liveIndex(index) ?? { entries: new Map<string, number>(), exp: 0 }
      e.entries.set(jobId, score)
      if (e.entries.size > cap) {
        // keep the newest `cap` by score
        const keep = [...e.entries.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap)
        e.entries = new Map(keep)
      }
      e.exp = now() + ttlMs
      indexes.set(index, e)
    },
    async indexList(index, limit) {
      const e = liveIndex(index)
      if (!e) return []
      return [...e.entries.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
    }
  }
}

/** Pick the backend: Redis when REDIS_URL is set, else the in-process memory store. */
export function buildJobRedis(): JobRedis {
  const conn = connectionOptions()
  return conn ? createIoredisJobRedis(conn) : createMemoryJobRedis()
}

/** Process-wide singleton used by the routes + queue deps (mirrors demoJobStore). */
export const jobRedis: JobRedis = buildJobRedis()
