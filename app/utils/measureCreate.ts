// Pure core for auto-creating a Bitrix24 catalog measure (единица измерения) from a document unit
// that the portal dictionary doesn't map (Q11, opt-in `mapping.units.autoCreate`). The transport
// (catalog.measure.add) lives in server/utils/measureCreateWrite.ts; here we keep the pure, tested
// pieces: a sanity gate (so OCR noise doesn't litter the client's catalog), a code allocator, and
// the add-params builder. See docs/redesign/02-target-architecture.md (Q11).

/** Max length of a unit string we're willing to turn into a catalog measure. */
export const MAX_MEASURE_UNIT_LEN = 20
/** Floor for an allocated code — kept clear of the low OKEI standard range to cut collisions. */
export const MEASURE_CODE_FLOOR = 1000

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

/**
 * Pick a fresh integer code above every existing code and the floor. `catalog.measure.add` requires
 * a unique code; the transport still retries on a collision (an inactive standard code not in the
 * active list), but starting above max(existing) makes a collision unlikely.
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
