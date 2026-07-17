// Pure record↔rows logic for the units-dictionary editor (settings form). The stored shape is
// a `Record<unit, measureCode>` (units.dictionary); the editor works on an ordered array of rows.
// Keeping the conversion pure + tested keeps the Vue component thin (it only manages reactive
// state + stable keys). Mirrors parsePortalSettings' normalization (lowercase key, numeric code).

/** One editable row: a document unit synonym → chosen measure code (null while unset). */
export interface UnitRow {
  unit: string
  code: number | null
}

/** Build editable rows from the stored dictionary, sorted by unit for a stable view. Only
 *  well-formed entries (non-empty key, finite code) become rows. */
export function dictionaryToRows(dict: Record<string, number> | null | undefined): UnitRow[] {
  const d = dict && typeof dict === 'object' ? dict : {}
  return Object.entries(d)
    .filter(([k, v]) => k.trim() !== '' && Number.isFinite(v))
    .map(([unit, code]) => ({ unit, code: Number(code) }))
    .sort((a, b) => a.unit.localeCompare(b.unit, 'ru'))
}

/** Fold editable rows back into a stored dictionary: trim + lowercase the key (so it matches
 *  resolveMeasure's lowercased lookup), keep only rows with a non-empty unit AND a positive
 *  integer code, dedup by key (last non-empty wins). Mirrors parsePortalSettings' coercion, so
 *  what the editor writes survives the parse round-trip unchanged. */
export function rowsToDictionary(rows: UnitRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const key = (row.unit ?? '').trim().toLowerCase()
    const code = row.code
    if (!key) continue
    if (code == null || !Number.isInteger(code) || code <= 0) continue
    out[key] = code
  }
  return out
}

/** True when a unit key appears more than once (trim+lowercase) among the rows — the editor
 *  warns so the admin isn't surprised that the later duplicate silently overrides the earlier. */
export function hasDuplicateUnits(rows: UnitRow[]): boolean {
  const seen = new Set<string>()
  for (const row of rows) {
    const key = (row.unit ?? '').trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}
