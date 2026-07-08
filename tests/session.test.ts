import { describe, expect, it } from 'vitest'
import { checkCredentials, resolveAuthConfig, signSession, verifySession } from '../server/utils/session'

const secret = 'test-secret-key'

describe('resolveAuthConfig', () => {
  it('reads password + secret; falls back secret to enc key', () => {
    expect(resolveAuthConfig({ OPERATOR_PASSWORD: 'p', OPERATOR_SESSION_SECRET: 's' })).toEqual({ password: 'p', secret: 's' })
    expect(resolveAuthConfig({ OPERATOR_PASSWORD: 'p', B24_TOKEN_ENC_KEY: 'k' }).secret).toBe('k')
    expect(resolveAuthConfig({})).toEqual({ password: '', secret: '' })
  })
})

describe('checkCredentials', () => {
  it('constant-time match; disabled when no password set', () => {
    const cfg = { password: 'hunter2', secret }
    expect(checkCredentials('hunter2', cfg)).toBe(true)
    expect(checkCredentials('wrong', cfg)).toBe(false)
    expect(checkCredentials('hunter2', { password: '', secret })).toBe(false) // disabled
    expect(checkCredentials('', { password: '', secret })).toBe(false)
  })
})

describe('signSession / verifySession', () => {
  it('round-trips a valid, in-window session', () => {
    const t = signSession(secret, 1000)
    expect(verifySession(t, secret, 2000, 10_000)).toEqual({ valid: true, issuedAt: 1000 })
  })
  it('rejects a bad signature / wrong secret', () => {
    const t = signSession(secret, 1000)
    expect(verifySession(t, 'other-secret', 2000, 10_000).valid).toBe(false)
    expect(verifySession(`${t}x`, secret, 2000, 10_000).valid).toBe(false)
  })
  it('rejects expired and future-dated tokens', () => {
    const t = signSession(secret, 1000)
    expect(verifySession(t, secret, 1000 + 10_001, 10_000).valid).toBe(false) // expired
    expect(verifySession(t, secret, 500, 10_000).valid).toBe(false) // issued in the future
  })
  it('rejects empty/garbage tokens and missing secret', () => {
    expect(verifySession('', secret, 1, 1).valid).toBe(false)
    expect(verifySession('nodot', secret, 1, 1).valid).toBe(false)
    expect(verifySession(signSession(secret, 1), '', 1, 1).valid).toBe(false)
  })
})
