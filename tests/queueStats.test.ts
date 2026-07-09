import { describe, expect, it, vi } from 'vitest'
import { readQueueCounts } from '../server/queue/stats'
import { QUEUES } from '../server/queue/topology'

describe('readQueueCounts', () => {
  it('aggregates all pipeline queues in stable order', async () => {
    const reader = vi.fn(async () => ({ waiting: 2, active: 1, completed: 5, failed: 0, delayed: 0 }))
    const out = await readQueueCounts(reader)
    expect(out.map(q => q.name)).toEqual(Object.values(QUEUES))
    expect(out[0]).toMatchObject({ waiting: 2, active: 1, completed: 5 })
  })
  it('missing/NaN counts → zeros; a throwing reader → all zeros for that queue', async () => {
    const reader = vi.fn(async (name: string) => {
      if (name === QUEUES.agent) throw new Error('redis down')
      return { waiting: Number.NaN, active: 3 }
    })
    const out = await readQueueCounts(reader)
    const agent = out.find(q => q.name === QUEUES.agent)!
    expect(agent).toEqual({ name: QUEUES.agent, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 })
    const other = out.find(q => q.name === QUEUES.extract)!
    expect(other).toMatchObject({ waiting: 0, active: 3 }) // NaN→0, present→kept
  })
})
