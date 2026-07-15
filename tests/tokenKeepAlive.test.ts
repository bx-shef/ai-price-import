import { describe, expect, it } from 'vitest'
import type { QueryFn } from '../server/utils/tokenStore'
import {
  MAX_KEEP_ALIVE_BATCH,
  MAX_KEEP_ALIVE_HOURS,
  REFRESH_TOKEN_TTL_DAYS,
  KEEP_ALIVE_THRESHOLD_DAYS,
  keepAliveIntervalMs,
  nearExpiryCutoffMs,
  runTokenKeepAlive,
  selectTokensNearExpiry,
  type KeepAliveDeps
} from '../server/utils/tokenKeepAlive'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 14)

const fakeQuery = (rows: Array<Record<string, unknown>> = []) => {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = (async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  }) as QueryFn
  return { q, calls }
}

describe('nearExpiryCutoffMs', () => {
  it('cuts off at TTL - threshold days before now (177d default)', () => {
    expect(nearExpiryCutoffMs(NOW)).toBe(NOW - (REFRESH_TOKEN_TTL_DAYS - KEEP_ALIVE_THRESHOLD_DAYS) * DAY)
  })
  it('honours custom ttl/threshold', () => {
    expect(nearExpiryCutoffMs(NOW, 30, 5)).toBe(NOW - 25 * DAY)
  })
})

describe('selectTokensNearExpiry', () => {
  it('bounds updated_at to the near-expiry BAND [now-180d, now-177d), oldest first, capped', async () => {
    const { q, calls } = fakeQuery([{ member_id: 'A' }, { member_id: 'B' }])
    expect(await selectTokensNearExpiry(q, NOW)).toEqual(['A', 'B'])
    const [sql, params] = [calls[0]!.sql, calls[0]!.params!]
    expect(sql).toMatch(/updated_at < \$1/)
    expect(sql).toMatch(/updated_at >= \$2/)
    expect(sql).toMatch(/ORDER BY updated_at ASC/)
    expect(sql).toMatch(/LIMIT \$3/)
    expect(params[0]).toBe(new Date(NOW - 177 * DAY).toISOString())
    expect(params[1]).toBe(new Date(NOW - 180 * DAY).toISOString())
    expect(params[2]).toBe(MAX_KEEP_ALIVE_BATCH)
  })
  it('passes a custom limit + threshold (floor tracks the custom ttl)', async () => {
    const { q, calls } = fakeQuery([])
    await selectTokensNearExpiry(q, NOW, { limit: 10, thresholdDays: 7, ttlDays: 90 })
    expect(calls[0]!.params![0]).toBe(new Date(NOW - 83 * DAY).toISOString())
    expect(calls[0]!.params![1]).toBe(new Date(NOW - 90 * DAY).toISOString())
    expect(calls[0]!.params![2]).toBe(10)
  })
})

function deps(over: Partial<KeepAliveDeps> = {}) {
  const warns: string[] = []
  const d: KeepAliveDeps = {
    now: () => NOW,
    selectNearExpiry: async () => [],
    refreshPortal: async () => 'refreshed',
    warn: m => warns.push(m),
    log: () => {},
    ...over
  }
  return { d, warns }
}

describe('runTokenKeepAlive', () => {
  it('refreshes every near-expiry portal', async () => {
    const { d } = deps({ selectNearExpiry: async () => ['A', 'B', 'C'] })
    expect(await runTokenKeepAlive(d)).toEqual({ selected: 3, refreshed: 3, skipped: 0, failed: 0 })
  })
  it('counts a vanished portal as skipped', async () => {
    const { d } = deps({ selectNearExpiry: async () => ['A', 'B'], refreshPortal: async m => (m === 'B' ? 'skipped' : 'refreshed') })
    expect(await runTokenKeepAlive(d)).toEqual({ selected: 2, refreshed: 1, skipped: 1, failed: 0 })
  })
  it('isolates a per-portal failure (dead grant) and keeps going', async () => {
    const { d, warns } = deps({
      selectNearExpiry: async () => ['A', 'B', 'C'],
      refreshPortal: async (m) => {
        if (m === 'B') throw new Error('invalid_grant')
        return 'refreshed'
      }
    })
    expect(await runTokenKeepAlive(d)).toEqual({ selected: 3, refreshed: 2, skipped: 0, failed: 1 })
    expect(warns.join()).toMatch(/refresh failed for member B: .*invalid_grant/)
  })
  it('a selection failure propagates (not swallowed)', async () => {
    const { d } = deps({
      selectNearExpiry: async () => {
        throw new Error('db down')
      }
    })
    await expect(runTokenKeepAlive(d)).rejects.toThrow('db down')
  })
  it('empty selection → all-zero, no work', async () => {
    const { d } = deps({ selectNearExpiry: async () => [] })
    expect(await runTokenKeepAlive(d)).toEqual({ selected: 0, refreshed: 0, skipped: 0, failed: 0 })
  })
  it('warns when the batch is saturated (selected === cap)', async () => {
    const ids = Array.from({ length: MAX_KEEP_ALIVE_BATCH }, (_, i) => `p${i}`)
    const { d, warns } = deps({ selectNearExpiry: async () => ids })
    await runTokenKeepAlive(d)
    expect(warns.some(w => w.includes('saturated'))).toBe(true)
  })
})

describe('keepAliveIntervalMs', () => {
  it('defaults to 24h, floors to 1h, floors fractional', () => {
    expect(keepAliveIntervalMs(24)).toBe(24 * 3_600_000)
    expect(keepAliveIntervalMs(0)).toBe(24 * 3_600_000)
    expect(keepAliveIntervalMs(-5)).toBe(24 * 3_600_000)
    expect(keepAliveIntervalMs(1)).toBe(3_600_000)
    expect(keepAliveIntervalMs(2.9)).toBe(2 * 3_600_000)
  })
  it('clamps the upper end so a huge setting cannot overflow setInterval', () => {
    const maxMs = MAX_KEEP_ALIVE_HOURS * 3_600_000
    expect(keepAliveIntervalMs(720)).toBe(maxMs)
    expect(keepAliveIntervalMs(100_000)).toBe(maxMs)
    expect(maxMs).toBeLessThan(2_147_483_647)
  })
})
