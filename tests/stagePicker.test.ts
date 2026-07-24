import { describe, expect, it } from 'vitest'
import {
  STAGE_SENTINEL_LABEL,
  STAGE_SENTINEL_VALUE,
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
      { label: STAGE_SENTINEL_LABEL, value: STAGE_SENTINEL_VALUE },
      { label: 'Новая', value: 'NEW' },
      { label: 'C1:WON', value: 'C1:WON' }
    ])
  })
  it('sentinel value is non-empty (b24ui/Reka SelectItem forbids empty-string values)', () => {
    expect(STAGE_SENTINEL_VALUE).not.toBe('')
    for (const it of stageItems(STAGES)) expect(it.value).not.toBe('')
  })
  it('undefined/empty → just the sentinel', () => {
    expect(stageItems(undefined)).toEqual([{ label: STAGE_SENTINEL_LABEL, value: STAGE_SENTINEL_VALUE }])
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
  it('stageValue: undefined → sentinel, id → id', () => {
    expect(stageValue({})).toBe(STAGE_SENTINEL_VALUE)
    expect(stageValue({ stageId: 'C1:NEW' })).toBe('C1:NEW')
  })
  it('setStage: sentinel/"" → undefined; a stage id is kept (bounded)', () => {
    const t: { stageId?: string } = { stageId: 'X' }
    setStage(t, STAGE_SENTINEL_VALUE)
    expect(t.stageId).toBeUndefined()
    t.stageId = 'X'
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
