import IORedis from 'ioredis'
import type { RedisOptions } from '../queue/connection'
import type { WindowCounterStore } from './sharedRateLimit'

// Live ioredis adapter for the shared window counter (#353 + #354). Same isolation pattern as the
// demo budget: the core (`sharedRateLimit.ts`) stays ioredis-free and unit-testable, this file is
// the only place that knows about a client. One Redis, one config source (the same REDIS_URL the
// queues use).
//
// A failure returns `null`, which the core answers with its in-process fallback — a Redis blip must
// never refuse an upload or a review outright. What it MUST NOT do is read as «limit exhausted»:
// that would turn a storage outage into a service outage.

let shared: IORedis | undefined

/** One lazily-built client for all three limiters — three clients for three counters would triple
 *  the connections for no gain (the commands are one INCR each). `null` = no Redis configured. */
export function windowCounterStore(conn: RedisOptions | null): WindowCounterStore | null {
  if (!conn) return null
  if (shared === undefined) {
    shared = new IORedis({
      host: conn.host,
      port: conn.port,
      ...(conn.password ? { password: conn.password } : {}),
      ...(conn.username ? { username: conn.username } : {}),
      maxRetriesPerRequest: 2,
      // The limiter must answer fast or degrade — a queued command on a dead Redis would hold the
      // upload request open for minutes (BullMQ's default is 20 retries with an offline queue).
      enableOfflineQueue: false,
      lazyConnect: false
    })
    shared.on('error', () => { /* logged by the core once, on the first degraded decision */ })
  }
  const client: IORedis = shared
  /**
   * INCR + EXPIRE in one MULTI.
   *
   * ⚠ Not «INCR, then EXPIRE if it is the first tick»: the bucket index is part of the key, so
   * `n === 1` happens exactly once per key and never again — a failed EXPIRE there would leave the
   * key without a TTL FOREVER, while the comment claimed the next armed TTL would clean it up.
   * There is no next one. In a MULTI both commands share the fate of the round-trip.
   */
  const tick = async (key: string, ttlSec: number): Promise<number | null> => {
    const res = await client.multi().incr(key).expire(key, ttlSec).exec()
    const n = res?.[0]?.[1]
    return typeof n === 'number' ? n : null
  }
  return {
    async incrWithTtl(key, ttlSec) {
      try {
        return await tick(key, ttlSec)
      } catch {
        // ⚠ One retry, and only after waiting for the socket. `enableOfflineQueue:false` rejects a
        // command issued before the connection is ready — which is EVERY first request after a
        // deploy. Without this, a live Redis looked «unavailable» for the first few requests, and
        // for the attachment budget (fail-closed) that meant every restart silently turned
        // attachments off. A blip and a real outage must not be indistinguishable.
        if (client.status !== 'ready') {
          try {
            await Promise.race([
              new Promise<void>(res => client.once('ready', () => res())),
              new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000))
            ])
            return await tick(key, ttlSec)
          } catch { /* fall through to the honest «unavailable» below */ }
        }
        // Deliberately no message here: the reason belongs to ONE log line from the core, not to a
        // line per request. A limiter that logs per hit floods exactly during the incident.
        return null
      }
    }
  }
}
