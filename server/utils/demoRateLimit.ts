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

/** Create a limiter allowing `max` hits per `windowMs` per key. */
export function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const hits = new Map<string, number[]>()

  const prune = (arr: number[], now: number): number[] => arr.filter(t => now - t < windowMs)

  return {
    check(key, now) {
      const recent = prune(hits.get(key) ?? [], now)
      if (recent.length >= max) {
        const oldest = recent[0]!
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, windowMs - (now - oldest)) }
      }
      recent.push(now)
      hits.set(key, recent)
      return { allowed: true, remaining: max - recent.length, retryAfterMs: 0 }
    },
    sweep(now) {
      for (const [key, arr] of hits) {
        const kept = prune(arr, now)
        if (kept.length) hits.set(key, kept)
        else hits.delete(key)
      }
    },
    size() {
      return hits.size
    }
  }
}

/**
 * Pick the client IP for rate-limiting. Trust only the FIRST hop of
 * X-Forwarded-For (set by our own nginx); fall back to the socket address.
 * Never trust a client-supplied later hop (spoofable).
 */
export function clientKey(xff: string | undefined, remote: string | undefined): string {
  const first = (xff ?? '').split(',')[0]?.trim()
  return first || (remote ?? '').trim() || 'unknown'
}
