import { describe, expect, it, vi } from 'vitest'
import { verifyInstallToken } from '../server/utils/verifyInstallToken'

const domain = 'p.bitrix24.by'

describe('verifyInstallToken', () => {
  it('ok when the delivered access token controls the portal', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { ID: '1' } }) }))
    expect(await verifyInstallToken(domain, 'tok', fetchFn)).toEqual({ ok: true })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('403 when the access token is rejected (forged/expired install)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) }))
    const r = await verifyInstallToken(domain, 'tok', fetchFn)
    expect(r).toEqual({ ok: false, status: 403 })
  })

  it('503 on a transport failure (cannot verify now — do not trust)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(await verifyInstallToken(domain, 'tok', fetchFn)).toEqual({ ok: false, status: 503 })
  })

  it('403 without calling out when domain or token is missing', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }) }))
    expect(await verifyInstallToken('', 'tok', fetchFn)).toEqual({ ok: false, status: 403 })
    expect(await verifyInstallToken(domain, '', fetchFn)).toEqual({ ok: false, status: 403 })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('an unsafe (non-Bitrix24) domain is refused, not called', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: 1 }) }))
    // restUrl throws UNSAFE_DOMAIN → not an auth rejection → transport-class → 503.
    const r = await verifyInstallToken('evil.example.com', 'tok', fetchFn)
    expect(r.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
