// Global DAILY budget for demo AI jobs (#321). The per-IP limiter and AI_MAX_CONCURRENCY bound the
// RATE of the public demo, but not the SUM: a botnet (or one client with an address pool) hits the
// speed limit, not a spend ceiling — the owner's LLM key could be burned indefinitely, just slowly.
// This is the missing ceiling: a process-global counter of AI-path demo jobs per UTC day, checked
// BEFORE any OCR/LLM work. The deterministic path (text/csv/xlsx — including the landing's sample
// files) is free and predictable, so it does NOT consume budget.
//
// Persistence: the counter lives in Redis (same REDIS_URL as the pipeline) so a restart does not
// reset the day's spend — an in-memory counter would hand a fresh budget to whoever forced a crash.
// Without Redis (or when it is down) an in-memory fallback still bounds the process (honest caveat:
// per-process and reset by restart — logged once so the owner knows which mode is live).

/** Minimal store: atomically increment `key`, arming `ttlSec` on first increment; null = store down.
 *  `decr` refunds a tick for a job that was admitted by the budget but then refused downstream
 *  (concurrency shed / job store full) — otherwise sustained 503s would drain the day's budget with
 *  zero actual LLM spend, making a full-day lockout cheap. Best-effort (failure just loses one tick). */
export interface BudgetStore {
  incrWithTtl: (key: string, ttlSec: number) => Promise<number | null>
  decr: (key: string) => Promise<void>
}

/** Daily cap from env. Default 200 AI jobs/day (a real prospect tries a handful; 200 ≈ an active
 *  launch day). Clamp keeps a typo from disabling the demo (floor 1) or unbounding it (cap 100k). */
export function demoDailyLimit(env: Record<string, string | undefined>): number {
  const n = Number((env.DEMO_DAILY_LIMIT ?? '').trim())
  if (!Number.isFinite(n) || n <= 0) return 200
  return Math.min(Math.max(Math.floor(n), 1), 100_000)
}

/** UTC day bucket: one key per day, self-expiring. UTC (not portal-local) — the budget protects the
 *  owner's spend, not a user-facing quota, so the boundary just needs to be consistent. */
export function demoBudgetKey(nowMs: number): string {
  return `demo:budget:${new Date(nowMs).toISOString().slice(0, 10)}`
}

/** Key TTL: 48h > 24h so a key armed late in the day still covers the whole day; stale keys die on their own. */
export const BUDGET_TTL_SEC = 48 * 60 * 60

export interface BudgetDecision {
  allowed: boolean
  /** Jobs consumed today INCLUDING this one (refused attempts also count ticks — harmless: the
   *  comparison is `>`, and a refused attempt spent nothing that needs refunding). */
  used: number
  limit: number
  /** True when the decision came from the in-memory fallback (Redis absent/down). */
  degraded: boolean
}

/** Seconds until the next UTC midnight — when the daily budget key rolls over. Floor 60s so a
 *  client right before midnight is not told «retry in 0s» (the counter is per whole UTC day). */
export function secondsToBudgetReset(nowMs: number): number {
  const next = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate() + 1
  )
  return Math.max(60, Math.ceil((next - nowMs) / 1000))
}

/** In-memory fallback counter (per process, per day key). */
function createMemoryCounter(): { incr: (key: string) => number, decr: (key: string) => void } {
  let currentKey = ''
  let count = 0
  const roll = (key: string) => {
    if (key !== currentKey) {
      currentKey = key
      count = 0
    }
  }
  return {
    incr: (key: string) => {
      roll(key)
      return ++count
    },
    decr: (key: string) => {
      roll(key)
      count = Math.max(0, count - 1)
    }
  }
}

/**
 * Build the budget gate. `consume()` increments today's counter and answers whether this job may
 * run. Call it ONLY for jobs that would spend money (the AI path), and BEFORE spending.
 */
export function createDemoBudget(store: BudgetStore | null, opts: { limit: number, now?: () => number }) {
  const now = opts.now ?? Date.now
  const memory = createMemoryCounter()
  let warnedDegraded = false
  return {
    async consume(): Promise<BudgetDecision> {
      const key = demoBudgetKey(now())
      const fromStore = store ? await store.incrWithTtl(key, BUDGET_TTL_SEC) : null
      const degraded = fromStore === null
      if (degraded && !warnedDegraded) {
        warnedDegraded = true
        console.warn('[demo-budget] Redis unavailable — daily budget is in-memory (per process, resets on restart)')
      }
      const used = degraded ? memory.incr(key) : fromStore
      return { allowed: used <= opts.limit, used, limit: opts.limit, degraded }
    },
    /** Refund one tick for a job that was admitted but refused DOWNSTREAM without spending (503
     *  shed / job store full). Best-effort: a lost refund costs one tick, never correctness. */
    async refund(): Promise<void> {
      const key = demoBudgetKey(now())
      if (store) {
        await store.decr(key)
        return
      }
      memory.decr(key)
    }
  }
}
