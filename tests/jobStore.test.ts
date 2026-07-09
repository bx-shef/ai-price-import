import { describe, expect, it, vi } from 'vitest'
import { createJob, getJob, listJobs, setJobStatus } from '../server/utils/jobStore'

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
  it('listJobs member-scoped, DESC, clamps LIMIT into [1,200] for every input', async () => {
    const { q, calls } = fakeQuery([])
    await listJobs('m', q)
    expect(calls[0]!.sql).toContain('WHERE member_id=$1')
    expect(calls[0]!.sql).toContain('ORDER BY created_at DESC')
    expect(calls[0]!.sql).toContain('LIMIT 50') // default
    expect(calls[0]!.params).toEqual(['m'])
    // clamp table — interpolated value must always be a bounded integer (no injection)
    const limitOf = async (n: number) => {
      const f = fakeQuery([])
      await listJobs('m', f.q, n)
      return f.calls[0]!.sql.match(/LIMIT (\d+)/)![1]
    }
    expect(await limitOf(Number.NaN)).toBe('50')
    expect(await limitOf(0)).toBe('50')
    expect(await limitOf(-5)).toBe('1')
    expect(await limitOf(9999)).toBe('200')
    expect(await limitOf(12.9)).toBe('12')
  })
})
