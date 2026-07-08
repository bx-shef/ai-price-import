import { describe, expect, it } from 'vitest'
import { buildRefreshParams, parseTokenResponse } from '../server/utils/b24Oauth'
import { isAccessTokenExpired, needsProactiveRefresh } from '../server/utils/accessToken'
import { decodeKey, decryptSecret, encryptSecret } from '../server/utils/secretCrypto'

describe('b24Oauth', () => {
  it('builds refresh params', () => {
    expect(buildRefreshParams('id', 'sec', 'rt')).toEqual({ grant_type: 'refresh_token', client_id: 'id', client_secret: 'sec', refresh_token: 'rt' })
  })
  it('parses a valid token response', () => {
    const t = parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600, member_id: 'm', client_endpoint: 'https://p/rest/' })
    expect(t.access_token).toBe('a')
    expect(t.expires_in).toBe(3600)
  })
  it('throws on error response', () => {
    expect(() => parseTokenResponse({ error: 'PAYMENT_REQUIRED', error_description: 'Payment required' })).toThrow(/Payment required/)
  })
})

describe('accessToken lifetime', () => {
  const t0 = 1_000_000_000_000
  it('access token expiry with skew', () => {
    expect(isAccessTokenExpired(t0, 3600, t0 + 3600_000 - 30_000)).toBe(true) // within 60s skew
    expect(isAccessTokenExpired(t0, 3600, t0 + 1000)).toBe(false)
  })
  it('proactive refresh only within 3 days of 180d expiry', () => {
    const day = 86_400_000
    expect(needsProactiveRefresh(t0, t0 + 100 * day)).toBe(false)
    expect(needsProactiveRefresh(t0, t0 + 178 * day)).toBe(true) // < 3 days left
  })
})

describe('secretCrypto', () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  it('round-trips', () => {
    const enc = encryptSecret('refresh-token-123', key)
    expect(enc).not.toContain('refresh-token-123')
    expect(decryptSecret(enc, key)).toBe('refresh-token-123')
  })
  it('rejects wrong-size key', () => {
    expect(() => decodeKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/)
  })
})
