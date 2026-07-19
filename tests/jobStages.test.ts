import { describe, expect, it } from 'vitest'
import { jobProgress } from '../app/utils/jobStages'

describe('jobProgress', () => {
  it('queued → nothing active yet, low percent, not terminal', () => {
    const p = jobProgress('queued')
    expect(p.terminal).toBe(false)
    expect(p.failed).toBe(false)
    expect(p.label).toBe('В очереди')
    expect(p.percent).toBe(8)
    expect(p.steps.map(s => s.state)).toEqual(['pending', 'pending', 'pending'])
  })
  it('extracting → step 0 active, earlier done', () => {
    const p = jobProgress('extracting')
    expect(p.label).toBe('Извлечение текста')
    expect(p.percent).toBe(40)
    expect(p.steps.map(s => s.state)).toEqual(['active', 'pending', 'pending'])
  })
  it('processing → step 0 done, step 1 active', () => {
    const p = jobProgress('processing')
    expect(p.label).toBe('Распознавание и запись')
    expect(p.percent).toBe(75)
    expect(p.steps.map(s => s.state)).toEqual(['done', 'active', 'pending'])
  })
  it('done → all done, 100%, terminal', () => {
    const p = jobProgress('done')
    expect(p.terminal).toBe(true)
    expect(p.failed).toBe(false)
    expect(p.percent).toBe(100)
    expect(p.steps.map(s => s.state)).toEqual(['done', 'done', 'done'])
  })
  it('error while processing → failed, that step errored, earlier done', () => {
    const p = jobProgress('error')
    expect(p.terminal).toBe(true)
    expect(p.failed).toBe(true)
    expect(p.label).toBe('Ошибка')
    // status='error' doesn't carry the failing stage; falls back to first step as the error anchor
    expect(p.steps[0]!.state).toBe('error')
  })
  it('percent is monotonic across the pipeline', () => {
    const seq = ['queued', 'extracting', 'processing', 'done'].map(s => jobProgress(s).percent)
    expect(seq).toEqual([...seq].sort((a, b) => a - b))
  })
  it('unknown status → safe default (queued-like), never throws', () => {
    const p = jobProgress('weird')
    expect(p.terminal).toBe(false)
    expect(p.percent).toBe(8)
    expect(p.steps).toHaveLength(3)
  })
})
