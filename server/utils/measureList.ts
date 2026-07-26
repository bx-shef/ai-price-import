import type { RestCall } from './b24Rest'

// Backend core for the units-dictionary editor (settings form): list a portal's catalog
// measures so the admin can map a document unit synonym ("м", "кг") to a real measure CODE.
// Pure over the injected `call`; the route binds the portal transport + identity.
//
// The stored value is the measure `code` (UNECE Rec-20 numeric code, e.g. 796 = штука,
// 006 = метр) — the same thing resolveMeasure returns and crm.item.productrow's measureCode
// wants (matches the app's `defaultCode: 796` convention).
//
// Method: the CLASSIC `crm.measure.list` (NOT the modern `catalog.measure.list`). LIVE-VERIFIED on
// bel.bitrix24.by that `catalog.measure.list` returns `measureTitle:null, symbol:null` and ONLY the
// international `symbolIntl` («pc.»/«kg») — so the Russian name/symbol («Метр»/«шт.») is unavailable and
// the label degrades to «pc. 1» (defeating the owner's «show шт, not pc.» ask AND breaking unit matching
// in the auto-create index, whose title/symbol keys would all be null). `crm.measure.list` returns the
// full classic row `{ID, CODE, MEASURE_TITLE, SYMBOL_RUS, SYMBOL_INTL, …}`. Both read the same underlying
// measure table, so a measure created via `catalog.measure.add` still appears here.
// Envelope: this app's RestCall unwraps to `result`; crm.measure.list returns a flat array (older/other
// portals may wrap as `{ measures: [...] }`) — normalizeMeasures accepts both.

/** One pickable measure: `value` is the numeric code (as a string, for the b24ui Select),
 *  `label` a human name. The index signature keeps it assignable to a Select item row. */
export interface MeasureOption {
  value: string
  label: string
  [key: string]: unknown
}

/** First non-empty string among the candidates (trimmed), or ''. */
function firstNonEmpty(vals: unknown[]): string {
  for (const v of vals) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (s) return s
  }
  return ''
}

/** Build a readable label from the measure's name + symbol (falls back to the code). Prefer the
 *  RUSSIAN symbol (Условное обозначение, SYMBOL_RUS) over the international one (SYMBOL_INTL, e.g.
 *  «pc.») — owner ask: show «шт», not «pc.». Tolerates both camelCase and B24's uppercase field forms. */
function measureLabel(row: Record<string, unknown>, code: number): string {
  const title = String(row.measureTitle ?? row.MEASURE_TITLE ?? '').trim()
  const symbol = firstNonEmpty([
    row.symbolRus, row.SYMBOL_RUS, // Russian symbol (Условное обозначение) — preferred
    row.symbol, row.SYMBOL, // generic (some portals hold the Russian one here)
    row.symbolIntl, row.SYMBOL_INTL // international (pc.) — last resort only
  ])
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

/** List the portal's measures. Uses `crm.measure.list` (classic) so labels carry the RUSSIAN name +
 *  symbol (MEASURE_TITLE/SYMBOL_RUS) — see the file note. Pure otherwise; a REST error propagates. */
export async function listMeasures(call: RestCall): Promise<MeasureOption[]> {
  const result = await call('crm.measure.list', {})
  return normalizeMeasures(result)
}

/** Raw measure rows (title/symbol/code) for the auto-create index. `crm.measure.list` (classic) so the
 *  index keys on the Russian title/symbol — otherwise a document unit like «рулон»/«шт» never matches an
 *  existing measure (the modern method's title/symbol are null on real portals) and every unit
 *  auto-creates or falls to the default (Q11). */
export async function fetchMeasureRows(call: RestCall): Promise<Array<Record<string, unknown>>> {
  const result = await call('crm.measure.list', {})
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>
  const wrapped = (result as Record<string, unknown>)?.measures
  return Array.isArray(wrapped) ? wrapped as Array<Record<string, unknown>> : []
}
