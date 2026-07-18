import { describe, expect, it, vi } from 'vitest'
import { rawOauthRefresh, verifyInstallMember, type InstallMemberDeps } from '../server/utils/verifyInstallMember'

const MEMBER = 'a1b2c3d4e5f6071829304a5b6c7d8e9f' // fake 32-hex portal id (never a real member_id)
const OTHER = 'ffffffffffffffffffffffffffffffff'

/** Deps with an injected refresh that resolves/rejects with `impl`. */
function deps(impl: () => Promise<unknown>): InstallMemberDeps {
  return { refresh: vi.fn(impl), clientId: 'cid', clientSecret: 'csec' }
}
const grantBody = (memberId: string) => ({
  access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, member_id: memberId,
  client_endpoint: 'https://p.bitrix24.by/rest/'
})

describe('verifyInstallMember (#162 install member_id binding)', () => {
  it('ok + ROTATED grant when the authoritative member_id matches', async () => {
    const r = await verifyInstallMember(MEMBER, 'delivered-rt', deps(async () => grantBody(MEMBER)))
    expect(r.ok).toBe(true)
    expect(r.grant).toEqual({ accessToken: 'AT2', refreshToken: 'RT2', clientEndpoint: 'https://p.bitrix24.by/rest/', expiresIn: 3600 })
  })

  it('matches case-insensitively (member_id is lower-case hex)', async () => {
    const r = await verifyInstallMember(MEMBER, 'rt', deps(async () => grantBody(MEMBER.toUpperCase())))
    expect(r.ok).toBe(true)
  })

  it('403 when the grant belongs to a DIFFERENT member_id (forged install)', async () => {
    const r = await verifyInstallMember(MEMBER, 'rt', deps(async () => grantBody(OTHER)))
    expect(r).toEqual({ ok: false, status: 403 })
  })

  it('403 on a rejected/forged grant (invalid_grant error body → not a genuine grant)', async () => {
    const r = await verifyInstallMember(MEMBER, 'rt', deps(async () => ({ error: 'invalid_grant', error_description: 'bad' })))
    expect(r).toEqual({ ok: false, status: 403 })
  })

  it('503 on wrong_client (OUR config, not a forgery → retryable, don\'t brand it 403)', async () => {
    const r = await verifyInstallMember(MEMBER, 'rt', deps(async () => ({ error: 'wrong_client' })))
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('503 on a transport failure (network) — cannot verify, do not trust', async () => {
    const r = await verifyInstallMember(MEMBER, 'rt', deps(() => Promise.reject(new Error('network down'))))
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('503 on a malformed success (no error, but no access/refresh token) — parseTokenResponse rejects', async () => {
    const r = await verifyInstallMember(MEMBER, 'rt', deps(async () => ({ scope: 'crm', member_id: MEMBER })))
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('503 when the grant does not echo a member_id (cannot bind → do not false-reject)', async () => {
    const r = await verifyInstallMember(MEMBER, 'rt', deps(async () => ({ ...grantBody(''), member_id: '' })))
    expect(r).toEqual({ ok: false, status: 503 })
  })

  it('503 (never throws) when the OAuth endpoint returns a JSON primitive, not an object', async () => {
    // A misconfigured proxy returning a bare string/number must not crash the `in` check → 500.
    for (const primitive of ['oops', 42, true, null]) {
      const r = await verifyInstallMember(MEMBER, 'rt', deps(async () => primitive))
      expect(r).toEqual({ ok: false, status: 503 })
    }
  })

  it('403 without calling out when the claimed id or refresh token is missing', async () => {
    const noRefresh = deps(async () => grantBody(MEMBER))
    expect(await verifyInstallMember(MEMBER, '', noRefresh)).toEqual({ ok: false, status: 403 })
    expect(await verifyInstallMember('', 'rt', noRefresh)).toEqual({ ok: false, status: 403 })
    expect(noRefresh.refresh).not.toHaveBeenCalled()
  })
})

describe('rawOauthRefresh (sanctioned non-SDK OAuth POST)', () => {
  it('POSTs to the FIXED oauth host with secrets in the BODY (never the URL)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a', refresh_token: 'r', member_id: MEMBER }) }))
    const out = await rawOauthRefresh(fetchFn as never)({ grant_type: 'refresh_token', client_id: 'cid', client_secret: 'sec', refresh_token: 'rt' })
    expect(out).toMatchObject({ member_id: MEMBER })
    const [url, init] = fetchFn.mock.calls[0] as [string, { method?: string, body?: string, signal?: unknown }]
    expect(url).toBe('https://oauth.bitrix.info/oauth/token/')
    expect(url).not.toMatch(/client_secret|refresh_token/) // secrets NOT in the URL
    expect(init.method).toBe('POST')
    expect(init.body).toContain('client_secret=sec')
    expect(init.body).toContain('refresh_token=rt')
    expect(init.signal).toBeInstanceOf(AbortSignal) // timeout-bounded
  })
})
