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
    await handleEventJob(job.data as EventJob, eventDeps)
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
    // Handled failures set 'error' and return; only an infra throw propagates (→ retry).
    await handleFileExtractJob(job.data as ExtractJob, fileExtract)
    await cleanupUpload(job.data as ExtractJob) // success/handled-fail path
  }, { connection, concurrency: cc.extract })

  const agent = new Worker(QUEUES.agent, async (job) => {
    await handleAgentRunJob(job.data as AgentJob, agentRun)
  }, { connection, concurrency: cc.agent })

  const crm = new Worker(QUEUES.crmSync, async (job) => {
    await handleCrmSyncJob(job.data as CrmSyncJob, crmSync)
  }, { connection, concurrency: cc.crm })

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
