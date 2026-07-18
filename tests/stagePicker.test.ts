import { describe, expect, it } from 'vitest'
import {
  STAGE_SENTINEL_LABEL,
  hasStages,
  reconcileStage,
  setStage,
  stageItems,
  stageValue,
  type CrmStageOption
} from '../app/utils/stagePicker'

const STAGES: CrmStageOption[] = [
  { id: 'NEW', name: 'Новая' },
  { id: 'C1:WON', name: '' } // empty name → label falls back to id
]

describe('stageItems', () => {
  it('prepends the sentinel; label = name, else id', () => {
    expect(stageItems(STAGES)).toEqual([
      { label: STAGE_SENTINEL_LABEL, value: '' },
      { label: 'Новая', value: 'NEW' },
      { label: 'C1:WON', value: 'C1:WON' }
    ])
  })
  it('undefined/empty → just the sentinel', () => {
    expect(stageItems(undefined)).toEqual([{ label: STAGE_SENTINEL_LABEL, value: '' }])
  })
})

describe('hasStages', () => {
  it('true only when loaded and non-empty', () => {
    expect(hasStages(STAGES)).toBe(true)
    expect(hasStages([])).toBe(false)
    expect(hasStages(undefined)).toBe(false)
  })
})

describe('stageValue / setStage', () => {
  it('stageValue: undefined → "", id → id', () => {
    expect(stageValue({})).toBe('')
    expect(stageValue({ stageId: 'C1:NEW' })).toBe('C1:NEW')
  })
  it('setStage: "" → undefined; a stage id is kept (bounded)', () => {
    const t: { stageId?: string } = { stageId: 'X' }
    setStage(t, '')
    expect(t.stageId).toBeUndefined()
    setStage(t, 'DT31_11:P')
    expect(t.stageId).toBe('DT31_11:P')
    setStage(t, 'y'.repeat(200))
    expect((t.stageId ?? '').length).toBe(100)
  })
})

describe('reconcileStage', () => {
  it('not loaded (undefined) → leaves a seeded id untouched', () => {
    const t = { stageId: 'NEW' }
    reconcileStage(t, undefined)
    expect(t.stageId).toBe('NEW')
  })
  it('valid stage kept; stage gone (funnel/category switched) → cleared', () => {
    const t1 = { stageId: 'NEW' }
    reconcileStage(t1, STAGES)
    expect(t1.stageId).toBe('NEW')
    const t2 = { stageId: 'GONE' }
    reconcileStage(t2, STAGES)
    expect(t2.stageId).toBeUndefined()
  })
  it('empty loaded list → clears any stale id; no stage set → no-op', () => {
    const t1 = { stageId: 'NEW' }
    reconcileStage(t1, [])
    expect(t1.stageId).toBeUndefined()
    const t2: { stageId?: string } = {}
    reconcileStage(t2, STAGES)
    expect(t2.stageId).toBeUndefined()
  })
})
