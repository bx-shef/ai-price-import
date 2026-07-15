import { describe, expect, it, vi } from 'vitest'
import {
  buildRefreshPersist,
  makeSdkRestCall,
  oauthParamsFromToken,
  saveInputFromOAuthParams,
  type OAuthCallClient,
  type SdkAjaxResult
} from '../server/utils/b24Sdk'
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

function fakeClient(result: SdkAjaxResult): OAuthCallClient {
  return {
    actions: { v2: { call: { make: vi.fn(async () => result) } } },
    setCallbackRefreshAuth: vi.fn()
  }
}

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
