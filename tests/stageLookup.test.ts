import { describe, expect, it, vi } from 'vitest'
import { fetchCrmStages, stageEntityId } from '../server/utils/stageLookup'

describe('stageEntityId (live-verified ENTITY_ID forms)', () => {
  it('lead → null (crm.item.add ignores the stage, so none is offered)', () => {
    expect(stageEntityId(1, null)).toBeNull()
    expect(stageEntityId(1, 7)).toBeNull() // category irrelevant for a lead
  })
  it('deal default funnel (cat 0 / none) → DEAL_STAGE, categorized → DEAL_STAGE_<N>', () => {
    expect(stageEntityId(2, null)).toBe('DEAL_STAGE')
    expect(stageEntityId(2, 0)).toBe('DEAL_STAGE')
    expect(stageEntityId(2, 1)).toBe('DEAL_STAGE_1')
    expect(stageEntityId(2, 3)).toBe('DEAL_STAGE_3')
  })
  it('smart-invoice → SMART_INVOICE_STAGE_<cat>; smart-process → DYNAMIC_<etid>_STAGE_<cat>', () => {
    expect(stageEntityId(31, 11)).toBe('SMART_INVOICE_STAGE_11')
    expect(stageEntityId(1032, 17)).toBe('DYNAMIC_1032_STAGE_17')
  })
  it('smart-* with no / negative category → null (can\'t address stages yet)', () => {
    expect(stageEntityId(31, null)).toBeNull()
    expect(stageEntityId(1032, null)).toBeNull()
    expect(stageEntityId(31, -1)).toBeNull()
  })
  it('unknown entity type (3..999, non-smart) → null', () => {
    expect(stageEntityId(7, 0)).toBeNull()
    expect(stageEntityId(500, 0)).toBeNull()
  })
  it('invalid entityTypeId → null', () => {
    expect(stageEntityId(0, 1)).toBeNull()
    expect(stageEntityId(-2, 1)).toBeNull()
  })
})

describe('fetchCrmStages', () => {
  it('maps crm.status.list rows (flat array) → {id,name}, drops empty ids', async () => {
    const call = vi.fn(async () => [
      { STATUS_ID: 'NEW', NAME: 'New', SORT: 10 },
      { STATUS_ID: 'WON', NAME: 'Won', SORT: 20 },
      { STATUS_ID: '', NAME: 'junk' }
    ])
    const stages = await fetchCrmStages(2, 0, call)
    expect(call).toHaveBeenCalledWith('crm.status.list', { filter: { ENTITY_ID: 'DEAL_STAGE' }, select: ['STATUS_ID', 'NAME', 'SORT'] })
    expect(stages).toEqual([{ id: 'NEW', name: 'New' }, { id: 'WON', name: 'Won' }])
  })
  it('orders stages by SORT (not arrival order)', async () => {
    const call = vi.fn(async () => [
      { STATUS_ID: 'WON', NAME: 'Won', SORT: 30 },
      { STATUS_ID: 'NEW', NAME: 'New', SORT: 10 },
      { STATUS_ID: 'WORK', NAME: 'Work', SORT: 20 }
    ])
    const stages = await fetchCrmStages(2, 0, call)
    expect(stages.map(s => s.id)).toEqual(['NEW', 'WORK', 'WON'])
  })
  it('uses the categorized ENTITY_ID for a deal funnel', async () => {
    const call = vi.fn(async () => [{ STATUS_ID: 'C1:NEW', NAME: 'New' }])
    await fetchCrmStages(2, 1, call)
    expect(call).toHaveBeenCalledWith('crm.status.list', expect.objectContaining({ filter: { ENTITY_ID: 'DEAL_STAGE_1' } }))
  })
  it('returns [] without REST when no ENTITY_ID (smart-process w/o category)', async () => {
    const call = vi.fn(async () => [])
    expect(await fetchCrmStages(1032, null, call)).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })
  it('returns [] when the method throws / non-array result', async () => {
    expect(await fetchCrmStages(2, 0, vi.fn(async () => {
      throw new Error('boom')
    }))).toEqual([])
    expect(await fetchCrmStages(2, 0, vi.fn(async () => ({ notArray: true })))).toEqual([])
  })
})
