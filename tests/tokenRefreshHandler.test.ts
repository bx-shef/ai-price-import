import { describe, expect, it, vi } from 'vitest'
import { handleTokenRefresh } from '../server/utils/tokenRefreshHandler'

const MEMBER = 'a1b2c3d4e5f6071829304a5b6c7d8e9f' // fake 32-hex portal id (never a real member_id)

describe('handleTokenRefresh', () => {
  it('503 when OAuth is not configured (no client id/secret)', async () => {
    const reauth = vi.fn(async () => 'refreshed' as const)
    const r = await handleTokenRefresh(MEMBER, { configured: false, reauth })
    expect(r.status).toBe(503)
    expect(reauth).not.toHaveBeenCalled() // never attempt a refresh we can't do
  })

  it('400 for a missing / non-hex / non-string memberId (before any lock/query)', async () => {
    const reauth = vi.fn(async () => 'refreshed' as const)
    for (const bad of ['', '  ', 'not-hex!!', 'DROP TABLE', 42, null, undefined, 'ab']) {
      const r = await handleTokenRefresh(bad, { configured: true, reauth })
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
    expect(reauth).not.toHaveBeenCalled()
  })

  it('200 { ok:true } on a successful rotation (trims the id)', async () => {
    const reauth = vi.fn(async () => 'refreshed' as const)
    const r = await handleTokenRefresh(`  ${MEMBER}  `, { configured: true, reauth })
    expect(reauth).toHaveBeenCalledWith(MEMBER)
    expect(r).toEqual({ status: 200, body: { ok: true, outcome: 'refreshed' } })
  })

  it('accepts the length bounds and uppercase hex (pins the {8,64} + case-insensitive regex)', async () => {
    const reauth = vi.fn(async () => 'refreshed' as const)
    for (const ok of ['a1b2c3d4', 'ABCDEF0123456789', 'A1B2C3D4E5F6071829304A5B6C7D8E9F']) {
      expect((await handleTokenRefresh(ok, { configured: true, reauth })).status, ok).toBe(200)
    }
  })

  it('409 when the portal is not installed (vanished)', async () => {
    const r = await handleTokenRefresh(MEMBER, { configured: true, reauth: async () => 'not-installed' })
    expect(r.status).toBe(409)
  })

  it('502 when the refresh fails (dead/rejected grant)', async () => {
    const r = await handleTokenRefresh(MEMBER, { configured: true, reauth: async () => 'failed' })
    expect(r.status).toBe(502)
  })

  it('never returns a token in the body (non-secret contract)', async () => {
    const r = await handleTokenRefresh(MEMBER, { configured: true, reauth: async () => 'refreshed' })
    expect(JSON.stringify(r.body)).not.toMatch(/token|access|refresh_/i)
  })
})
