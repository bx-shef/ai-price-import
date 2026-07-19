import { describe, expect, it, vi } from 'vitest'
import { clearOpened, getRatingState, markOpened, markPrompted, markReviewed } from '../server/utils/appRatingStore'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('getRatingState', () => {
  it('returns null when there is no row', async () => {
    expect(await getRatingState('m', fakeQuery([]).q)).toBeNull()
  })
  it('maps a row into typed dates + boolean', async () => {
    const st = await getRatingState('m', fakeQuery([
      { prompted_at: '2026-07-10T00:00:00Z', opened_at: null, reviewed: false }
    ]).q)
    expect(st?.promptedAt?.toISOString()).toBe('2026-07-10T00:00:00.000Z')
    expect(st?.openedAt).toBeNull()
    expect(st?.reviewed).toBe(false)
  })
})

describe('writes are member-scoped upserts', () => {
  it('markPrompted upserts prompted_at', async () => {
    const { q, calls } = fakeQuery()
    await markPrompted('m1', q)
    expect(calls[0]!.sql).toContain('INSERT INTO portal_app_rating')
    expect(calls[0]!.sql).toContain('prompted_at = now()')
    // guard: never re-stamp a confirmed review
    expect(calls[0]!.sql).toContain('reviewed = false')
    expect(calls[0]!.params).toEqual(['m1'])
  })
  it('markOpened stamps opened_at but not over a confirmed review', async () => {
    const { q, calls } = fakeQuery()
    await markOpened('m1', q)
    expect(calls[0]!.sql).toContain('opened_at = now()')
    // guard: the ON CONFLICT UPDATE is skipped when reviewed is already true
    expect(calls[0]!.sql).toContain('reviewed = false')
    expect(calls[0]!.params).toEqual(['m1'])
  })
  it('markReviewed sets terminal reviewed=true', async () => {
    const { q, calls } = fakeQuery()
    await markReviewed('m1', q)
    expect(calls[0]!.sql).toContain('reviewed = true')
  })
  it('clearOpened resets opened_at + prompted_at only when not reviewed', async () => {
    const { q, calls } = fakeQuery()
    await clearOpened('m1', q)
    expect(calls[0]!.sql).toContain('opened_at = NULL')
    expect(calls[0]!.sql).toContain('reviewed = false')
    expect(calls[0]!.params).toEqual(['m1'])
  })
})
