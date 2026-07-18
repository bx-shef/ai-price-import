import { describe, expect, it, vi } from 'vitest'
import { claimJobNotify, createJob, getJob, getManualOverride, listJobs, setJobStatus } from '../server/utils/jobStore'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('jobStore', () => {
  it('createJob inserts with ON CONFLICT DO NOTHING (no override → null)', async () => {
    const { q, calls } = fakeQuery()
    await createJob('m', 'j1', 'накладная.pdf', q)
    expect(calls[0]!.sql).toContain('ON CONFLICT (member_id, job_id) DO NOTHING')
    expect(calls[0]!.sql).toContain('manual_override')
    expect(calls[0]!.params).toEqual(['m', 'j1', 'накладная.pdf', null])
  })
  it('createJob serializes a manual override target to JSON', async () => {
    const { q, calls } = fakeQuery()
    await createJob('m', 'j1', 'f.pdf', q, { entityTypeId: 2, categoryId: 1 })
    expect(calls[0]!.params![3]).toBe('{"entityTypeId":2,"categoryId":1}')
  })
  it('getManualOverride re-validates the stored row (object → TargetRef; junk → undefined)', async () => {
    const t = await getManualOverride('m', 'j1', fakeQuery([{ manual_override: { entityTypeId: 31, categoryId: 11 } }]).q)
    expect(t).toEqual({ entityTypeId: 31, categoryId: 11 })
    expect(await getManualOverride('m', 'j1', fakeQuery([{ manual_override: null }]).q)).toBeUndefined()
    expect(await getManualOverride('m', 'j1', fakeQuery([{ manual_override: { entityTypeId: 0 } }]).q)).toBeUndefined()
    expect(await getManualOverride('m', 'x', fakeQuery([]).q)).toBeUndefined()
  })
  it('claimJobNotify: atomic UPDATE guarded by notified=false, RETURNING (#164)', async () => {
    const { q, calls } = fakeQuery([{ job_id: 'j1' }]) // one row back → we won the claim
    const won = await claimJobNotify('m', 'j1', q)
    expect(won).toBe(true)
    expect(calls[0]!.sql).toContain('SET notified=true')
    expect(calls[0]!.sql).toContain('AND notified=false') // the guard that makes it one-shot
    expect(calls[0]!.sql).toContain('RETURNING job_id')
    expect(calls[0]!.params).toEqual(['m', 'j1'])
  })
  it('claimJobNotify: no row returned (already notified / missing job) → false', async () => {
    const won = await claimJobNotify('m', 'j1', fakeQuery([]).q)
    expect(won).toBe(false)
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
