import { entityOpenPath } from './configurableActivity'
import type { JobResultView } from '~/utils/jobStatus'

// Resolve the link to the CRM entity a job created, for the «сотрудник» feedback issue (#192 п.2).
// The entity is resolved SERVER-SIDE from the job's stored result (durable — survives the client),
// not trusted from the browser. Pure: parsing/labels/URL are testable without a DB or portal.

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
  const path = entityOpenPath(entityTypeId!, entityId!)
  const host = typeof domain === 'string' ? domain.trim() : ''
  const entityUrl = host ? `https://${host}${path}` : path
  return { entityType: entityTypeLabel(entityTypeId!), entityId: String(entityId), entityUrl }
}
