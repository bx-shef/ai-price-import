import { describe, expect, it, vi } from 'vitest'
import { fetchCrmCategories } from '../server/utils/categoryLookup'

describe('fetchCrmCategories', () => {
  it('maps crm.category.list rows (isDefault Y/N → boolean), filters junk ids', async () => {
    const call = vi.fn(async () => ({
      categories: [
        { id: 0, name: 'Default pipeline', isDefault: 'Y' },
        { id: 1, name: '[TEST] Опт', isDefault: 'N' },
        { id: 'x', name: 'junk', isDefault: 'N' } // non-integer id → dropped
      ]
    }))
    const cats = await fetchCrmCategories(2, call)
    expect(call).toHaveBeenCalledWith('crm.category.list', { entityTypeId: 2 })
    expect(cats).toEqual([
      { id: 0, name: 'Default pipeline', isDefault: true },
      { id: 1, name: '[TEST] Опт', isDefault: false }
    ])
  })

  it('returns [] when the method throws (lead → ENTITY_TYPE_NOT_SUPPORTED / transient error)', async () => {
    const call = vi.fn(async () => {
      throw new Error('ENTITY_TYPE_NOT_SUPPORTED')
    })
    expect(await fetchCrmCategories(1, call)).toEqual([])
  })

  it('returns [] for an invalid entityTypeId without calling REST', async () => {
    const call = vi.fn(async () => ({ categories: [] }))
    expect(await fetchCrmCategories(0, call)).toEqual([])
    expect(await fetchCrmCategories(-5, call)).toEqual([])
    expect(await fetchCrmCategories(1.5, call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('tolerates a missing/empty categories key', async () => {
    expect(await fetchCrmCategories(31, vi.fn(async () => ({})))).toEqual([])
    expect(await fetchCrmCategories(31, vi.fn(async () => ({ categories: [] })))).toEqual([])
  })
})
