import type { AgentJob, CrmSyncJob, ExtractJob } from './topology'
import type { CrmSyncDeps, CrmSyncResult } from './crmSyncCore'
import { runCrmSync } from './crmSyncCore'
import type { PortalMapping, TargetRef } from '~/types/mapping'
import type { ExtractedDocument } from '~/types/document'
import type { RoutingSignals } from '~/utils/routing'

// Pure job handlers with DI. Live transports (REST/MCP/DB) are injected in worker.ts;
// tests inject fakes. See docs/redesign 02 §4.

/** Text kept in the stored signals for keyword routing (the rest is dropped). */
export const MAX_ROUTING_TEXT = 131_072 // 128 KiB — routing keywords sit near the top

const msg = (e: unknown) => (e instanceof Error ? e.message : 'ошибка')

export interface HandlerDeps {
  /** Load the portal mapping (from app.option) for a portal. */
  getMapping: (memberId: string) => Promise<PortalMapping>
  /** Load the extracted document + routing signals for a job (stored by agent-run). */
  getDocument: (memberId: string, jobId: string) => Promise<{ doc: ExtractedDocument, signals: RoutingSignals } | null>
  /** Build the crm-sync deps bound to this portal/job/mapping (MCP tools). */
  crmSyncDeps: (memberId: string, jobId: string, mapping: PortalMapping) => CrmSyncDeps
  /** Persist the job outcome. */
  setJobStatus: (memberId: string, jobId: string, status: 'done' | 'error', result: string) => Promise<void>
  /**
   * Best-effort cleanup of the stored raw client document once the job is
   * terminal (data minimisation — docs/redesign 05). Optional: a failed sweep
   * must not fail the job. crm-sync does not retry, so the doc is safe to drop
   * after the status is recorded.
   */
  deleteDocument?: (memberId: string, jobId: string) => Promise<void>
}

/** Handle a crm-sync job: load doc+mapping, run the pure orchestration, record status. */
export async function handleCrmSyncJob(job: CrmSyncJob, deps: HandlerDeps): Promise<CrmSyncResult | null> {
  const loaded = await deps.getDocument(job.memberId, job.jobId)
  if (!loaded) {
    await deps.setJobStatus(job.memberId, job.jobId, 'error', 'документ не найден')
    return null
  }
  const mapping = await deps.getMapping(job.memberId)
  const crmDeps = deps.crmSyncDeps(job.memberId, job.jobId, mapping)
  const result = await runCrmSync(job.jobId, loaded.doc, mapping, loaded.signals, crmDeps)
  await deps.setJobStatus(
    job.memberId, job.jobId,
    result.created || !result.errors.length ? 'done' : 'error',
    JSON.stringify({ entityId: result.entityId, created: result.created, warnings: result.warnings, errors: result.errors })
  )
  // Terminal now (status recorded, no crm-sync retry) — drop the raw client
  // document. Best-effort: never fail the job on a cleanup error.
  if (deps.deleteDocument) {
    try {
      await deps.deleteDocument(job.memberId, job.jobId)
    } catch { /* retained rows are swept by a later TTL pass */ }
  }
  return result
}

// ── file-extract ────────────────────────────────────────────────────────────

/** Hard cap on extracted DOCUMENT_TEXT (memory / storage / LLM-cost DoS guard). */
export const MAX_DOCUMENT_TEXT = 500_000

export interface FileExtractDeps {
  /** Extract DOCUMENT_TEXT from the stored file (pdftotext / OCR / office). May throw. */
  extractText: (memberId: string, jobId: string, fileId: string) => Promise<string>
  /** Persist the raw text for agent-run (scoped by job). */
  saveText: (memberId: string, jobId: string, text: string) => Promise<void>
  enqueueAgentRun: (memberId: string, jobId: string) => Promise<void>
  /** Mark the job failed (records an error status the operator sees). */
  failJob: (memberId: string, jobId: string, reason: string) => Promise<void>
  /** Optional progress: mark the job 'extracting' at entry (UI stage indicator). */
  markExtracting?: (memberId: string, jobId: string) => Promise<void>
}

