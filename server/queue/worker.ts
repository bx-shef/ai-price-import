import { Worker } from 'bullmq'
import { unlink } from 'node:fs/promises'
import { connectionOptions } from './connection'
import { QUEUES } from './topology'
import type { AgentJob, CrmSyncJob, ExtractJob } from './topology'
import { handleAgentRunJob, handleCrmSyncJob, handleFileExtractJob } from './handlers'
import { liveAgentRunDeps, liveCrmSyncHandlerDeps, liveFileExtractDeps, type LiveInfra } from './liveDeps'
import { setJobStatus } from '../utils/jobStore'
import { query } from '../db/client'
import { makeAgentSpawn } from '../agent/spawn'
import { liveExtractRunners } from '../utils/extractRunners'
import type { FetchFn } from '../utils/b24Rest'

// BullMQ workers binding the pure handlers to live infra. Thin glue — the logic lives
// in the (tested) handlers; validated by typecheck. Started in-process by the queue plugin.

/** Assemble LiveInfra from the environment (the single place pipeline secrets are read). */
export function buildLiveInfra(): LiveInfra {
  return {
    query,
    fetchFn: globalThis.fetch as unknown as FetchFn,
    encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
    clientId: process.env.B24_CLIENT_ID ?? '',
    clientSecret: process.env.B24_CLIENT_SECRET ?? '',
    now: () => Date.now(),
    // Agent runs with a SANITIZED env (no backend secrets) — see agentSpawnEnv.
    agentSpawn: makeAgentSpawn(),
    runners: liveExtractRunners
  }
}

/** Start the extract/agent/crm-sync workers. Returns [] when Redis is not configured. */
export function startWorkers(infra: LiveInfra = buildLiveInfra()): Worker[] {
  const connection = connectionOptions()
  if (!connection) return []

  const fileExtract = liveFileExtractDeps(infra)
  const agentRun = liveAgentRunDeps(infra)
  const crmSync = liveCrmSyncHandlerDeps(infra)

  const extract = new Worker(QUEUES.extract, async (job) => {
    // Handled failures set 'error' and return; only an infra throw propagates (→ retry).
    await handleFileExtractJob(job.data as ExtractJob, fileExtract)
    await cleanupUpload(job.data as ExtractJob) // success/handled-fail path
  }, { connection, concurrency: 4 })

  const agent = new Worker(QUEUES.agent, async (job) => {
    await handleAgentRunJob(job.data as AgentJob, agentRun)
  }, { connection, concurrency: 2 })

  const crm = new Worker(QUEUES.crmSync, async (job) => {
    await handleCrmSyncJob(job.data as CrmSyncJob, crmSync)
  }, { connection, concurrency: 4 })

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
