import { describe, expect, it, vi } from 'vitest'
import { findExistingItemId } from '../server/utils/originLookup'

describe('findExistingItemId', () => {
  it('queries crm.item.list with the marker filter and returns the first id', async () => {
    const call = vi.fn(async () => ({ items: [{ id: '777' }, { id: '888' }] }))
    const id = await findExistingItemId(2, { '=originId': 'job1', '=originatorId': 'acme' }, call)
    expect(id).toBe(777)
    expect(call).toHaveBeenCalledWith('crm.item.list', {
      entityTypeId: 2,
      filter: { '=originId': 'job1', '=originatorId': 'acme' },
      select: ['id']
    })
  })
  it('no match → null', async () => {
    expect(await findExistingItemId(31, { '=xmlId': 'acme:job1' }, vi.fn(async () => ({ items: [] })))).toBeNull()
    expect(await findExistingItemId(31, { '=xmlId': 'acme:job1' }, vi.fn(async () => ({})))).toBeNull()
    expect(await findExistingItemId(31, { '=xmlId': 'acme:job1' }, vi.fn(async () => undefined))).toBeNull()
  })
  it('non-positive / non-numeric id → null (defensive)', async () => {
    expect(await findExistingItemId(2, {}, vi.fn(async () => ({ items: [{ id: '0' }] })))).toBeNull()
    expect(await findExistingItemId(2, {}, vi.fn(async () => ({ items: [{ id: 'x' }] })))).toBeNull()
  })
})
