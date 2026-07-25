import { describe, expect, it } from 'vitest'
import { entityDetailPath } from '../app/utils/entityLink'

describe('entityDetailPath', () => {
  it('deal (2) → named deal route', () => {
    expect(entityDetailPath(2, 42)).toBe('/crm/deal/details/42/')
  })
  it('lead (1) → named lead route', () => {
    expect(entityDetailPath(1, 7)).toBe('/crm/lead/details/7/')
  })
  it('smart-invoice (31) + smart process (>=1000) → universal type route', () => {
    expect(entityDetailPath(31, 5)).toBe('/crm/type/31/details/5/')
    expect(entityDetailPath(1032, 9)).toBe('/crm/type/1032/details/9/')
  })
  it('invalid ids → null (no broken link)', () => {
    expect(entityDetailPath(0, 5)).toBeNull()
    expect(entityDetailPath(2, 0)).toBeNull()
    expect(entityDetailPath(undefined, 5)).toBeNull()
    expect(entityDetailPath(2, undefined)).toBeNull()
    expect(entityDetailPath(2, -1)).toBeNull()
    expect(entityDetailPath(2.5, 5)).toBeNull()
  })
})
