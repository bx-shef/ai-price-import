import type { DemoResult } from './demoExtract'

// Client-side polling for the demo's async AI job (GH #70): submit returns a jobId, we
// poll GET /api/demo/result/:jobId until it is done/error, so a slow OCR never holds the
// request open (no 504). Pure — the fetch/sleep/clock are injected so it is unit-tested
// without a browser. The component wires real $fetch / setTimeout / Date.now.

export const POLL_INTERVAL_MS = 2000
export const POLL_TIMEOUT_MS = 5 * 60 * 1000

export interface DemoPollResponse {
  status?: string
  result?: DemoResult
  error?: string
}

export interface DemoPollDeps {
  /** Fetch the job status (must NOT throw on 404/422 — return the body). */
  fetchResult: (jobId: string) => Promise<DemoPollResponse>
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/**
 * Poll a demo job to completion. Resolves with the result on `done`, rejects with an
 * honest message on `error` / `404` (expired) / overall timeout.
 */
export async function pollDemoJob(
  jobId: string,
  deps: DemoPollDeps,
  intervalMs: number = POLL_INTERVAL_MS,
  timeoutMs: number = POLL_TIMEOUT_MS
): Promise<DemoResult> {
  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline) {
    await deps.sleep(intervalMs)
    const r = await deps.fetchResult(jobId)
    if (r.status === 'done' && r.result) return r.result
    if (r.status === 'error') throw new Error(r.error || 'Не удалось разобрать документ.')
    if (r.error) throw new Error(r.error) // 404 — job expired
    // status === 'pending' → keep polling
  }
  throw new Error('Разбор занял слишком долго. Попробуйте файл меньшего размера.')
}
