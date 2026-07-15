import { randomUUID } from 'node:crypto'
import { createDemoJobStore, toAsyncDemoJobStore, createRedisDemoJobStore, type AsyncDemoJobStore } from './demoJobStore'
import { connectionOptions } from '../queue/connection'
import { createIoredisRedisLike } from './demoJobRedis'

// Single process-wide job store shared by the demo submit (POST /api/demo/extract) and
// the poll route (GET /api/demo/result/:jobId). Kept in its own module so the poll route
// doesn't import the POST handler's heavy deps (agent/OCR runners). Bounded by TTL + cap.
//
// Two backends behind ONE async interface (GH #78):
//  • in-memory (DEFAULT) — single-instance, best-effort, zero infra. Jobs do NOT survive a
//    restart and are NOT shared across replicas → behind a load balancer without sticky
//    sessions a poll could hit an instance that never saw the job (404). Fine for the prod
//    demo, which runs ONE backend container.
//  • Redis (opt-in: DEMO_JOBSTORE=redis + REDIS_URL set) — shared across replicas, survives
//    restart, native PX expiry. Enable this when the demo backend is scaled/replicated.
//    Reuses the SAME Redis that BullMQ connects to (server/queue/connection.ts).
//
// TTL is deliberately LONGER than the client's 5-min poll window (app/utils/demoPoll.ts)
// so a job that finishes near the end of that window is still alive for complete() to fill
// and the client to fetch — otherwise a finished result would be silently dropped.
const JOB_TTL_MS = 15 * 60 * 1000
const JOB_MAX = 128
const REDIS_KEY_PREFIX = 'demo:job:'

/** Pick the backend from env: Redis when explicitly requested AND reachable, else memory. */
export function buildDemoJobStore(env: NodeJS.ProcessEnv = process.env): AsyncDemoJobStore {
  const wantRedis = (env.DEMO_JOBSTORE ?? '').trim().toLowerCase() === 'redis'
  const conn = connectionOptions()
  if (wantRedis && conn) {
    return createRedisDemoJobStore(
      createIoredisRedisLike(conn),
      { ttlMs: JOB_TTL_MS, keyPrefix: REDIS_KEY_PREFIX, genId: randomUUID }
    )
  }
  return toAsyncDemoJobStore(createDemoJobStore({ ttlMs: JOB_TTL_MS, maxJobs: JOB_MAX, genId: randomUUID }))
}

export const demoJobStore: AsyncDemoJobStore = buildDemoJobStore()
