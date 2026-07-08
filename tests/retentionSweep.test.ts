import { describe, expect, it, vi } from 'vitest'
import { sweepExpired } from '../server/utils/retentionSweep'

describe('sweepExpired', () => {
  it('deletes text/doc by hours and terminal jobs by days; returns counts', async () => {
    const calls: string[] = []
    const query = vi.fn(async (sql: string) => {
      calls.push(sql)
      // one "row" per statement → count 1 each
      return { rows: [{ '?column?': 1 }] }
    })
    const r = await sweepExpired(query, 12, 7)
    expect(r).toEqual({ text: 1, docs: 1, jobs: 1 })
    expect(calls[0]).toContain('DELETE FROM import_text')
    expect(calls[0]).toMatch(/interval '1 hour'/)
    expect(calls[1]).toContain('DELETE FROM import_doc')
    expect(calls[2]).toContain('DELETE FROM import_job')
    expect(calls[2]).toMatch(/status IN \('done','error'\)/)
    expect(calls[2]).toMatch(/interval '1 day'/)
  })
  it('passes the configured windows as params', async () => {
    const params: unknown[][] = []
    const query = vi.fn(async (_sql: string, p?: unknown[]) => {
      params.push(p ?? [])
      return { rows: [] }
    })
    await sweepExpired(query, 24, 30)
    expect(params).toEqual([[24], [24], [30]])
  })
})