/** file-extract: file → text → enqueue agent-run. Empty/failed/oversized extraction fails the job. */
export async function handleFileExtractJob(job: ExtractJob, deps: FileExtractDeps): Promise<{ ok: boolean }> {
  await markProgress(deps.markExtracting, job.memberId, job.jobId)
  let text: string
  try {
    text = await deps.extractText(job.memberId, job.jobId, job.fileId)
  } catch (e) {
    await deps.failJob(job.memberId, job.jobId, `извлечение текста: ${msg(e)}`)
    return { ok: false }
  }
  if (!text.trim()) {
    await deps.failJob(job.memberId, job.jobId, 'пустой текст документа (файл не распознан)')
    return { ok: false }
  }
  // Loud failure, not silent truncation — dropping tail lines would break 1-в-1.
  if (text.length > MAX_DOCUMENT_TEXT) {
    await deps.failJob(job.memberId, job.jobId, `документ слишком большой (>${MAX_DOCUMENT_TEXT} символов) — разбейте на части`)
    return { ok: false }
  }
  await deps.saveText(job.memberId, job.jobId, text)
  await deps.enqueueAgentRun(job.memberId, job.jobId)
  return { ok: true }
}

// ── agent-run ─────────────────────────────────────────────────────────────────

export interface AgentRunDeps {
  /** Load the raw DOCUMENT_TEXT for the job (from file-extract). */
  getDocumentText: (memberId: string, jobId: string) => Promise<string | null>
  /** Run the extraction agent → validated document (null = nothing usable). */
  extractDocument: (documentText: string) => Promise<{ document: ExtractedDocument | null, error?: string }>
  /** Persist the extracted structure + routing signals for crm-sync. */
  saveDocument: (memberId: string, jobId: string, stored: { doc: ExtractedDocument, signals: RoutingSignals }) => Promise<void>
  enqueueCrmSync: (memberId: string, jobId: string) => Promise<void>
  failJob: (memberId: string, jobId: string, reason: string) => Promise<void>
  /** Optional: operator's manual target override chosen next to the file. */
  getManualOverride?: (memberId: string, jobId: string) => Promise<TargetRef | undefined>
  /** Optional best-effort: drop the raw text (on success AND on terminal failure). */
  deleteText?: (memberId: string, jobId: string) => Promise<void>
  /** Optional progress: mark the job 'processing' once extraction begins. */
  markProcessing?: (memberId: string, jobId: string) => Promise<void>
}

/** agent-run: text → extract structure → store {doc, signals} → enqueue crm-sync. */
export async function handleAgentRunJob(job: AgentJob, deps: AgentRunDeps): Promise<{ ok: boolean }> {
  const text = await deps.getDocumentText(job.memberId, job.jobId)
  if (!text) {
    await deps.failJob(job.memberId, job.jobId, 'текст документа не найден')
    return { ok: false }
  }
  await markProgress(deps.markProcessing, job.memberId, job.jobId)
  const { document, error } = await deps.extractDocument(text)
  if (!document) {
    await deps.failJob(job.memberId, job.jobId, error || 'не удалось извлечь документ')
    // Terminal extraction failure (re-extraction of the same text won't differ) →
    // drop the raw client text now; don't retain unrecognised documents.
    await dropText(deps.deleteText, job.memberId, job.jobId)
    return { ok: false }
  }
  const manualOverride = deps.getManualOverride ? await deps.getManualOverride(job.memberId, job.jobId) : undefined
  const signals: RoutingSignals = {
    ...(document.documentType ? { documentType: document.documentType } : {}),
    text: text.slice(0, MAX_ROUTING_TEXT),
    ...(manualOverride ? { manualOverride } : {})
  }
  await deps.saveDocument(job.memberId, job.jobId, { doc: document, signals })
  // Enqueue BEFORE dropping the text: if enqueue throws, the text survives for the
  // job retry (delete-then-enqueue would orphan the document on a transient blip).
  await deps.enqueueCrmSync(job.memberId, job.jobId)
  // Raw text now lives (bounded) in the doc payload → drop the standalone copy.
  await dropText(deps.deleteText, job.memberId, job.jobId)
  return { ok: true }
}

/** Best-effort progress marker — a failed status write must never fail the job. */
async function markProgress(fn: ((m: string, j: string) => Promise<void>) | undefined, memberId: string, jobId: string): Promise<void> {
  if (!fn) return
  try {
    await fn(memberId, jobId)
  } catch { /* progress is advisory */ }
}

/** Best-effort raw-text cleanup — a failed sweep must never fail the job. */
async function dropText(fn: ((m: string, j: string) => Promise<void>) | undefined, memberId: string, jobId: string): Promise<void> {
  if (!fn) return
  try {
    await fn(memberId, jobId)
  } catch { /* retained rows are purged on uninstall / swept by TTL */ }
}
