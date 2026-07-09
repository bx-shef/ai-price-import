// In-memory sliding-window rate limiter for the public demo endpoint.
// Pure + DI on `now` → unit-tested. Single-process best-effort (the demo does not
// need distributed accuracy); the real in-portal upload path is nginx `limit_req`.

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterMs: number
}

export interface RateLimiter {
  check: (key: string, now: number) => RateLimitDecision
  /** Drop windows older than `windowMs` (call opportunistically to bound memory). */
  sweep: (now: number) => void
  size: () => number
}

/** Defensive cap on distinct keys held at once (bounds memory under key churn). */
const MAX_KEYS = 50_000

/** Create a limiter allowing `max` hits per `windowMs` per key. */
export function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>()

  const prune = (arr: number[], now: number): number[] => arr.filter(t => now - t < windowMs)

  const sweep = (now: number) => {
    for (const [key, arr] of hits) {
      const kept = prune(arr, now)
      if (kept.length) hits.set(key, kept)
      else hits.delete(key)
    }
  }

  return {
    check(key, now) {
      // Bound memory: if the map has grown large, evict expired windows first.
      if (hits.size >= MAX_KEYS) sweep(now)
      const recent = prune(hits.get(key) ?? [], now)
      if (recent.length >= max) {
        const oldest = recent[0]!
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, windowMs - (now - oldest)) }
      }
      recent.push(now)
      hits.set(key, recent)
      return { allowed: true, remaining: max - recent.length, retryAfterMs: 0 }
    },
    sweep,
    size() {
      return hits.size
    }
  }
}

/**
 * Pick the client IP for rate-limiting. Our nginx uses
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, which APPENDS the
 * real peer to the end of the list — so the trustworthy client IP is the LAST hop,
 * not the first (the first hop is fully client-controlled and spoofable). Fall back
 * to the socket address, then a constant bucket.
 */
export function clientKey(xff: string | undefined, remote: string | undefined): string {
  const hops = (xff ?? '').split(',').map(h => h.trim()).filter(Boolean)
  const last = hops[hops.length - 1]
  return last || (remote ?? '').trim() || 'unknown'
}
