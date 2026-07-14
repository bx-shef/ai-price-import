import { randomUUID } from 'node:crypto'
import { createDemoJobStore } from './demoJobStore'

// Single process-wide job store shared by the demo submit (POST /api/demo/extract) and
// the poll route (GET /api/demo/result/:jobId). Kept in its own module so the poll route
// doesn't import the POST handler's heavy deps (agent/OCR runners). Bounded by TTL + cap.
//
// ⚠️ In-memory, single-instance ONLY. Jobs do NOT survive a backend restart and are NOT
// shared across replicas — behind a load balancer without sticky sessions a poll could
// hit an instance that never saw the job → 404. The prod demo runs one backend container.
// If the demo is ever scaled/replicated, move this to Redis (server/queue/connection.ts).
//
// TTL is deliberately LONGER than the client's 5-min poll window (app/utils/demoPoll.ts)
// so a job that finishes near the end of that window is still alive for complete() to fill
// and the client to fetch — otherwise a finished result would be silently dropped.
const JOB_TTL_MS = 15 * 60 * 1000
const JOB_MAX = 128

export const demoJobStore = createDemoJobStore({ ttlMs: JOB_TTL_MS, maxJobs: JOB_MAX, genId: randomUUID })
