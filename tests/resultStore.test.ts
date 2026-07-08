import { describe, expect, it, vi } from 'vitest'
import { getExistingResult, recordResult } from '../server/utils/resultStore'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('getExistingResult', () => {
  it('maps row → {entityTypeId, entityId}, scoped by member+job', async () => {
    const { q, calls } = fakeQuery([{ entity_type_id: '2', entity_id: '555' }])
    expect(await getExistingResult('m', 'j', q)).toEqual({ entityTypeId: 2, entityId: 555 })
    expect(calls[0]!.sql).toContain('member_id=$1 AND job_id=$2')
    expect(calls[0]!.params).toEqual(['m', 'j'])
  })
  it('null when absent / unparseable', async () => {
    expect(await getExistingResult('m', 'j', fakeQuery([]).q)).toBeNull()
    expect(await getExistingResult('m', 'j', fakeQuery([{ entity_type_id: 'x', entity_id: 'y' }]).q)).toBeNull()
  })
})

describe('recordResult', () => {
  it('write-once (ON CONFLICT DO NOTHING)', async () => {
    const { q, calls } = fakeQuery()
    await recordResult('m', 'j', 2, 555, q)
    expect(calls[0]!.sql).toContain('ON CONFLICT (member_id, job_id) DO NOTHING')
    expect(calls[0]!.params).toEqual(['m', 'j', 2, 555])
  })
})
