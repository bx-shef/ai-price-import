import { describe, expect, it } from 'vitest'
import { computePortalHealth, buildPortalStatuses, REFRESH_LIFETIME_DAYS, NEAR_EXPIRY_DAYS } from '../server/utils/portalStatus'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

describe('computePortalHealth', () => {
  it('ok when comfortably within the refresh lifetime', () => {
    const r = computePortalHealth(NOW - 10 * DAY, NOW)
    expect(r).toEqual({ ageDays: 10, expiresInDays: REFRESH_LIFETIME_DAYS - 10, health: 'ok' })
  })
  it('near-expiry within the warning window (boundary at exactly NEAR_EXPIRY_DAYS left)', () => {
    const r = computePortalHealth(NOW - (REFRESH_LIFETIME_DAYS - NEAR_EXPIRY_DAYS) * DAY, NOW)
    expect(r.expiresInDays).toBe(NEAR_EXPIRY_DAYS)
    expect(r.health).toBe('near-expiry')
  })
  it('stale once past the lifetime (expiresInDays <= 0)', () => {
    const r = computePortalHealth(NOW - (REFRESH_LIFETIME_DAYS + 20) * DAY, NOW)
    expect(r.expiresInDays).toBe(-20)
    expect(r.health).toBe('stale')
  })
  it('clamps a future/invalid timestamp to age 0 (defensive; a real row always has updated_at)', () => {
    expect(computePortalHealth(NOW + 5 * DAY, NOW).ageDays).toBe(0)
    expect(computePortalHealth(0, NOW)).toEqual({ ageDays: 0, expiresInDays: REFRESH_LIFETIME_DAYS, health: 'ok' })
    expect(computePortalHealth(Number.NaN, NOW).ageDays).toBe(0)
  })
})

describe('buildPortalStatuses', () => {
  it('maps rows and sorts soonest-to-expire first', () => {
    const out = buildPortalStatuses([
      { memberId: 'm1', domain: 'a.bitrix24.by', updatedAtMs: NOW - 10 * DAY },
      { memberId: 'm2', domain: 'b.bitrix24.by', updatedAtMs: NOW - 175 * DAY },
      { memberId: 'm3', domain: 'c.bitrix24.by', updatedAtMs: NOW - 200 * DAY }
    ], NOW)
    expect(out.map(p => p.memberId)).toEqual(['m3', 'm2', 'm1']) // -20, 5, 170 days left
    expect(out.map(p => p.health)).toEqual(['stale', 'near-expiry', 'ok'])
    expect(out[0]!.domain).toBe('c.bitrix24.by')
  })
  it('returns [] for no portals', () => {
    expect(buildPortalStatuses([], NOW)).toEqual([])
  })
})
