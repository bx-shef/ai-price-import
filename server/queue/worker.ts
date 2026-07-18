import { Worker } from 'bullmq'
import { unlink } from 'node:fs/promises'
import { connectionOptions } from './connection'
import { QUEUES } from './topology'
import type { AgentJob, CrmSyncJob, EventJob, ExtractJob } from './topology'
import { handleAgentRunJob, handleCrmSyncJob, handleEventJob, handleFileExtractJob } from './handlers'
import { liveAgentRunDeps, liveCrmSyncHandlerDeps, liveEventDeps, liveFileExtractDeps, type LiveInfra } from './liveDeps'
import { setJobStatus } from '../utils/jobStore'
import { query } from '../db/client'
import { makeAgentSpawn } from '../agent/spawn'
import { liveExtractRunners } from '../utils/extractRunners'
import { withSpan } from '../utils/telemetrySpan'
import { portalHash } from '../utils/telemetryAttributes'

// BullMQ workers binding the pure handlers to live infra. Thin glue — the logic lives
// in the (tested) handlers; validated by typecheck. Started in-process by the queue plugin.

// Per-queue worker concurrency. Defaults keep prior behaviour (extract 4 / agent 2 / crm 4)
// but are OVERRIDABLE via env so a minimal 2-vCPU host can drop them to ≤ cores — heavy OCR
// running 3-4 abreast on few cores oversubscribes CPU and can push each tesseract past
// RUN_TIMEOUT_MS (false failures). See GH #95, docs/redesign/09-deploy §«Ресурсы воркера».
export interface QueueConcurrency { extract: number, agent: number, crm: number }

/** Sanity ceiling on an env concurrency override (a typo like `999999` mustn't spawn an
 *  absurd worker). Clamps, not rejects — a big-but-plausible value is honoured up to this. */
export const MAX_QUEUE_CONCURRENCY = 64

/** Read a positive-int env override (clamped to MAX_QUEUE_CONCURRENCY), else the default.
 *  Invalid values (0, negative, non-integer, junk) fall back to `def`. Pure (env injected). */
export function concurrencyFromEnv(
  env: Record<string, string | undefined>,
  key: string,
  def: number
): number {
  const n = Number(env[key])
  if (!Number.isInteger(n) || n < 1) return def
  return Math.min(n, MAX_QUEUE_CONCURRENCY)
}

/** Resolve the three worker concurrencies from env (defaults 4/2/4). Pure → unit-tested. */
export function queueConcurrency(env: Record<string, string | undefined> = process.env): QueueConcurrency {
  return {
    extract: concurrencyFromEnv(env, 'QUEUE_EXTRACT_CONCURRENCY', 4),
    agent: concurrencyFromEnv(env, 'QUEUE_AGENT_CONCURRENCY', 2),
    crm: concurrencyFromEnv(env, 'QUEUE_CRM_CONCURRENCY', 4)
  }
}

// ── crm-sync stalled-reprocessing guard (#163, Part 1) ────────────────────────────────────
// crm-sync idempotency is find-before-create by a B24 marker (originLookup → crm.item.list, then
// crm.item.add). That is a TOCTOU: it protects SEQUENTIAL retries (crash recovery — a committed
// create leaves the marker, so the retry finds it) but NOT CONCURRENT reprocessing of one job.
// BullMQ redelivers a job to a SECOND worker once the first worker's lock is deemed STALLED; if
// the first is still mid-`crm.item.add`, both find "not created" and both create → a DUPLICATE
// entity (Bitrix does not enforce originId/xmlId uniqueness).
//
// A pg advisory lock around find→create would serialize it fully, but it must HOLD a pooled
// connection across the REST create — and the pool is `max: 5` (db/client.ts), so at crm
// concurrency 4 that starves the pool (getDocument / setJobStatus / metrics / token loads all
// block). Rejected for that reason (issue option 1's "держит pooled pg-соединение" caveat).
//
// Instead we shut the false-stall window without touching pg: BullMQ RENEWS a job's lock every
// lockDuration/2 while the async handler runs, and crm-sync's awaits are REST I/O (they do not
// block the event loop), so the renewal timer keeps firing — a LIVE worker only stalls if its
// loop is blocked > lockDuration/2. Raising lockDuration well above worst-case create latency +
// GC jitter makes a false stall of a live crm worker effectively impossible, so the second worker
// never runs concurrently with the first → no duplicate. maxStalledCount:1 bounds a GENUINELY
// crashed job to one recovery redelivery, which find-before-create makes safe (a committed create
// left the marker → the redelivery finds it). Residual (accepted): a real >30s event-loop block
// AND an in-flight uncommitted create on the same tick — vanishingly unlikely in the dedicated
// crm worker container (OCR CPU lives in the extract worker), and self-corrects on the next retry.
export const CRM_LOCK_DURATION_MS = 60_000
export const CRM_STALLED_INTERVAL_MS = 60_000
export const CRM_MAX_STALLED_COUNT = 1

