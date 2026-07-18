// Pure core for auto-creating a Bitrix24 catalog measure (единица измерения) from a document unit
// that the portal dictionary doesn't map (Q11, opt-in `mapping.units.autoCreate`). The transport
// (catalog.measure.add) lives in server/utils/measureCreateWrite.ts; here we keep the pure, tested
// pieces: a sanity gate (so OCR noise doesn't litter the client's catalog), a title index for
// FIND-before-create (so a unit already present in the catalog is reused, not duplicated), a code
// allocator, and the add-params builder. See docs/redesign/02-target-architecture.md (Q11).

/** Max length of a unit string we're willing to turn into a catalog measure. */
export const MAX_MEASURE_UNIT_LEN = 20
/** Floor for an allocated code — kept clear of the low OKEI standard range to cut collisions. */
export const MEASURE_CODE_FLOOR = 1000
/** Cap on DISTINCT measures one import job may auto-create — anti-flooding for a hostile document. */
export const MAX_AUTO_MEASURES_PER_JOB = 30

/** Normalize a unit for matching/caching: trim, lowercase, collapse internal whitespace. Shared by
 *  the find-before-create index and the per-job cache so "шт " and "шт" don't diverge. */
export function normalizeUnitKey(unit: string | undefined): string {
  return (unit ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Whether a document unit is sane enough to auto-create a catalog measure from it. Gate against OCR
 * noise: trimmed, 1..MAX_MEASURE_UNIT_LEN chars, must contain at least one letter (Latin/Cyrillic),
 * and only letters/digits/space and a few unit punctuation chars (`.`, `/`, `-`, `²`, `³`, `%`). A
 * string of pure symbols/digits or an over-long blob is rejected → caller falls back to the default.
 */
export function isCreatableUnit(unit: string | undefined): boolean {
  const u = (unit ?? '').trim()
  if (u.length < 1 || u.length > MAX_MEASURE_UNIT_LEN) return false
  if (!/[A-Za-zА-Яа-яЁё]/.test(u)) return false // must have a letter (not "12", "%%")
  return /^[A-Za-zА-Яа-яЁё0-9 ./²³%-]+$/.test(u)
}

/** An index of a portal's existing measures: all codes (for allocation) + a normalized
 *  title/symbol → code map (for find-before-create). */
export interface MeasureIndex {
  codes: number[]
  byName: Map<string, number>
}

/** Build a MeasureIndex from raw catalog.measure rows (tolerates the field-name variants B24 uses).
 *  Both the title and the symbol are indexed so a document unit like "шт" matches either. */
export function buildMeasureIndex(rows: Array<Record<string, unknown>>): MeasureIndex {
  const codes: number[] = []
  const byName = new Map<string, number>()
  for (const row of rows) {
    const code = codeOf(row.code ?? row.CODE)
    if (code === null) continue
    codes.push(code)
    for (const field of [row.measureTitle, row.MEASURE_TITLE, row.symbol, row.SYMBOL, row.symbolIntl, row.SYMBOL_INTL]) {
      const key = normalizeUnitKey(typeof field === 'string' ? field : undefined)
      if (key && !byName.has(key)) byName.set(key, code) // first (lowest-listed) code wins on a tie
    }
  }
  return { codes, byName }
}

/** Reuse an existing measure code when the unit already names one (find-before-create). */
export function lookupExistingMeasure(unit: string, index: MeasureIndex): number | null {
  return index.byName.get(normalizeUnitKey(unit)) ?? null
}

/**
 * Pick a fresh integer code above every existing code and the floor. `catalog.measure.add` requires
 * a unique code; the transport still retries on a collision (a concurrent create), but starting
 * above max(existing) makes a collision unlikely.
 */
export function nextMeasureCode(existingCodes: number[]): number {
  let max = MEASURE_CODE_FLOOR - 1
  for (const c of existingCodes) {
    if (Number.isInteger(c) && c > max) max = c
  }
  return max + 1
}

/** Build the `catalog.measure.add` params for a unit + allocated code (title/symbol = the unit). */
export function buildMeasureAddParams(unit: string, code: number): { fields: Record<string, unknown> } {
  const label = unit.trim().slice(0, MAX_MEASURE_UNIT_LEN)
  return {
    fields: {
      code,
      measureTitle: label,
      symbol: label,
      isDefault: 'N' // never steal the portal's default-measure flag
    }
  }
}

/** Coerce to a positive integer code or null. */
function codeOf(code: unknown): number | null {
  const n = typeof code === 'number' ? code : Number(code)
  return Number.isInteger(n) && n > 0 ? n : null
}
