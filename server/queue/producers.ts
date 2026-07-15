import { getQueue } from './connection'
import { type AgentJob, agentJobId, type CrmSyncJob, crmSyncJobId, type EventJob, eventJobId, type ExtractJob, extractJobId, QUEUES } from './topology'

// Producers: enqueue jobs with deterministic idempotent ids. No-op without Redis.

// `b24-events`: the webhook route (`server/api/b24/events.post.ts`) verifies the event
// then ENQUEUES it; the consumer (worker.ts startEventWorker → handleEventJob), running on
// the SINGLE primary instance, is the single writer of portal_tokens. Because B24 does not
// retry online events, the route falls back to a synchronous write when Redis is
// unavailable (queueEnabled() false) or the enqueue throws.
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
