import { Worker } from 'bullmq'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { connectionOptions } from './connection'
import { QUEUES } from './topology'
import type { AgentJob, CrmSyncJob, ExtractJob } from './topology'
import { handleAgentRunJob, handleCrmSyncJob, handleFileExtractJob } from './handlers'
import { liveAgentRunDeps, liveCrmSyncHandlerDeps, liveFileExtractDeps, type LiveInfra } from './liveDeps'
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

  return [
    new Worker(QUEUES.extract, async (job) => {
      await handleFileExtractJob(job.data as ExtractJob, fileExtract)
      await cleanupUpload(job.data as ExtractJob)
    }, { connection, concurrency: 4 }),
    new Worker(QUEUES.agent, async (job) => {
      await handleAgentRunJob(job.data as AgentJob, agentRun)
    }, { connection, concurrency: 2 }),
    new Worker(QUEUES.crmSync, async (job) => {
      await handleCrmSyncJob(job.data as CrmSyncJob, crmSync)
    }, { connection, concurrency: 4 })
  ]
}

/** Drop the uploaded bytes once text is extracted (data minimisation). */
async function cleanupUpload(job: ExtractJob): Promise<void> {
  const { uploadPath } = await import('../utils/fileStore')
  await unlink(uploadPath(job.memberId, job.jobId)).catch(() => {})
}

/** node:fs FileIO for the upload store (used by the API upload handler). */
export const nodeFileIO = {
  mkdir: async (dir: string) => {
    await mkdir(dir, { recursive: true })
  },
  writeFile: async (path: string, data: Uint8Array) => {
    await writeFile(path, data)
  },
  unlink: async (path: string) => {
    await unlink(path)
  }
}
