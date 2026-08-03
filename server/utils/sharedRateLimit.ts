// Shared window counter in Redis — ONE construction, three uses (#353 + #354, owner's decision to
// do them in one pass because the mechanism is the same and only the key differs):
//
//   • uploads   — key = the employee, refuse over the limit;
//   • feedback  — key = the employee, refuse over the limit;
//   • the feedback REPO — key = the receiving repository, window an hour, and over the limit the
//     review is still ACCEPTED, only without its attachment.
//
// Why it had to leave process memory. Both per-employee limiters counted in their own process. With
// one HTTP instance that is a real limit; the moment the HTTP role is replicated for availability
// each replica starts its own count and the effective limit becomes N×. There is no error and no
// log line for that — the protection just quietly weakens by the number of replicas, and for
// feedback it weakens exactly where it costs money (the publisher's GitHub quota).
//
// The repo-wide limit could never have lived in memory at all: it is a limit on the RECEIVER, and
// there may be several senders by definition.
//
// The window is a FIXED bucket (`floor(now / window)`), not a sliding one: a sliding window needs
// the timestamps of every hit, which is a sorted set per key and a much bigger footprint, while the
// job here is to stop an unattended loop and to keep a shared quota — not to meter to the unit. The
// cost is the usual bucket edge: up to 2× the limit across a boundary. Documented, accepted.

/** Minimal store contract. `null` = the store is unavailable → the caller degrades (see below). */
export interface WindowCounterStore {
  /** Atomically increment `key`, arming `ttlSec` on the first tick. Returns the new value. */
  incrWithTtl: (key: string, ttlSec: number) => Promise<number | null>
}

export interface WindowLimitSpec {
  /** Namespace so the three uses cannot collide in one Redis. */
  prefix: string
  limit: number
  windowMs: number
}

export interface WindowLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterMs: number
  /** Hits consumed in this window INCLUDING this one. */
  used: number
  limit: number
  /** True when the answer came from the in-process fallback (store absent or down). */
  degraded: boolean
}

/**
 * Key of the current window bucket.
 *
 * The bucket index is part of the key, so an expired window simply becomes a different key — no
 * reset, no sweep, nothing to get wrong. TTL only keeps old buckets from accumulating.
 */
export function windowKey(spec: WindowLimitSpec, key: string, nowMs: number): string {
  return `rl:${spec.prefix}:${Math.floor(nowMs / spec.windowMs)}:${key}`
}

/** Milliseconds until the current bucket rolls over — what the caller reports as `retry-after`. */
export function windowResetMs(spec: WindowLimitSpec, nowMs: number): number {
  return spec.windowMs - (nowMs % spec.windowMs)
}

/** TTL for a bucket key: twice the window, so a key armed late still outlives its own bucket. */
export function bucketTtlSec(windowMs: number): number {
  return Math.max(1, Math.ceil((windowMs * 2) / 1000))
}

/**
 * One shared limiter over a store, with an in-process fallback.
 *
 * ⚠ The fallback is honest, not silent. For the per-employee limits it is the OLD behaviour and
 * bounds the loop just as before, so it degrades quietly-but-logged. For a limit whose whole point
 * is to be shared (the receiving repo) the caller must decide explicitly what an unshared count
 * means — `degraded` is returned for exactly that, and `feedbackRepoBudget` below acts on it.
 */
/**
 * In-memory store with the SAME bucket semantics as the Redis one.
 *
 * Deliberately not the old sliding-window limiter: the fallback must differ from the normal path in
 * one way only — whether the count is shared — and not in when a window rolls over or what
 * `retry-after` says. A fallback that behaves differently is a second implementation to reason
 * about, and it would only ever run during an incident, i.e. where surprises cost the most.
 * Bounded by key count so a churn of keys cannot grow it without limit.
 */
export function memoryWindowStore(maxKeys = 50_000): WindowCounterStore {
  const hits = new Map<string, number>()
  return {
    async incrWithTtl(key) {
      // ⚠ Drop the OLDEST tenth, not everything. `clear()` reset every bucket at once, so a churn
      // of keys forgave the counts of everyone currently being limited — measured: with a small cap
      // an alternating «victim + noise» pattern passed 20 of 20. Insertion order is a good enough
      // proxy for age here, and the bucket index is in the key, so evicted entries are only ever
      // stale or someone's partial count, never a correctness issue.
      if (hits.size >= maxKeys) {
        for (const k of [...hits.keys()].slice(0, Math.ceil(maxKeys / 10))) hits.delete(k)
      }
      const v = (hits.get(key) ?? 0) + 1
      // Re-insert so the key moves to the END of the iteration order: eviction above then takes the
      // LEAST RECENTLY counted keys. Plain insertion order would evict whoever is being limited
      // right now — they were inserted first — which is exactly backwards.
      hits.delete(key)
      hits.set(key, v)
      return v
    }
  }
}

/**
 * One shared limiter over a store, with an in-process fallback.
 *
 * ⚠ The fallback is honest, not silent. For the per-employee limits it bounds the loop just as
 * before, so it degrades quietly-but-logged. For a limit whose whole point is to be shared (the
 * receiving repo) the caller must decide explicitly what an unshared count means — `degraded` is
 * returned for exactly that, and `feedbackRepoBudget` acts on it.
 */
export function createSharedLimiter(spec: WindowLimitSpec, store: WindowCounterStore | null, onDegrade?: (reason: string) => void): {
  check: (key: string, nowMs: number) => Promise<WindowLimitDecision>
  reset: () => void
} {
  let memory = memoryWindowStore()
  // ⚠ Once per EPISODE, not once per process. A line per request would flood the log exactly during
  // the incident; but never re-arming means a second, later outage degrades in total silence — and
  // «предел не действует» must never be invisible. The flag is cleared by the first healthy answer.
  let warned = false
  const warnOnce = (reason: string) => {
    if (warned) return
    warned = true
    onDegrade?.(reason)
  }

  const decide = (used: number, nowMs: number, degraded: boolean): WindowLimitDecision => {
    const allowed = used <= spec.limit
    return {
      allowed,
      used,
      limit: spec.limit,
      remaining: Math.max(0, spec.limit - used),
      // A refused attempt still ticks the counter. Harmless: the comparison is `>`, and the wait is
      // until the bucket rolls over regardless of how many attempts landed in it — so hammering the
      // button cannot postpone your own unblocking.
      retryAfterMs: allowed ? 0 : windowResetMs(spec, nowMs),
      degraded
    }
  }

  return {
    reset() {
      memory = memoryWindowStore()
    },
    async check(key, nowMs) {
      const bucket = windowKey(spec, key, nowMs)
      const ttl = bucketTtlSec(spec.windowMs)
      if (store) {
        const used = await store.incrWithTtl(bucket, ttl)
        if (used !== null) {
          warned = false
          return decide(used, nowMs, false)
        }
        warnOnce('store unavailable')
      } else {
        warnOnce('no store')
      }
      const used = (await memory.incrWithTtl(bucket, ttl)) ?? 1
      return decide(used, nowMs, true)
    }
  }
}
