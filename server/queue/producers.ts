import { getQueue } from './connection'
import { type AgentJob, agentJobId, type CrmSyncJob, crmSyncJobId, type EventJob, eventJobId, type ExtractJob, extractJobId, QUEUES } from './topology'

// Producers: enqueue jobs with deterministic idempotent ids. No-op without Redis.

// NOTE: `enqueueEvent`/`b24-events` is RESERVED scaffolding — the design (02 §Потоки)
// keeps a queue for install/uninstall, but the current webhook route
// (`server/api/b24/events.post.ts`) handles ONAPPINSTALL/ONAPPUNINSTALL SYNCHRONOUSLY
// (online events are not retried, so a queue hop could lose them). No consumer is wired
// yet; kept for parity with the sibling `bx-synapse` model and a future async switch.
export async function enqueueEvent(job: EventJob, ts: string | number): Promise<void> {
  await getQueue(QUEUES.events)?.add('event', job, { jobId: eventJobId(job.memberId, job.event, ts) })
}
export async function enqueueExtract(job: ExtractJob): Promise<void> {
  await getQueue(QUEUES.extract)?.add('extract', job, { jobId: extractJobId(job.memberId, job.jobId) })
}
export async function enqueueAgent(job: AgentJob): Promise<void> {
  await getQueue(QUEUES.agent)?.add('agent', job, { jobId: agentJobId(job.memberId, job.jobId) })
}
export async function enqueueCrmSync(job: CrmSyncJob): Promise<void> {
  await getQueue(QUEUES.crmSync)?.add('crm-sync', job, { jobId: crmSyncJobId(job.memberId, job.jobId) })
}
