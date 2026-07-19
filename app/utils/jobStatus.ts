// Pure presentation model for import-job status (used by the /app upload/status UI).
// Mirrors server JobStatus; keeps label/tone/terminal logic testable and out of components.

export type JobStatus = 'queued' | 'extracting' | 'processing' | 'done' | 'error'

export type StatusTone = 'neutral' | 'info' | 'success' | 'danger'

export interface JobStatusMeta { label: string, tone: StatusTone, terminal: boolean }

/** Human label + tone + whether the job has finished, for any status string. */
export function jobStatusMeta(status: string): JobStatusMeta {
  switch (status) {
    case 'queued': return { label: 'В очереди', tone: 'neutral', terminal: false }
    case 'extracting': return { label: 'Извлечение текста', tone: 'info', terminal: false }
    case 'processing': return { label: 'Распознавание и запись', tone: 'info', terminal: false }
    case 'done': return { label: 'Готово', tone: 'success', terminal: true }
    case 'error': return { label: 'Ошибка', tone: 'danger', terminal: true }
    default: return { label: status || 'неизвестно', tone: 'neutral', terminal: false }
  }
}

export interface JobResultView {
  /** CRM entity type id of the created entity (deal 2 / lead 1 / smart-process …), when known. */
  entityTypeId?: number
  entityId?: number
  created?: boolean
  warnings: string[]
  errors: string[]
  /** Plain-text message when the result column holds a bare error string, not JSON. */
  message?: string
}

/**
 * Parse the job `result` column into a view model. crm-sync writes JSON
 * ({entityTypeId, entityId, created, warnings, errors}); earlier stages write a bare error
 * string. Never throws — a non-JSON result becomes `message`.
 */
export function parseJobResult(result: string): JobResultView {
  const raw = (result ?? '').trim()
  if (!raw) return { warnings: [], errors: [] }
  if (raw[0] !== '{') return { warnings: [], errors: [], message: raw }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      ...(typeof o.entityTypeId === 'number' && o.entityTypeId > 0 ? { entityTypeId: o.entityTypeId } : {}),
      ...(typeof o.entityId === 'number' && o.entityId > 0 ? { entityId: o.entityId } : {}),
      ...(typeof o.created === 'boolean' ? { created: o.created } : {}),
      warnings: Array.isArray(o.warnings) ? o.warnings.map(String) : [],
      errors: Array.isArray(o.errors) ? o.errors.map(String) : []
    }
  } catch {
    return { warnings: [], errors: [], message: raw }
  }
}
