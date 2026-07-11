import { describe, expect, it, vi } from 'vitest'
import { bumpCounter, METRICS, readCounters, resetCounters } from '../server/utils/metricsStore'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('bumpCounter', () => {
  it('upserts with additive ON CONFLICT', async () => {
    const { q, calls } = fakeQuery()
    await bumpCounter('m', METRICS.created, 3, q)
    expect(calls[0]!.sql).toContain('value = metrics_counter.value + EXCLUDED.value')
    expect(calls[0]!.params).toEqual(['m', 'created', 3])
  })
  it('truncates fractional deltas', async () => {
    const { q, calls } = fakeQuery()
    await bumpCounter('m', 'x', 2.9, q)
    expect(calls[0]!.params![2]).toBe(2)
  })
  it('no-op on zero / non-finite', async () => {
    const { q } = fakeQuery()
    await bumpCounter('m', 'x', 0, q)
    await bumpCounter('m', 'x', Number.NaN, q)
    await bumpCounter('m', 'x', Infinity, q)
    expect(q).not.toHaveBeenCalled()
  })
})

describe('readCounters', () => {
  it('maps rows to name→value', async () => {
    const out = await readCounters('m', fakeQuery([{ name: 'created', value: '5' }, { name: 'errors', value: 2 }]).q)
    expect(out).toEqual({ created: 5, errors: 2 })
  })
  it('empty when no rows', async () => {
    expect(await readCounters('m', fakeQuery([]).q)).toEqual({})
  })
})

describe('resetCounters', () => {
  it('deletes only the caller portal counters (member-scoped)', async () => {
    const { q, calls } = fakeQuery()
    await resetCounters('m42', q)
    expect(calls[0]!.sql).toContain('DELETE FROM metrics_counter WHERE member_id=$1')
    expect(calls[0]!.params).toEqual(['m42'])
  })
})
