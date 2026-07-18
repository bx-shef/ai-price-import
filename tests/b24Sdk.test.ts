import { describe, expect, it, vi } from 'vitest'
import {
  buildRefreshPersist,
  createPortalSdkResolver,
  makePortalSdkCall,
  makeSdkListCall,
  makeSdkRestCall,
  oauthParamsFromToken,
  rawTokenFromRefresh,
  saveInputFromOAuthParams,
  withTimeout,
  type OAuthCallClient,
  type SdkAjaxResult,
  type SdkListResult,
  type SdkPortalDeps,
  type SdkTransport
} from '../server/utils/b24Sdk'
import { parseTokenResponse } from '../server/utils/b24Oauth'
import type { B24OAuthParams } from '@bitrix24/b24jssdk'
import { fetchVatRates } from '../server/utils/portalVat'
import type { PortalToken } from '../server/utils/tokenStore'

const token: PortalToken = {
  memberId: 'm1', domain: 'p.bitrix24.ru', clientEndpoint: 'https://p.bitrix24.ru/rest/',
  accessToken: 'AT', refreshTokenEnc: 'ENC(RT)', applicationToken: 'APP',
  expiresIn: 3600, issuedAtMs: 1_000_000, refreshedAtMs: 1_000_000
}
const decrypt = (e: string) => e.replace(/^ENC\((.*)\)$/, '$1')
const encrypt = (p: string) => `ENC(${p})`

describe('oauthParamsFromToken', () => {
  it('decrypts refresh, derives expires from issuedAtMs+expiresIn, builds endpoints', () => {
    const p = oauthParamsFromToken(token, { nowMs: 1_000_000, decrypt, scope: 'crm' })
    expect(p.refreshToken).toBe('RT') // decrypted
    expect(p.accessToken).toBe('AT')
    expect(p.memberId).toBe('m1')
    expect(p.expires).toBe(Math.floor((1_000_000 + 3600 * 1000) / 1000)) // absolute unix seconds
    expect(p.expiresIn).toBe(3600) // remaining at nowMs
    expect(p.clientEndpoint).toBe('https://p.bitrix24.ru/rest/')
    expect(p.serverEndpoint).toBe('https://oauth.bitrix.info/rest/')
    expect(p.scope).toBe('crm')
    expect(p.applicationToken).toBe('APP')
  })
  it('clamps a past-expiry token to expiresIn 0; empty refresh when none stored', () => {
    const p = oauthParamsFromToken({ ...token, refreshTokenEnc: '' }, { nowMs: 1_000_000 + 10 * 3600_000, decrypt })
    expect(p.expiresIn).toBe(0)
    expect(p.refreshToken).toBe('')
  })
})

describe('saveInputFromOAuthParams', () => {
  it('re-encrypts refresh and stamps issued/refreshed at nowMs', () => {
    const p = oauthParamsFromToken(token, { nowMs: 1_000_000, decrypt })
    const input = saveInputFromOAuthParams({ ...p, accessToken: 'AT2', refreshToken: 'RT2' }, { nowMs: 5_000_000, encrypt })
    expect(input).toMatchObject({
      memberId: 'm1', domain: 'p.bitrix24.ru', accessToken: 'AT2',
      refreshTokenEnc: 'ENC(RT2)', applicationToken: 'APP', issuedAtMs: 5_000_000, refreshedAtMs: 5_000_000
    })
  })
})

describe('buildRefreshPersist', () => {
  it('maps the SDK refresh callback → save(SaveTokenInput) with re-encrypted refresh', async () => {
    const save = vi.fn(async () => {})
    const cb = buildRefreshPersist(save, { now: () => 7_000_000, encrypt })
    const p = oauthParamsFromToken(token, { nowMs: 1_000_000, decrypt })
    await cb({ b24OAuthParams: { ...p, accessToken: 'AT3', refreshToken: 'RT3' } } as never)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'AT3', refreshTokenEnc: 'ENC(RT3)', issuedAtMs: 7_000_000 }))
  })
})

function fakeClient(result: SdkAjaxResult, listResult?: SdkListResult): OAuthCallClient {
  return {
    actions: {
      v2: {
        call: { make: vi.fn(async () => result) },
        callList: { make: vi.fn(async () => listResult ?? { getData: () => [] }) }
      }
    },
    setCallbackRefreshAuth: vi.fn(),
    setCustomRefreshAuth: vi.fn(),
    auth: { refreshAuth: vi.fn(async () => false) },
    setRestrictionManagerParams: vi.fn()
  }
}

