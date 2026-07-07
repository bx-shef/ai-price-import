import type { UnitsConfig } from '~/types/mapping'

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
 * See docs/redesign/02-target-architecture.md (Q11) and 06-multilingual.md §4.
 */
export function resolveMeasure(unit: string | undefined, cfg: UnitsConfig): MeasureResolution {
  const key = (unit ?? '').trim().toLowerCase()
  if (key && Object.prototype.hasOwnProperty.call(cfg.dictionary, key)) {
    return { code: cfg.dictionary[key]!, matched: true }
  }
  return { code: cfg.defaultCode, matched: false }
}
