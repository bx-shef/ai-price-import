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