describe('makePortalSdkCall', () => {
  // The sole crm-sync portal transport. The no-token guard returns BEFORE constructing a
  // real B24OAuth, so it is unit-testable; the token-present path (live B24OAuth + refresh
  // wiring) is covered by the live smoke test (pnpm sdk:smoke).
  const deps = (loadToken: SdkPortalDeps['loadToken']): SdkPortalDeps => ({
    loadToken,
    saveToken: vi.fn(async () => {}),
    creds: { clientId: 'cid', clientSecret: 'csec' },
    now: () => 1_000_000,
    decrypt,
    encrypt
  })
  it('returns null when the portal has no stored token (never builds a client)', async () => {
    const loadToken = vi.fn(async () => null)
    expect(await makePortalSdkCall('m1', deps(loadToken))).toBeNull()
    expect(loadToken).toHaveBeenCalledWith('m1')
  })
})

describe('makeSdkListCall', () => {
  const ok: SdkAjaxResult = { isSuccess: true, getData: () => ({ result: [] }), getErrorMessages: () => [] }

  it('returns the SDK-collected full row array (no opts → plain method+params)', async () => {
    const client = fakeClient(ok, { getData: () => [{ ID: '1' }, { ID: '2' }] })
    const rows = await makeSdkListCall(client)('crm.vat.list', { filter: { ACTIVE: 'Y' } })
    expect(rows).toEqual([{ ID: '1' }, { ID: '2' }])
    expect((client.actions.v2.callList.make as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
      method: 'crm.vat.list', params: { filter: { ACTIVE: 'Y' } }
    })
  })

  it('maps idKey/listKey opts → SDK idKey/customKeyForResult (grouped methods)', async () => {
    const client = fakeClient(ok, { getData: () => [{ id: 93 }] })
    const rows = await makeSdkListCall(client)('catalog.productProperty.list', { filter: { iblockId: 25 } }, { idKey: 'id', listKey: 'productProperties' })
    expect(rows).toEqual([{ id: 93 }])
    expect((client.actions.v2.callList.make as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
      method: 'catalog.productProperty.list', params: { filter: { iblockId: 25 } }, idKey: 'id', customKeyForResult: 'productProperties'
    })
  })

  it('coerces non-array data (empty portal) to []', async () => {
    const listCall = makeSdkListCall(fakeClient(ok, { getData: () => undefined }))
    expect(await listCall('crm.vat.list')).toEqual([])
  })
})

describe('fetchVatRates (SDK full-list, #87)', () => {
  it('fetches every rate via the list caller and maps rate/null', async () => {
    const listCall = makeSdkListCall(fakeClient(
      { isSuccess: true, getData: () => ({ result: [] }), getErrorMessages: () => [] },
      { getData: () => [{ ID: '1', NAME: '20%', RATE: '20' }, { ID: '9', NAME: 'Без НДС', RATE: null }] }
    ))
    const rates = await fetchVatRates(listCall)
    expect(rates).toEqual([{ id: '1', name: '20%', rate: 20 }, { id: '9', name: 'Без НДС', rate: null }])
  })
})

describe('withTimeout (refresh lock-safety guard)', () => {
  it('resolves a fast promise and clears the timer (no dangling timer)', async () => {
    vi.useFakeTimers()
    try {
      await expect(withTimeout(Promise.resolve('ok'), 10_000)).resolves.toBe('ok')
      expect(vi.getTimerCount()).toBe(0) // proves clearTimeout ran — fails if removed
    } finally {
      vi.useRealTimers()
    }
  })
  it('propagates a fast rejection as-is and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      await expect(withTimeout(Promise.reject(new Error('grant dead')), 10_000)).rejects.toThrow('grant dead')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('rejects with a timeout error when the promise outlives the deadline', async () => {
    const never = new Promise<string>(() => {}) // never settles
    await expect(withTimeout(never, 5)).rejects.toThrow(/no response within 5ms/)
  })
})

