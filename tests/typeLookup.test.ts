import { describe, expect, it, vi } from 'vitest'
import { fetchSmartProcessTypes } from '../server/utils/typeLookup'

describe('fetchSmartProcessTypes', () => {
  it('maps crm.type.list → {entityTypeId,title,hasCategories,hasStages}, dynamic SPA only, sorted', () => {
    const call = vi.fn(async () => ({
      types: [
        { entityTypeId: 1050, title: 'Заявки', isCategoriesEnabled: 'Y', isStagesEnabled: 'N' },
        { entityTypeId: 1044, title: 'Договоры', isCategoriesEnabled: 'N', isStagesEnabled: 'Y' },
        { entityTypeId: 31, title: 'Смарт-счёт', isCategoriesEnabled: 'Y', isStagesEnabled: 'Y' } // NOT ≥1000 → excluded
      ]
    }))
    expect(fetchSmartProcessTypes(call as never)).resolves.toEqual([
      { entityTypeId: 1044, title: 'Договоры', hasCategories: false, hasStages: true },
      { entityTypeId: 1050, title: 'Заявки', hasCategories: true, hasStages: false }
    ])
  })
  it('drops titleless / non-integer entityTypeId rows', async () => {
    const call = vi.fn(async () => ({ types: [
      { entityTypeId: 1044, title: '', isCategoriesEnabled: 'Y' },
      { entityTypeId: 'x', title: 'Bad', isStagesEnabled: 'Y' }
    ] }))
    expect(await fetchSmartProcessTypes(call as never)).toEqual([])
  })
  it('→ [] on a failed call or a non-array result (never throws)', async () => {
    expect(await fetchSmartProcessTypes(vi.fn(() => Promise.reject(new Error('boom'))) as never)).toEqual([])
    expect(await fetchSmartProcessTypes(vi.fn(async () => ({})) as never)).toEqual([])
  })
})
