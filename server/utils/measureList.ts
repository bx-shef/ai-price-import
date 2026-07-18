import type { RestCall } from './b24Rest'

// Backend core for the units-dictionary editor (settings form): list a portal's catalog
// measures so the admin can map a document unit synonym ("м", "кг") to a real measure CODE.
// Pure over the injected `call`; the route binds the portal transport + identity.
//
// The stored value is the measure `code` (UNECE Rec-20 numeric code, e.g. 796 = штука,
// 006 = метр) — the same thing resolveMeasure returns and crm.item.productrow's measureCode
// wants (matches the app's `defaultCode: 796` convention).
//
// Envelope: this app's RestCall unwraps to `result`. catalog.measure.list returns the rows
// either directly as an array OR wrapped as `{ measures: [...] }` (B24 catalog list methods
// vary); normalizeMeasures accepts both.

/** One pickable measure: `value` is the numeric code (as a string, for the b24ui Select),
 *  `label` a human name. The index signature keeps it assignable to a Select item row. */
export interface MeasureOption {
  value: string
  label: string
  [key: string]: unknown
}

/** Build a readable label from the measure's name + symbol (falls back to the code). */
function measureLabel(row: Record<string, unknown>, code: number): string {
  const title = String(row.measureTitle ?? row.MEASURE_TITLE ?? '').trim()
  const symbol = String(row.symbol ?? row.symbolIntl ?? row.SYMBOL ?? row.SYMBOL_INTL ?? '').trim()
  if (title && symbol) return `${title} (${symbol})`
  return title || symbol || `код ${code}`
}

/** Normalize a catalog.measure.list result (array OR { measures:[] }) → sorted options. */
export function normalizeMeasures(result: unknown): MeasureOption[] {
  const rows = Array.isArray(result)
    ? result as unknown[]
    : Array.isArray((result as Record<string, unknown>)?.measures)
      ? (result as { measures: unknown[] }).measures
      : []
  const items: MeasureOption[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const code = codeOf(row.code ?? row.CODE)
    if (code === null || seen.has(code)) continue
    seen.add(code)
    items.push({ value: String(code), label: measureLabel(row, code) })
  }
  // Stable, name-sorted for a predictable dropdown.
  items.sort((a, b) => a.label.localeCompare(b.label, 'ru'))
  return items
}

/** Coerce to a positive integer code or null. */
function codeOf(code: unknown): number | null {
  const n = typeof code === 'number' ? code : Number(code)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** List the portal's measures (active only). Pure otherwise; a REST error propagates. */
export async function listMeasures(call: RestCall): Promise<MeasureOption[]> {
  const result = await call('catalog.measure.list', {
    select: ['code', 'measureTitle', 'symbol', 'symbolIntl', 'isDefault'],
    filter: { active: 'Y' }
  })
  return normalizeMeasures(result)
}

/** Raw measure rows (title/symbol/code) for the auto-create index — NO active filter, so the code
 *  allocator sees every existing code and find-before-create matches any measure (Q11). */
export async function fetchMeasureRows(call: RestCall): Promise<Array<Record<string, unknown>>> {
  const result = await call('catalog.measure.list', {
    select: ['code', 'measureTitle', 'symbol', 'symbolIntl']
  })
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>
  const wrapped = (result as Record<string, unknown>)?.measures
  return Array.isArray(wrapped) ? wrapped as Array<Record<string, unknown>> : []
}