describe('rawTokenFromRefresh (SDK refresh → raw token JSON, #b24jssdk)', () => {
  const captured = {
    accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600, expires: 1_700_000_000,
    clientEndpoint: 'https://p.bitrix24.ru/rest/', serverEndpoint: 'https://oauth.bitrix.info/rest/',
    scope: 'crm,im', status: 'L', memberId: 'm1'
  } as B24OAuthParams
  it('prefers the captured params (fullest — carries client_endpoint/scope/status)', () => {
    const raw = rawTokenFromRefresh(captured, false)
    expect(raw).toMatchObject({
      access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600,
      client_endpoint: 'https://p.bitrix24.ru/rest/', scope: 'crm,im', status: 'L', member_id: 'm1'
    })
  })
  it('falls back to authData when the callback did not capture (e.g. only refreshAuth return)', () => {
    const raw = rawTokenFromRefresh(undefined, { access_token: 'AT9', refresh_token: 'RT9', expires: 0, expires_in: 3600, domain: 'p.bitrix24.ru', member_id: 'm1' })
    expect(raw.access_token).toBe('AT9')
    expect(raw.refresh_token).toBe('RT9')
    expect(raw.member_id).toBe('m1')
  })
  it('leaves tokens UNDEFINED when neither source has them (fail-closed — parseTokenResponse then throws, no blank-credential persist)', () => {
    const raw = rawTokenFromRefresh(undefined, false)
    expect(raw.access_token).toBeUndefined()
    expect(raw.refresh_token).toBeUndefined()
    // The downstream guard must reject it (would otherwise UPDATE the portal row to empty creds).
    expect(() => parseTokenResponse(raw)).toThrow(/invalid token response/)
  })
})

