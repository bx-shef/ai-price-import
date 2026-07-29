import type { UnitsConfig } from '~/types/mapping'
import { normalizeUnitKey } from './measureCreate'
import { RAW_UNIT_SYNONYMS } from '~/config/unitSynonyms'

/** Result of resolving a document unit to a catalog.measure code. */
export interface MeasureResolution {
  code: number
  /** True when the unit was recognised (portal dictionary or built-in map); false → default + warning. */
  matched: boolean
  /** Which layer recognised it. crm-sync uses this: a `builtin` code is checked against the portal's
   *  own measure catalogue before it is written, a `portal` one is taken as the admin's decision. */
  source?: 'portal' | 'builtin'
}

/**
 * Extra folding applied ON TOP of normalizeUnitKey, for LOOKUPS only (never for storage): strip
 * internal dots and spaces («пог.м» → «погм», «кв. м» → «квм») and fold superscripts to digits
 * («м²» → «м2», «м³» → «м3»).
 *
 * Applied to BOTH sides — the document unit, every built-in spelling and every portal-dictionary key
 * — so an administrator's entry «кв.м» still wins for a document that prints «кв. м».
 */
export function foldUnitForLookup(unit: string | undefined): string {
  const base = normalizeUnitKey(unit)
  if (!base) return ''
  return base.replace(/²/g, '2').replace(/³/g, '3').replace(/[.\s]/g, '')
}

/** Built-in spelling → ОКЕИ code, keyed by foldUnitForLookup. First spelling wins on a collision. */
export const BUILTIN_UNIT_CODES: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>()
  for (const [code, spellings] of Object.entries(RAW_UNIT_SYNONYMS)) {
    for (const s of spellings) {
      const key = foldUnitForLookup(s)
      if (key && !map.has(key)) map.set(key, Number(code))
    }
  }
  return map
})()

/** Short «what already works» list for the settings screen — one canonical spelling per code, derived
 *  from the map itself so the hint can't drift from the behaviour. */
export const BUILTIN_UNIT_HINT: readonly string[] = Object.values(RAW_UNIT_SYNONYMS).map(s => s[0]!)

/** Look up a document unit in the built-in map. Null → no built-in spelling matches. */
export function builtinUnitCode(unit: string | undefined): number | null {
  return BUILTIN_UNIT_CODES.get(foldUnitForLookup(unit)) ?? null
}

/**
 * Resolve a document unit string (e.g. "шт", "кг", "дана") to a Bitrix24 catalog.measure code.
 * Layers, in order: the portal's own dictionary (exact key, then folded) → the built-in synonym map →
 * the default code. Case-insensitive, trimmed. No match → default code with matched=false (caller
 * auto-creates + warns).
 *
 * The caller (crm-sync) adds one more check the pure core cannot do: a `builtin` code is verified
 * against the portal's actual measure catalogue before it reaches a product row.
 *
 * See docs/PROCESS.md §6.5 «Единицы измерения» and docs/PROCESS.md §9 «Языки документов».
 */
export function resolveMeasure(unit: string | undefined, cfg: UnitsConfig): MeasureResolution {
  // Canonical key (case-insensitive, trailing dot folded) so "ШТ"/"шт"/"Шт"/"шт." all hit the same
  // dictionary entry — the dictionary is stored under the SAME normalization (rowsToDictionary /
  // parsePortalSettings).
  const key = normalizeUnitKey(unit)
  if (key && Object.prototype.hasOwnProperty.call(cfg.dictionary, key)) {
    return { code: cfg.dictionary[key]!, matched: true, source: 'portal' }
  }
  // Second pass over the SAME portal dictionary with the wider folding used for built-ins. Without it
  // the promise «настройка администратора всегда выигрывает» held only for a letter-exact spelling:
  // an entry «кв.м» would lose to the built-in map for a document printing «кв. м».
  const folded = foldUnitForLookup(unit)
  if (folded) {
    for (const [k, v] of Object.entries(cfg.dictionary)) {
      if (foldUnitForLookup(k) === folded) return { code: v, matched: true, source: 'portal' }
    }
  }
  // Built-in synonyms are the fallback LAYER, not a replacement. Without it a fresh portal (empty
  // dictionary) wrote every unit except «шт» to CRM as «шт» (#272).
  const builtin = builtinUnitCode(unit)
  if (builtin !== null) return { code: builtin, matched: true, source: 'builtin' }
  return { code: cfg.defaultCode, matched: false }
}
