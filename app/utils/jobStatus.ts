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
  /** Recognised supplier name (from the document) — for the «разбор» line. */
  supplier?: string
  /** Product lines actually written. */
  lines?: number
  warnings: string[]
  errors: string[]
  /** Plain-text message when the result column holds a bare error string, not JSON. */
  message?: string
}

/** Russian plural: pick [one, few, many] by n (1 позиция / 2 позиции / 5 позиций). */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100
  const d = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (d > 1 && d < 5) return forms[1]
  if (d === 1) return forms[0]
  return forms[2]
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
      ...(typeof o.supplier === 'string' && o.supplier.trim() ? { supplier: o.supplier.trim() } : {}),
      ...(typeof o.lines === 'number' && o.lines >= 0 ? { lines: o.lines } : {}),
      warnings: Array.isArray(o.warnings) ? o.warnings.map(String) : [],
      errors: Array.isArray(o.errors) ? o.errors.map(String) : []
    }
  } catch {
    return { warnings: [], errors: [], message: raw }
  }
}
