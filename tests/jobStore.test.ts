import { describe, expect, it, vi } from 'vitest'
import { createJob, getJob, setJobStatus } from '../server/utils/jobStore'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('jobStore', () => {
  it('createJob inserts with ON CONFLICT DO NOTHING', async () => {
    const { q, calls } = fakeQuery()
    await createJob('m', 'j1', 'накладная.pdf', q)
    expect(calls[0]!.sql).toContain('ON CONFLICT (member_id, job_id) DO NOTHING')
    expect(calls[0]!.params).toEqual(['m', 'j1', 'накладная.pdf'])
  })
  it('setJobStatus updates status+result', async () => {
    const { q, calls } = fakeQuery()
    await setJobStatus('m', 'j1', 'done', '{"entityId":5}', q)
    expect(calls[0]!.params).toEqual(['m', 'j1', 'done', '{"entityId":5}'])
  })
  it('getJob maps row / null', async () => {
    const j = await getJob('m', 'j1', fakeQuery([{ member_id: 'm', job_id: 'j1', status: 'processing', file_name: 'a.pdf', result: '' }]).q)
    expect(j).toMatchObject({ status: 'processing', fileName: 'a.pdf' })
    expect(await getJob('m', 'x', fakeQuery([]).q)).toBeNull()
  })
})
