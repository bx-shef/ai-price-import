import { entityOpenPath } from './configurableActivity'
import { jobStatusMeta } from '~/utils/jobStatus'
import type { JobResultView } from '~/utils/jobStatus'

// Resolve SERVER-SIDE context for the «сотрудник» feedback issue from the job's stored state — the
// created entity link (#192 п.2), the triage outcome (#192 п.1) and the source-file link (#192 п.3).
// Everything is derived from the durable job row (not trusted from the browser). Pure: parsing /
// labels / URL building are testable without a DB or portal.

/** Human labels for the entity types we create (see crmWrite.ownerTypeCode). */
const ENTITY_LABELS: Record<number, string> = {
  1: 'Лид',
  2: 'Сделка',
  7: 'Предложение',
  31: 'Счёт'
}

/** Russian label for an entity type id; smart-processes (>=1000, or any unmapped) fall back. */
export function entityTypeLabel(entityTypeId: number): string {
  return ENTITY_LABELS[entityTypeId] ?? `Смарт-процесс (тип ${entityTypeId})`
}

/**
 * Absolutise a same-portal RELATIVE path against the frame-verified portal `domain`. Returns the
 * relative path unchanged when the domain is empty/non-string (safe fallback). The result is rendered
 * INERT by the issue builder (inline code), so it is a copyable reference, not a live link.
 */
export function absPortalUrl(path: string, domain: unknown): string {
  const host = typeof domain === 'string' ? domain.trim() : ''
  return host ? `https://${host}${path}` : path
}

/** Feedback-issue context fields describing the created entity (all absent when nothing created). */
export interface FeedbackEntityContext {
  entityType?: string
  entityId?: string
  entityUrl?: string
}

/**
 * Build the entity-link context for a feedback issue from a parsed job result + the portal domain.
 * Returns {} unless the job actually CREATED an entity with a usable type+id — an abandoned/errored
 * or not-yet-finished job carries no link. `domain` is the frame-verified portal host, so the
 * absolute URL stays on-portal; it is rendered INERT (inline code) by the issue builder, so it is a
 * copyable reference, not a live link. Falls back to a relative path when domain is empty.
 */
export function resolveFeedbackEntity(view: JobResultView, domain: unknown): FeedbackEntityContext {
  if (view.created !== true) return {}
  const entityId = view.entityId
  const entityTypeId = view.entityTypeId
  if (!Number.isInteger(entityId) || (entityId ?? 0) <= 0) return {}
  if (!Number.isInteger(entityTypeId) || (entityTypeId ?? 0) <= 0) return {}
  const entityUrl = absPortalUrl(entityOpenPath(entityTypeId!, entityId!), domain)
  return { entityType: entityTypeLabel(entityTypeId!), entityId: String(entityId), entityUrl }
}

/** Triage outcome fields for the issue (#192 п.1). */
export interface FeedbackOutcome {
  status?: string
  outcome?: string
  notes?: string
}

/**
 * Summarise how a job's processing ended, for the feedback issue (#192 п.1): the human status
 * (Готово / Ошибка / В обработке), whether a CRM entity was created, and the агент/crm-sync notes
 * (warnings + errors, or a bare error message). `notes` is untrusted-ish text → the issue builder
 * renders it INERT (hostile-stripped + escaped + capped), so raw joining here is safe. Absent fields
 * are omitted by the builder.
 */
export function resolveFeedbackOutcome(view: JobResultView, status: string): FeedbackOutcome {
  const meta = jobStatusMeta(status)
  const out: FeedbackOutcome = { status: meta.label }
  // A bare error string (a pre-crm-sync failure: extraction/agent) has no structured result.
  if (view.message) {
    return { status: out.status, outcome: 'Ошибка обработки', notes: view.message }
  }
  // Terminal crm-sync result → say whether the entity was created. Non-terminal (queued/…) → no
  // outcome yet (the employee can still leave a 👍/👎 on an in-flight run).
  if (meta.terminal && typeof view.created === 'boolean') {
    out.outcome = view.created ? 'Сущность создана' : 'Сущность не создана'
  }
  const notes = [...view.warnings, ...view.errors].filter(Boolean).join('; ')
  if (notes) out.notes = notes
  return out
}
