import { describe, expect, it, vi } from 'vitest'
import { verifyInstallToken } from '../server/utils/verifyInstallToken'
import type { RestCall } from '../server/utils/b24Rest'

const domain = 'p.bitrix24.by'

/** A fake bare-token call-factory: every call resolves/rejects with `impl`. */
function fakeMakeCall(impl: RestCall) {
  const factory = vi.fn((_domain: string, _token: string) => impl)
  return { factory, call: impl }
}

describe('verifyInstallToken', () => {
  it('ok when the delivered access token controls the portal', async () => {
    const { factory } = fakeMakeCall(async () => ({ ID: '1' }))
    expect(await verifyInstallToken(domain, 'tok', factory)).toEqual({ ok: true })
    expect(factory).toHaveBeenCalledOnce()
  })

  it('403 when the access token is rejected (forged/expired install)', async () => {
    const { factory } = fakeMakeCall(() => Promise.reject(new Error('invalid_token')))
    expect(await verifyInstallToken(domain, 'tok', factory)).toEqual({ ok: false, status: 403 })
  })

  it('503 on a transport failure (cannot verify now — do not trust)', async () => {
    const { factory } = fakeMakeCall(() => Promise.reject(new Error('network down')))
    expect(await verifyInstallToken(domain, 'tok', factory)).toEqual({ ok: false, status: 503 })
  })

  it('403 without calling out when domain or token is missing', async () => {
    const { factory } = fakeMakeCall(async () => ({ ID: 1 }))
    expect(await verifyInstallToken('', 'tok', factory)).toEqual({ ok: false, status: 403 })
    expect(await verifyInstallToken(domain, '', factory)).toEqual({ ok: false, status: 403 })
    expect(factory).not.toHaveBeenCalled()
  })

  it('an unsafe (non-Bitrix24) domain is refused via the real SDK guard (503, no network)', async () => {
    // No injected factory → the real makeBareTokenSdkCall runs; its SSRF guard rejects an
    // unsafe host with UNSAFE_DOMAIN (not an auth rejection) → transport-class → 503, no network.
    const r = await verifyInstallToken('evil.example.com', 'tok')
    expect(r).toEqual({ ok: false, status: 503 })
  })
})