describe('createPortalSdkResolver (per-portal memoization, #123/#163)', () => {
  // A fake transport whose call/list can be told to throw, and which records identity so the
  // test can prove memoization (same object) vs rebuild (new object).
  function fakeTransport(id: number, throwOnCall = false): SdkTransport {
    return {
      call: vi.fn(async () => {
        if (throwOnCall) throw new Error('boom')
        return { id }
      }),
      list: vi.fn(async () => [{ id }])
    }
  }

  it('memoizes ONE transport per portal within the TTL (build runs once for N calls)', async () => {
    const build = vi.fn(async () => fakeTransport(1))
    let clock = 1000
    const resolver = createPortalSdkResolver(build, () => clock, 60_000)
    const a = await resolver('m1')
    const b = await resolver('m1')
    clock += 59_000 // still inside the TTL
    const c = await resolver('m1')
    expect(build).toHaveBeenCalledTimes(1) // one client for all three resolves
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('rebuilds after the TTL lapses (backstop against a stale in-memory token)', async () => {
    const build = vi.fn(async () => fakeTransport(1))
    let clock = 1000
    const resolver = createPortalSdkResolver(build, () => clock, 60_000)
    await resolver('m1')
    clock += 60_001 // past the TTL
    await resolver('m1')
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('keeps separate clients per portal', async () => {
    let n = 0
    const build = vi.fn(async () => fakeTransport(++n))
    const resolver = createPortalSdkResolver(build, () => 1000, 60_000)
    const a = await resolver('m1')
    const b = await resolver('m2')
    expect(a).not.toBe(b)
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('EVICTS on a failed call so the NEXT resolve rebuilds from a fresh token (#163 wedge heal)', async () => {
    const bad = fakeTransport(1, true) // its .call throws
    const good = fakeTransport(2)
    const build = vi.fn(async () => (build.mock.calls.length === 1 ? bad : good))
    const resolver = createPortalSdkResolver(build, () => 1000, 60_000)
    const t1 = await resolver('m1')
    await expect(t1!.call('crm.item.list')).rejects.toThrow('boom') // triggers evict-on-error
    const t2 = await resolver('m1')
    expect(build).toHaveBeenCalledTimes(2) // rebuilt despite being inside the TTL
    expect(t2).not.toBe(t1)
    await expect(t2!.call('crm.item.list')).resolves.toEqual({ id: 2 })
  })

  it('returns null when the portal has no token (build → null), without caching', async () => {
    const build = vi.fn(async () => null)
    const resolver = createPortalSdkResolver(build, () => 1000, 60_000)
    expect(await resolver('m1')).toBeNull()
    expect(await resolver('m1')).toBeNull()
    expect(build).toHaveBeenCalledTimes(2) // a null build is not memoized (retried next time)
  })

  it('evict() drops the cached client so the next resolve rebuilds', async () => {
    const build = vi.fn(async () => fakeTransport(1))
    const resolver = createPortalSdkResolver(build, () => 1000, 60_000)
    await resolver('m1')
    resolver.evict('m1')
    await resolver('m1')
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('EVICTS on a failed LIST too (parity with call — the wedge heals either way)', async () => {
    const bad: SdkTransport = {
      call: vi.fn(async () => ({})),
      list: vi.fn(async () => {
        throw new Error('boom')
      })
    }
    const good = fakeTransport(2)
    const build = vi.fn(async () => (build.mock.calls.length === 1 ? bad : good))
    const resolver = createPortalSdkResolver(build, () => 1000, 60_000)
    const t1 = await resolver('m1')
    await expect(t1!.list('crm.vat.list')).rejects.toThrow('boom') // evict-on-error via list
    await resolver('m1')
    expect(build).toHaveBeenCalledTimes(2) // rebuilt inside the TTL because list failed
  })

  it('does NOT evict a FRESH client when a STALE (already-replaced) client later errors (identity check)', async () => {
    const stale = fakeTransport(1, true) // .call throws
    const fresh = fakeTransport(2)
    let n = 0
    const build = vi.fn(async () => (++n === 1 ? stale : fresh))
    let clock = 1000
    const resolver = createPortalSdkResolver(build, () => clock, 60_000)
    const t1 = await resolver('m1') // caches `stale`
    clock += 60_001 // lapse TTL
    const t2 = await resolver('m1') // rebuilds → caches `fresh` (build #2)
    expect(t2).not.toBe(t1)
    // Now fire the STALE client's error. Its evictSelf must find `fresh` in the map (not `stale`)
    // and NO-OP — else it would wrongly drop the fresh client.
    await expect(t1!.call('crm.item.list')).rejects.toThrow('boom')
    await resolver('m1') // still inside `fresh`'s TTL → must be served from cache (no rebuild)
    expect(build).toHaveBeenCalledTimes(2) // 2, not 3 → fresh survived the stale error
  })

  it('serves at just-under TTL and rebuilds at exactly TTL (boundary of `< ttlMs`)', async () => {
    const build = vi.fn(async () => fakeTransport(1))
    let clock = 1000
    const resolver = createPortalSdkResolver(build, () => clock, 60_000)
    await resolver('m1')
    clock += 59_999 // < ttlMs → cached
    await resolver('m1')
    expect(build).toHaveBeenCalledTimes(1)
    clock = 1000 + 60_000 // exactly ttlMs → 60000 < 60000 is false → rebuild
    await resolver('m1')
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('sweeps TTL-lapsed entries on insert so idle portals do not accumulate (bounded working set)', async () => {
    let n = 0
    const build = vi.fn(async () => fakeTransport(++n))
    let clock = 1000
    const resolver = createPortalSdkResolver(build, () => clock, 60_000)
    await resolver('m1')
    await resolver('m2')
    expect(resolver.size()).toBe(2)
    clock += 60_001 // both m1 and m2 lapse
    await resolver('m3') // insert triggers a sweep of the expired m1/m2
    expect(resolver.size()).toBe(1) // only the freshly-built m3 remains — idle ones reclaimed
  })
})

describe('makeSdkRestCall', () => {
  it('returns the UNWRAPPED result (ai-price-import contract)', async () => {
    const call = makeSdkRestCall(fakeClient({ isSuccess: true, getData: () => ({ result: [1, 2], time: {} }), getErrorMessages: () => [] }))
    expect(await call('crm.product.list', { filter: {} })).toEqual([1, 2])
  })
  it('throws the SDK error messages on failure', async () => {
    const call = makeSdkRestCall(fakeClient({ isSuccess: false, getData: () => null, getErrorMessages: () => ['QUERY_LIMIT_EXCEEDED'] }))
    await expect(call('crm.item.list')).rejects.toThrow(/QUERY_LIMIT_EXCEEDED/)
  })
  it('tolerates a missing result key', async () => {
    const call = makeSdkRestCall(fakeClient({ isSuccess: true, getData: () => ({ time: {} }), getErrorMessages: () => [] }))
    expect(await call('m')).toBeUndefined()
  })
})
