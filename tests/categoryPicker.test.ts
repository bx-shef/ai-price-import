import { describe, expect, it } from 'vitest'
import {
  CATEGORY_SENTINEL_LABEL,
  CATEGORY_SENTINEL_VALUE,
  categoryItems,
  categoryValue,
  hasCategories,
  reconcileCategory,
  setCategory,
  type CrmCategoryOption
} from '../app/utils/categoryPicker'

const CATS: CrmCategoryOption[] = [
  { id: 0, name: 'Default pipeline', isDefault: true },
  { id: 1, name: 'Опт', isDefault: false }
]

describe('categoryItems', () => {
  it('prepends the sentinel and suffixes the default funnel with «(осн.)» (distinct wording)', () => {
    expect(categoryItems(CATS)).toEqual([
      { label: CATEGORY_SENTINEL_LABEL, value: CATEGORY_SENTINEL_VALUE },
      { label: 'Default pipeline (осн.)', value: '0' },
      { label: 'Опт', value: '1' }
    ])
    // the sentinel and the default funnel must NOT read the same
    expect(CATEGORY_SENTINEL_LABEL).not.toContain('(осн.)')
  })
  it('sentinel value is non-empty (b24ui/Reka SelectItem forbids empty-string values)', () => {
    expect(CATEGORY_SENTINEL_VALUE).not.toBe('')
    for (const it of categoryItems(CATS)) expect(it.value).not.toBe('')
  })
  it('undefined/empty → just the sentinel', () => {
    expect(categoryItems(undefined)).toEqual([{ label: CATEGORY_SENTINEL_LABEL, value: CATEGORY_SENTINEL_VALUE }])
    expect(categoryItems([])).toEqual([{ label: CATEGORY_SENTINEL_LABEL, value: CATEGORY_SENTINEL_VALUE }])
  })
})

describe('hasCategories', () => {
  it('true only when loaded and non-empty', () => {
    expect(hasCategories(CATS)).toBe(true)
    expect(hasCategories([])).toBe(false)
    expect(hasCategories(undefined)).toBe(false)
  })
})

describe('categoryValue / setCategory round-trip', () => {
  it('categoryValue: undefined → sentinel, id → String(id) (incl. 0)', () => {
    expect(categoryValue({ categoryId: undefined })).toBe(CATEGORY_SENTINEL_VALUE)
    expect(categoryValue({ categoryId: 0 })).toBe('0')
    expect(categoryValue({ categoryId: 3 })).toBe('3')
  })
  it('setCategory: sentinel/"" → undefined (never Number("")===0); "1" → 1', () => {
    const t: { categoryId?: number } = { categoryId: 5 }
    setCategory(t, CATEGORY_SENTINEL_VALUE)
    expect(t.categoryId).toBeUndefined()
    t.categoryId = 5
    setCategory(t, '')
    expect(t.categoryId).toBeUndefined()
    setCategory(t, '1')
    expect(t.categoryId).toBe(1)
    setCategory(t, '0') // the default-pipeline id 0 is a valid selection
    expect(t.categoryId).toBe(0)
  })
  it('setCategory: junk/non-integer coerces to undefined (never a NaN categoryId)', () => {
    const t: { categoryId?: number } = { categoryId: 2 }
    setCategory(t, 'abc')
    expect(t.categoryId).toBeUndefined()
    setCategory(t, '1.5')
    expect(t.categoryId).toBeUndefined()
  })
})

describe('reconcileCategory', () => {
  it('NOT loaded yet (undefined) → leaves a seeded id untouched (no async-gap clear)', () => {
    const t = { entityTypeId: 2, categoryId: 1 }
    reconcileCategory(t, undefined)
    expect(t.categoryId).toBe(1)
  })
  it('loaded and id valid → keeps it', () => {
    const t = { entityTypeId: 2, categoryId: 1 }
    reconcileCategory(t, CATS)
    expect(t.categoryId).toBe(1)
  })
  it('loaded but id not among funnels (entity switched) → clears', () => {
    const t = { entityTypeId: 31, categoryId: 1 } // 1 belongs to a deal, not this entity
    reconcileCategory(t, [{ id: 11, name: 'Default', isDefault: true }])
    expect(t.categoryId).toBeUndefined()
  })
  it('loaded empty (lead / no funnels) → clears any stale id', () => {
    const t = { entityTypeId: 1, categoryId: 1 }
    reconcileCategory(t, [])
    expect(t.categoryId).toBeUndefined()
  })
  it('no categoryId set → no-op', () => {
    const t = { entityTypeId: 2 }
    reconcileCategory(t, CATS)
    expect(t.categoryId).toBeUndefined()
  })
})