/** BullMQ lock options for the crm-sync worker (#163). `stalledInterval >= lockDuration` is
 *  required so the stall scan never races ahead of the lock's own lifetime. Pure → unit-tested. */
export function crmLockTuning(): { lockDuration: number, stalledInterval: number, maxStalledCount: number } {
  return {
    lockDuration: CRM_LOCK_DURATION_MS,
    stalledInterval: CRM_STALLED_INTERVAL_MS,
    maxStalledCount: CRM_MAX_STALLED_COUNT
  }
}

/** Assemble LiveInfra from the environment (the single place pipeline secrets are read). */
export function buildLiveInfra(): LiveInfra {
  return {
    query,
    encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
    clientId: process.env.B24_CLIENT_ID ?? '',
    clientSecret: process.env.B24_CLIENT_SECRET ?? '',
    now: () => Date.now(),
    // Agent runs with a SANITIZED env (no backend secrets) — see agentSpawnEnv.
    agentSpawn: makeAgentSpawn(),
    runners: liveExtractRunners
  }
}

/** The `b24-events` worker (install/uninstall). MUST run on a SINGLE instance: it stays
 *  at the default concurrency 1 for per-portal ordering, but that only holds within ONE
 *  process — the plugin runs it on the primary (cron) instance ONLY, NEVER on scaled
 *  throughput replicas (else ONAPPINSTALL/ONAPPUNINSTALL for one portal could reorder
 *  across replicas and leave a live token after an uninstall). Returns null without Redis. */
export function startEventWorker(infra: LiveInfra = buildLiveInfra()): Worker | null {
  const connection = connectionOptions()
  if (!connection) return null
  const eventDeps = liveEventDeps(infra)
  const events = new Worker(QUEUES.events, async (job) => {
    const data = job.data as EventJob
    // Job-level trace span (телеметрия) — install/uninstall latency/outcome per portal.
    await withSpan('b24-events', {
      'job.queue': 'b24-events',
      'portal.hash': portalHash(data.memberId)
    }, () => handleEventJob(data, eventDeps))
  }, { connection })
  // A permanently-failed event (all attempts exhausted) stays in the failed set — B24
  // does not redeliver online events, so surface it loudly for an operator to replay.
  events.on('failed', (job, err) => {
    if (job && (job.attemptsMade ?? 0) >= (job.opts?.attempts ?? 1)) {
      console.error('[queue] b24-events job permanently failed (needs replay):', job.id, (err as Error)?.message)
    }
  })
  return events
}

/** The throughput workers (extract/agent/crm-sync) — safe to run on N scaled replicas
 *  (Redis hands each job to exactly one). `concurrency` overrides ALL three when set; when
 *  undefined each keeps its built-in default (they differ: the agent/LLM step is heavier).
 *  Returns [] when Redis is not configured. */
