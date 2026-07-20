import { describe, expect, it, vi } from 'vitest'
import { resolveTombstoneDays, sweepExpired } from '../server/utils/retentionSweep'

describe('resolveTombstoneDays', () => {
  it('defaults to 30 on absent/non-numeric/zero/negative', () => {
    expect(resolveTombstoneDays(undefined)).toBe(30)
    expect(resolveTombstoneDays('')).toBe(30)
    expect(resolveTombstoneDays('abc')).toBe(30)
    expect(resolveTombstoneDays('0')).toBe(30)
    expect(resolveTombstoneDays('-5')).toBe(30)
  })
  it('accepts and floors valid values', () => {
    expect(resolveTombstoneDays('7')).toBe(7)
    expect(resolveTombstoneDays('45.9')).toBe(45)
  })
  it('clamps to [1, 365]', () => {
    expect(resolveTombstoneDays('100000')).toBe(365)
    expect(resolveTombstoneDays('0.5')).toBe(1)
  })
})

describe('sweepExpired', () => {
  it('deletes text/doc/tombstone; returns counts (import_job moved to Redis, not swept here)', async () => {
    const calls: string[] = []
    const query = vi.fn(async (sql: string) => {
      calls.push(sql)
      return { rows: [{ '?column?': 1 }] }
    })
    const r = await sweepExpired(query, 12)
    expect(r).toEqual({ text: 1, docs: 1, tombstones: 1 })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain('DELETE FROM import_text')
    expect(calls[0]).toMatch(/interval '1 hour'/)
    expect(calls[1]).toContain('DELETE FROM import_doc')
    expect(calls[2]).toContain('DELETE FROM portal_tombstone')
    expect(calls[2]).toMatch(/EXTRACT\(EPOCH FROM now\(\)\)/)
    expect(calls.some(s => s.includes('import_job'))).toBe(false)
  })
  it('passes the configured windows as params (hours for text/doc, days for tombstone)', async () => {
    const params: unknown[][] = []
    const query = vi.fn(async (_sql: string, p?: unknown[]) => {
      params.push(p ?? [])
      return { rows: [] }
    })
    await sweepExpired(query, 24, 30)
    expect(params).toEqual([[24], [24], [30]])
  })
  it('defaults tombstone TTL to 30 days when unspecified', async () => {
    const params: unknown[][] = []
    const query = vi.fn(async (_sql: string, p?: unknown[]) => {
      params.push(p ?? [])
      return { rows: [] }
    })
    await sweepExpired(query)
    expect(params).toEqual([[24], [24], [30]])
  })
})
