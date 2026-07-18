import { describe, expect, it } from 'vitest'
import { parseManualTarget } from '../app/utils/manualTarget'

describe('parseManualTarget', () => {
  it('parses a JSON string with entityTypeId (+categoryId/stageId)', () => {
    expect(parseManualTarget('{"entityTypeId":2,"categoryId":1}')).toEqual({ entityTypeId: 2, categoryId: 1 })
    expect(parseManualTarget('{"entityTypeId":31,"stageId":"DT31_11:N"}')).toEqual({ entityTypeId: 31, stageId: 'DT31_11:N' })
  })
  it('accepts an object too (already-parsed JSONB from pg)', () => {
    expect(parseManualTarget({ entityTypeId: 1 })).toEqual({ entityTypeId: 1 })
  })
  it('keeps categoryId 0 (default deal pipeline is a valid selection)', () => {
    expect(parseManualTarget({ entityTypeId: 2, categoryId: 0 })).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
  it('drops a non-integer/negative categoryId but keeps the entity', () => {
    expect(parseManualTarget({ entityTypeId: 2, categoryId: 1.5 })).toEqual({ entityTypeId: 2 })
    expect(parseManualTarget({ entityTypeId: 2, categoryId: -1 })).toEqual({ entityTypeId: 2 })
    expect(parseManualTarget({ entityTypeId: 2, categoryId: 'x' })).toEqual({ entityTypeId: 2 })
  })
  it('null for absent/invalid/empty/junk (→ follow the routing rules)', () => {
    expect(parseManualTarget(undefined)).toBeNull()
    expect(parseManualTarget('')).toBeNull()
    expect(parseManualTarget('   ')).toBeNull()
    expect(parseManualTarget('not json')).toBeNull()
    expect(parseManualTarget('{"entityTypeId":0}')).toBeNull()
    expect(parseManualTarget({ entityTypeId: -2 })).toBeNull()
    expect(parseManualTarget({ entityTypeId: 1.5 })).toBeNull()
    expect(parseManualTarget(42)).toBeNull()
  })
  it('ignores unknown keys and caps stageId length', () => {
    expect(parseManualTarget({ entityTypeId: 2, evil: 'x', categoryId: 3 })).toEqual({ entityTypeId: 2, categoryId: 3 })
    const t = parseManualTarget({ entityTypeId: 31, stageId: 'x'.repeat(500) })
    expect((t?.stageId ?? '').length).toBe(100)
  })
})
