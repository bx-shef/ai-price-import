import { describe, expect, it, vi } from 'vitest'
import { fetchCrmCategories } from '../server/utils/categoryLookup'

describe('fetchCrmCategories', () => {
  it('maps rows (isDefault Y/N/boolean → bool, missing name → ""), filters junk ids', async () => {
    const call = vi.fn(async () => ({
      categories: [
        { id: 0, name: 'Default pipeline', isDefault: 'Y' },
        { id: 1, name: '[TEST] Опт', isDefault: 'N' },
        { id: 5, isDefault: true }, // boolean isDefault + missing name
        { id: 'x', name: 'junk', isDefault: 'N' } // non-integer id → dropped
      ]
    }))
    const cats = await fetchCrmCategories(2, call)
    expect(call).toHaveBeenCalledWith('crm.category.list', { entityTypeId: 2, start: 0 })
    expect(cats).toEqual([
      { id: 0, name: 'Default pipeline', isDefault: true },
      { id: 1, name: '[TEST] Опт', isDefault: false },
      { id: 5, name: '', isDefault: true }
    ])
  })

  it('paginates by `next` and stops when it no longer advances', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ categories: [{ id: 0, name: 'A', isDefault: 'Y' }], next: 50 })
      .mockResolvedValueOnce({ categories: [{ id: 1, name: 'B', isDefault: 'N' }] }) // no next → stop
    const cats = await fetchCrmCategories(2, call)
    expect(cats.map(c => c.id)).toEqual([0, 1])
    expect(call).toHaveBeenNthCalledWith(1, 'crm.category.list', { entityTypeId: 2, start: 0 })
    expect(call).toHaveBeenNthCalledWith(2, 'crm.category.list', { entityTypeId: 2, start: 50 })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('returns what it has when the method throws (lead → ENTITY_TYPE_NOT_SUPPORTED / transient)', async () => {
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