export function startThroughputWorkers(infra: LiveInfra = buildLiveInfra()): Worker[] {
  const connection = connectionOptions()
  if (!connection) return []

  const fileExtract = liveFileExtractDeps(infra)
  const agentRun = liveAgentRunDeps(infra)
  const crmSync = liveCrmSyncHandlerDeps(infra)
  const cc = queueConcurrency() // per-queue env overrides (defaults 4/2/4), #95

  const extract = new Worker(QUEUES.extract, async (job) => {
    const data = job.data as ExtractJob
    // Job-level trace span (телеметрия) — per-portal latency/outcome for the OCR/extract stage;
    // no-op when telemetry is off. Only safe attrs (queue, hashed portal, handler ok flag).
    await withSpan('file-extract', {
      'job.queue': 'file-extract',
      'portal.hash': portalHash(data.memberId)
    }, async () => {
      // Handled failures set 'error' and return {ok:false}; only an infra throw propagates (→ retry).
      const res = await handleFileExtractJob(data, fileExtract)
      await cleanupUpload(data) // success/handled-fail path
      return res
    }, res => ({ 'job.ok': res.ok }))
  }, { connection, concurrency: cc.extract })

  const agent = new Worker(QUEUES.agent, async (job) => {
    const data = job.data as AgentJob
    // Job-level trace span (телеметрия) — per-portal latency/outcome for the LLM agent stage.
    await withSpan('agent-run', {
      'job.queue': 'agent-run',
      'portal.hash': portalHash(data.memberId)
    }, () => handleAgentRunJob(data, agentRun), res => ({ 'job.ok': res.ok }))
  }, { connection, concurrency: cc.agent })

  const crm = new Worker(QUEUES.crmSync, async (job) => {
    const data = job.data as CrmSyncJob
    // Job-level trace span (телеметрия) — no-op unless telemetry is on. Only SAFE shape/outcome
    // attributes (counts, hashed portal); never document / supplier / product content.
    await withSpan('crm-sync', {
      'job.queue': 'crm-sync',
      'portal.hash': portalHash(data.memberId)
    }, () => handleCrmSyncJob(data, crmSync), result => result
      ? {
          'proc.created': result.created,
          'proc.lines': result.rowCount,
          'proc.unmatched': result.unmatched,
          'proc.idempotent': result.idempotent,
          'proc.warnings': result.warnings.length,
          'proc.errors': result.errors.length
        }
      : {})
    // Lock tuning shrinks the stalled-reprocessing window that could duplicate a CRM entity
    // (#163) — see crmLockTuning above for why a pg advisory lock was rejected (pool max 5).
  }, { connection, concurrency: cc.crm, ...crmLockTuning() })

  // On PERMANENT failure (retries exhausted), guarantee a terminal status the /status
  // view can show, and drop the uploaded bytes (an unhandled throw skipped cleanup).
  onExhausted(extract, infra, job => cleanupUpload(job as ExtractJob))
  onExhausted(agent, infra)
  onExhausted(crm, infra)

  return [extract, agent, crm]
}

/** Attach a permanent-failure handler that finalises the job status + optional cleanup. */
function onExhausted(worker: Worker, infra: LiveInfra, cleanup?: (data: { memberId: string, jobId: string }) => Promise<void>): void {
  worker.on('failed', async (job, err) => {
    if (!job) return
    const attempts = job.opts?.attempts ?? 1
    if ((job.attemptsMade ?? 0) < attempts) return // more retries pending
    const data = job.data as { memberId?: string, jobId?: string }
    if (!data?.memberId || !data?.jobId) return
    const reason = `сбой обработки: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`
    await setJobStatus(data.memberId, data.jobId, 'error', reason, infra.query).catch(() => {})
    if (cleanup) await cleanup({ memberId: data.memberId, jobId: data.jobId }).catch(() => {})
  })
}

/** Drop the uploaded bytes once text is extracted (data minimisation). */
async function cleanupUpload(job: ExtractJob): Promise<void> {
  const { uploadPath } = await import('../utils/fileStore')
  await unlink(uploadPath(job.memberId, job.jobId)).catch(() => {})
}
