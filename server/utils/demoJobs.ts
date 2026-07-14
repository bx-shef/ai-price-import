import { randomUUID } from 'node:crypto'
import { createDemoJobStore } from './demoJobStore'

// Single process-wide job store shared by the demo submit (POST /api/demo/extract) and
// the poll route (GET /api/demo/result/:jobId). Kept in its own module so the poll route
// doesn't import the POST handler's heavy deps (agent/OCR runners). Bounded by TTL + cap.
const JOB_TTL_MS = 5 * 60 * 1000
const JOB_MAX = 128

export const demoJobStore = createDemoJobStore({ ttlMs: JOB_TTL_MS, maxJobs: JOB_MAX, genId: randomUUID })
