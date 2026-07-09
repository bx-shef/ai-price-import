import { describe, expect, it } from 'vitest'
import type { UnitsConfig } from '../app/types/mapping'
import { resolveMeasure } from '../app/utils/units'

// Codes from a live portal (catalog.measure.list): 796=шт (default), 166=кг.
const CFG: UnitsConfig = {
  dictionary: { шт: 796, штука: 796, дана: 796, кг: 166 },
  defaultCode: 796,
  autoCreate: true
}

describe('resolveMeasure', () => {
  it('maps a known unit (case-insensitive, multilingual)', () => {
    expect(resolveMeasure('шт', CFG)).toEqual({ code: 796, matched: true })
    expect(resolveMeasure('КГ', CFG)).toEqual({ code: 166, matched: true })
    expect(resolveMeasure('дана', CFG)).toEqual({ code: 796, matched: true }) // kk «дана»
  })

  it('unknown → default code, matched=false (auto-create + error)', () => {
    expect(resolveMeasure('рулон', CFG)).toEqual({ code: 796, matched: false })
    expect(resolveMeasure(undefined, CFG)).toEqual({ code: 796, matched: false })
  })
})
