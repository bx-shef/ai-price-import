import type { RestCall } from './b24Rest'
import { isCreatableUnit, nextMeasureCode, buildMeasureAddParams } from '~/utils/measureCreate'

// Transport for auto-creating a catalog measure (Q11). Best-effort: any failure returns null so the
// caller (crm-sync) falls back to the default measure code + a warning — an unknown unit must never
// fail the import. `catalog.measure.add` needs a unique integer code; on the "code already exists"
// error (an inactive standard code not in the active list) we bump the code and retry a few times.

/** B24 error code for a duplicate measure code (catalog.measure.add). */
const DUPLICATE_CODE = '200600000000'
/** How many codes to try before giving up (collision is rare once we start above max(existing)). */
const MAX_CODE_ATTEMPTS = 5

function isDuplicateCodeError(e: unknown): boolean {
  const err = e as { error?: unknown, code?: unknown, message?: string }
  return String(err?.error ?? err?.code ?? '') === DUPLICATE_CODE || (err?.message ?? '').includes(DUPLICATE_CODE)
}

/**
 * Create a catalog measure for an unmatched document unit; returns the allocated code, or null when
 * the unit isn't sane to create (OCR noise) or the create fails. `existingCodes` seeds the allocator
 * (and should be updated by the caller with the returned code so repeats in the same job don't clash).
 */
export async function createMeasureViaRest(unit: string, existingCodes: number[], call: RestCall): Promise<number | null> {
  if (!isCreatableUnit(unit)) return null
  let code = nextMeasureCode(existingCodes)
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    try {
      const res = await call('catalog.measure.add', buildMeasureAddParams(unit, code)) as { measure?: { code?: number } }
      // Trust our allocated code; fall back to the echoed one if present.
      const created = Number(res?.measure?.code)
      return Number.isInteger(created) && created > 0 ? created : code
    } catch (e) {
      if (isDuplicateCodeError(e)) {
        code += 1 // collided with an inactive standard code — try the next one
        continue
      }
      return null // any other error (access denied, transport) → best-effort fallback
    }
  }
  return null
}
