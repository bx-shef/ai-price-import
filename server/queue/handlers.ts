import type { CrmSyncJob } from './topology'
import type { CrmSyncDeps, CrmSyncResult } from './crmSyncCore'
import { runCrmSync } from './crmSyncCore'
import type { PortalMapping } from '~/types/mapping'
import type { ExtractedDocument } from '~/types/document'
import type { RoutingSignals } from '~/utils/routing'

// Pure job handlers with DI. Live transports (REST/MCP/DB) are injected in worker.ts;
// tests inject fakes. See docs/redesign 02 §4.

export interface HandlerDeps {
  /** Load the portal mapping (from app.option) for a portal. */
  getMapping: (memberId: string) => Promise<PortalMapping>
  /** Load the extracted document + routing signals for a job (stored by agent-run). */
  getDocument: (memberId: string, jobId: string) => Promise<{ doc: ExtractedDocument, signals: RoutingSignals } | null>
  /** Build the crm-sync deps bound to this portal/job (MCP tools). */
  crmSyncDeps: (memberId: string, jobId: string) => CrmSyncDeps
  /** Persist the job outcome. */
  setJobStatus: (memberId: string, jobId: string, status: 'done' | 'error', result: string) => Promise<void>
}

/** Handle a crm-sync job: load doc+mapping, run the pure orchestration, record status. */
export async function handleCrmSyncJob(job: CrmSyncJob, deps: HandlerDeps): Promise<CrmSyncResult | null> {
  const loaded = await deps.getDocument(job.memberId, job.jobId)
  if (!loaded) {
    await deps.setJobStatus(job.memberId, job.jobId, 'error', 'документ не найден')
    return null
  }
  const mapping = await deps.getMapping(job.memberId)
  const crmDeps = deps.crmSyncDeps(job.memberId, job.jobId)
  const result = await runCrmSync(job.jobId, loaded.doc, mapping, loaded.signals, crmDeps)
  await deps.setJobStatus(
    job.memberId, job.jobId,
    result.created || !result.errors.length ? 'done' : 'error',
    JSON.stringify({ entityId: result.entityId, created: result.created, warnings: result.warnings, errors: result.errors })
  )
  return result
}
