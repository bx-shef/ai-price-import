import type { UnitsConfig } from '~/types/mapping'
import { normalizeUnitKey } from './measureCreate'

/** Result of resolving a document unit to a catalog.measure code. */
export interface MeasureResolution {
  code: number
  /** True when the unit was found in the dictionary; false → default/auto-create + error. */
  matched: boolean
}

/**
 * Resolve a document unit string (e.g. "шт", "кг", "дана") to a Bitrix24
 * catalog.measure code via the portal dictionary. Case-insensitive, trimmed.
 * No match → default code with matched=false (caller auto-creates + reports error).
 * See docs/PROCESS.md §6.5 «Единицы измерения» and docs/PROCESS.md §9 «Языки документов».
 */
export function resolveMeasure(unit: string | undefined, cfg: UnitsConfig): MeasureResolution {
  // Canonical key (case-insensitive, trailing dot folded) so "ШТ"/"шт"/"Шт"/"шт." all hit the same
  // dictionary entry — the dictionary is stored under the SAME normalization (rowsToDictionary /
  // parsePortalSettings).
  const key = normalizeUnitKey(unit)
  if (key && Object.prototype.hasOwnProperty.call(cfg.dictionary, key)) {
    return { code: cfg.dictionary[key]!, matched: true }
  }
  return { code: cfg.defaultCode, matched: false }
}
