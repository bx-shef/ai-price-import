import type { RestCall } from './b24Rest'

// Backend core for the units-dictionary editor (settings form): list a portal's catalog
// measures so the admin can map a document unit synonym ("м", "кг") to a real measure CODE.
// Pure over the injected `call`; the route binds the portal transport + identity.
//
// The stored value is the measure `code` (UNECE Rec-20 / ОКЕИ numeric code, e.g. 796 = штука,
// 6 = метр) — the same thing resolveMeasure returns and crm.item.productrow's measureCode wants
// (matches the app's `defaultCode: 796` convention).
//
// Method: the modern, NON-deprecated `catalog.measure.list`. LIVE-VERIFIED on real portals that it
// returns `measureTitle: null, symbol: null` for the built-in SYSTEM measures (штука/кг/метр/…) —
// their Russian names/symbols live in Bitrix's LANGUAGE FILES, not in the DB row, so the REST method
// exposes only `symbolIntl`/`symbolLetterIntl` («pc.»/«PCE»). (The deprecated `crm.measure.list` did
// return the localized `SYMBOL_RUS`, but we don't depend on a deprecated method.) To still show «шт»
// instead of «pc.» — and, crucially, to let the auto-create index match a document's «шт»/«кг» against
// an existing measure — we enrich each row from a static ОКЕИ code→Russian map (`SYSTEM_MEASURE_RU`)
// when the API's title/symbol come back empty. CUSTOM measures (admin-created via catalog.measure.add)
// carry their own non-null title/symbol and are used as-is.
// Envelope: this app's RestCall unwraps to `result`; catalog.measure.list returns `{ measures: [...] }`
// (older/other portals may return a bare array) — normalizeMeasures accepts both.

/**
 * Russian name + conditional symbol for the standard ОКЕИ / Bitrix built-in measure codes. Used only
 * to fill in labels the modern `catalog.measure.list` leaves null for SYSTEM measures. The 5 Bitrix
 * defaults (6/112/163/166/796) are LIVE-VERIFIED (symbols exactly as the portal renders them, incl.
 * «л.» with a dot); the rest are common ОКЕИ codes with their standard Russian abbreviations. A code
 * not in this map (a non-standard system measure) just falls back to the international symbol.
 */
export const SYSTEM_MEASURE_RU: Record<number, { title: string, symbol: string }> = {
  6: { title: 'Метр', symbol: 'м' },
  55: { title: 'Квадратный метр', symbol: 'м²' },
  112: { title: 'Литр', symbol: 'л.' },
  113: { title: 'Кубический метр', symbol: 'м³' },
  163: { title: 'Грамм', symbol: 'г' },
  166: { title: 'Килограмм', symbol: 'кг' },
  168: { title: 'Тонна', symbol: 'т' },
  657: { title: 'Изделие', symbol: 'изд' },
  715: { title: 'Пара', symbol: 'пар' },
  736: { title: 'Рулон', symbol: 'рул' },
  778: { title: 'Упаковка', symbol: 'упак' },
  796: { title: 'Штука', symbol: 'шт' }
}

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

/**
 * Enrich a raw measure row with the Russian title/symbol from `SYSTEM_MEASURE_RU` when the API left
 * them empty (a built-in system measure). Custom measures keep their own values. Adds `measureTitle`
 * and `symbol` (camelCase, the shape both measureLabel and the auto-create index read) so the rest of
 * the pipeline is source-agnostic. Pure — returns a shallow copy.
 */
export function enrichMeasureRow(row: Record<string, unknown>): Record<string, unknown> {
  const code = codeOf(row.code ?? row.CODE)
  if (code === null) return row
  const hasTitle = firstNonEmpty([row.measureTitle, row.MEASURE_TITLE])
  const hasSymbol = firstNonEmpty([row.symbol, row.SYMBOL, row.symbolRus, row.SYMBOL_RUS])
  if (hasTitle && hasSymbol) return row // custom / already localized
  const ru = SYSTEM_MEASURE_RU[code]
  if (!ru) return row // unknown system code → falls back to symbolIntl in measureLabel
  return {
    ...row,
    ...(hasTitle ? {} : { measureTitle: ru.title }),
    ...(hasSymbol ? {} : { symbol: ru.symbol })
  }
}

/** Build a readable label from the measure's name + symbol (falls back to the code). Prefers the
 *  RUSSIAN symbol (условное обозначение) over the international one (SYMBOL_INTL, e.g. «pc.») — owner
 *  ask: show «шт», not «pc.». Tolerates camelCase, B24 uppercase, and the enriched fields. */
function measureLabel(row: Record<string, unknown>, code: number): string {
  const title = String(row.measureTitle ?? row.MEASURE_TITLE ?? '').trim()
  const symbol = firstNonEmpty([
    row.symbol, row.SYMBOL, row.symbolRus, row.SYMBOL_RUS, // Russian / enriched — preferred
    row.symbolIntl, row.SYMBOL_INTL // international (pc.) — last resort only
  ])
  if (title && symbol) return `${title} (${symbol})`
  return title || symbol || `код ${code}`
}

/** Normalize a catalog.measure.list result (array OR { measures:[] }) → sorted options. Enriches each
 *  row so system measures carry the Russian label. */
export function normalizeMeasures(result: unknown): MeasureOption[] {
  const items: MeasureOption[] = []
  const seen = new Set<number>()
  for (const raw of measureRowsOf(result)) {
    if (!raw || typeof raw !== 'object') continue
    const row = enrichMeasureRow(raw as Record<string, unknown>)
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

/** Unwrap a catalog.measure.list result to the row array (accepts a bare array OR `{ measures:[] }`). */
function measureRowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  const wrapped = (result as Record<string, unknown>)?.measures
  return Array.isArray(wrapped) ? wrapped : []
}

/** List the portal's measures via `catalog.measure.list` (non-deprecated); system measures are enriched
 *  with the Russian label from SYSTEM_MEASURE_RU (the API returns null for them). Pure otherwise; a REST
 *  error propagates. */
export async function listMeasures(call: RestCall): Promise<MeasureOption[]> {
  const result = await call('catalog.measure.list', {})
  return normalizeMeasures(result)
}

/** Raw measure rows for the auto-create index — via `catalog.measure.list`, each **enriched** so a
 *  document unit like «рулон»/«шт» matches an existing system measure (the modern method's title/symbol
 *  are null for built-ins; without enrichment the index keys would all be null and every unit would
 *  auto-create or fall to the default, Q11). */
export async function fetchMeasureRows(call: RestCall): Promise<Array<Record<string, unknown>>> {
  const result = await call('catalog.measure.list', {})
  return measureRowsOf(result)
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map(enrichMeasureRow)
}
