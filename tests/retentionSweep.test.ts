import { describe, expect, it, vi } from 'vitest'
import { sweepExpired } from '../server/utils/retentionSweep'

describe('sweepExpired', () => {
  it('deletes text/doc by hours; returns counts (import_job moved to Redis, not swept here)', async () => {
    const calls: string[] = []
    const query = vi.fn(async (sql: string) => {
      calls.push(sql)
      return { rows: [{ '?column?': 1 }] }
    })
    const r = await sweepExpired(query, 12)
    expect(r).toEqual({ text: 1, docs: 1 })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('DELETE FROM import_text')
    expect(calls[0]).toMatch(/interval '1 hour'/)
    expect(calls[1]).toContain('DELETE FROM import_doc')
    expect(calls.some(s => s.includes('import_job'))).toBe(false)
  })
  it('passes the configured window as params', async () => {
    const params: unknown[][] = []
    const query = vi.fn(async (_sql: string, p?: unknown[]) => {
      params.push(p ?? [])
      return { rows: [] }
    })
    await sweepExpired(query, 24)
    expect(params).toEqual([[24], [24]])
  })
})
