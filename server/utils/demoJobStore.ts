import type { DemoResult } from '~/utils/demoExtract'

// In-memory job store for the PUBLIC demo's async AI path. The heavy extraction (OCR +
// agent) runs in the background so the HTTP request returns immediately with a jobId the
// client polls — a long synchronous request would otherwise trip the gateway timeout with
// a 504 (GH #70/#63). Single-process best-effort (like the rate limiter): the demo does
// not need distributed durability. Pure + DI on `now`/`genId` → unit-tested. Bounded:
// a TTL sweep and a hard cap on live jobs keep memory from growing under load.

export type DemoJobState
  = | { status: 'pending' }
    | { status: 'done', result: DemoResult }
    | { status: 'error', error: string }

interface StoredJob { state: DemoJobState, expiresAt: number }

export interface DemoJobStore {
  /** Create a pending job, or null when the store is full (→ caller sheds load with 503). */
  create: (now: number) => string | null
  /** Mark a job done. No-op if the id is unknown/expired (e.g. swept while processing). */
  complete: (id: string, result: DemoResult, now: number) => void
  /** Mark a job failed. No-op if the id is unknown/expired. */
  fail: (id: string, error: string, now: number) => void
  /** Current state, or null when unknown/expired. */
  get: (id: string, now: number) => DemoJobState | null
  /** Drop expired jobs (call opportunistically to bound memory). */
  sweep: (now: number) => void
  size: () => number
}

export interface DemoJobStoreOptions {
  /** How long a job (pending or finished) is retained. */
  ttlMs: number
  /** Hard cap on live jobs — create() returns null past this (after a sweep). */
  maxJobs: number
  /** Injected id generator (randomUUID in prod) so tests are deterministic. */
  genId: () => string
}

// ── Async layer (GH #78) ──────────────────────────────────────────────────────
//
// The in-memory store above is single-process. When the demo backend is scaled to
// >1 replica (no sticky sessions), a poll can hit an instance that never created the
// job → 404. The async interface below lets the SAME routes run over either backend:
// the in-memory wrapper (default, unchanged behaviour) or a Redis backend (shared
// across replicas, survives restart). Both keep identical semantics: complete/fail are
// no-ops on an unknown/expired id, and a finished job refreshes its TTL so the client
// still has time to fetch it.

export interface AsyncDemoJobStore {
  create: (now: number) => Promise<string | null>
  complete: (id: string, result: DemoResult, now: number) => Promise<void>
  fail: (id: string, error: string, now: number) => Promise<void>
  get: (id: string, now: number) => Promise<DemoJobState | null>
  sweep: (now: number) => Promise<void>
}

/** Wrap the synchronous in-memory store in the async interface (identity semantics). */
export function toAsyncDemoJobStore(sync: DemoJobStore): AsyncDemoJobStore {
  return {
    create: async now => sync.create(now),
    complete: async (id, result, now) => sync.complete(id, result, now),
    fail: async (id, error, now) => sync.fail(id, error, now),
    get: async (id, now) => sync.get(id, now),
    sweep: async now => sync.sweep(now)
  }
}

/** Serialize a job state for a KV backend (Redis value). */
export function serializeJobState(state: DemoJobState): string {
  return JSON.stringify(state)
}

/** Parse a KV value back into a job state; null on missing/corrupt (treated as gone). */
export function parseJobState(raw: string | null | undefined): DemoJobState | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as DemoJobState
    if (v && (v.status === 'pending' || v.status === 'done' || v.status === 'error')) return v
    return null
  } catch {
    return null
  }
}

/** Minimal Redis surface the store needs — injected so the store stays pure/testable
 * (no ioredis import here). The live adapter lives in demoJobRedis.ts. */
export interface RedisLike {
  /** SET key value PX ttlMs — unconditional (used for create). */
  setPx: (key: string, value: string, ttlMs: number) => Promise<void>
  /** SET key value PX ttlMs XX — only if the key exists; true when it was updated. */
  setPxIfExists: (key: string, value: string, ttlMs: number) => Promise<boolean>
  get: (key: string) => Promise<string | null>
}

export interface RedisDemoJobStoreOptions {
  ttlMs: number
  /** Key namespace, e.g. 'demo:job:'. */
  keyPrefix: string
  genId: () => string
}

/** Redis-backed store: shared across replicas, survives restart, native PX expiry (so
 * sweep is a no-op). The in-memory hard cap is intentionally dropped — creation is already
 * bounded upstream by the per-IP rate limit + AI_MAX_CONCURRENCY in the submit route. */
export function createRedisDemoJobStore(redis: RedisLike, opts: RedisDemoJobStoreOptions): AsyncDemoJobStore {
  const key = (id: string): string => `${opts.keyPrefix}${id}`
  return {
    async create() {
      const id = opts.genId()
      await redis.setPx(key(id), serializeJobState({ status: 'pending' }), opts.ttlMs)
      return id
    },
    async complete(id, result) {
      // XX (only-if-exists) mirrors the memory store: a job swept/expired mid-processing
      // is not resurrected. Refreshes TTL so the client can still fetch the result.
      await redis.setPxIfExists(key(id), serializeJobState({ status: 'done', result }), opts.ttlMs)
    },
    async fail(id, error) {
      await redis.setPxIfExists(key(id), serializeJobState({ status: 'error', error }), opts.ttlMs)
    },
    async get(id) {
      return parseJobState(await redis.get(key(id)))
    },
    async sweep() { /* native PX expiry — nothing to sweep */ }
  }
}

export function createDemoJobStore(opts: DemoJobStoreOptions): DemoJobStore {
  const jobs = new Map<string, StoredJob>()

  const sweep = (now: number): void => {
    for (const [id, job] of jobs) if (job.expiresAt <= now) jobs.delete(id)
  }

  return {
    create(now) {
      if (jobs.size >= opts.maxJobs) {
        sweep(now)
        if (jobs.size >= opts.maxJobs) return null
      }
      const id = opts.genId()
      jobs.set(id, { state: { status: 'pending' }, expiresAt: now + opts.ttlMs })
      return id
    },
    complete(id, result, now) {
      const job = jobs.get(id)
      if (!job || job.expiresAt <= now) return
      job.state = { status: 'done', result }
      job.expiresAt = now + opts.ttlMs // refresh so the client has time to fetch the result
    },
    fail(id, error, now) {
      const job = jobs.get(id)
      if (!job || job.expiresAt <= now) return
      job.state = { status: 'error', error }
      job.expiresAt = now + opts.ttlMs
    },
    get(id, now) {
      const job = jobs.get(id)
      if (!job || job.expiresAt <= now) return null
      return job.state
    },
    sweep,
    size: () => jobs.size
  }
}
