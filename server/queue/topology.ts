// Pure queue contracts: names, job payloads, deterministic idempotent job ids.
// Transport (BullMQ/Redis) lives in connection/producers/worker. See docs/redesign 02 §4.

export const QUEUES = {
  events: 'b24-events',
  extract: 'file-extract',
  agent: 'agent-run',
  crmSync: 'crm-sync'
} as const

export type QueueName = typeof QUEUES[keyof typeof QUEUES]

export interface EventJob { memberId: string, event: string, domain: string }
export interface ExtractJob { memberId: string, jobId: string, fileId: string }
// The extracted DOCUMENT_TEXT is stored scoped by jobId (Postgres/disk), NOT inlined
// in the payload — queue records must not hold full document text (docs/redesign 02 §7.3, 05).
export interface AgentJob { memberId: string, jobId: string }
export interface CrmSyncJob { memberId: string, jobId: string }

/** Build a deterministic BullMQ job id. Uses `|` (BullMQ forbids `:`), so retries dedupe. */
export function makeJobId(...parts: Array<string | number>): string {
  return parts.map(p => String(p).replace(/[|:]/g, '_')).join('|')
}

export const eventJobId = (memberId: string, event: string, ts: string | number) => makeJobId('ev', memberId, event, ts)
export const extractJobId = (memberId: string, jobId: string) => makeJobId('ex', memberId, jobId)
export const agentJobId = (memberId: string, jobId: string) => makeJobId('ag', memberId, jobId)
export const crmSyncJobId = (memberId: string, jobId: string) => makeJobId('cs', memberId, jobId)
