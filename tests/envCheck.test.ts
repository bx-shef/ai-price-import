import { describe, expect, it } from 'vitest'
import { checkBackendEnv } from '../server/utils/envCheck'

const key32 = Buffer.alloc(32).toString('base64')

describe('checkBackendEnv', () => {
  it('clean env → no errors', () => {
    const r = checkBackendEnv({
      B24_TOKEN_ENC_KEY: key32,
      DATABASE_URL: 'postgres://x',
      B24_APPLICATION_TOKEN: 'realtoken123',
      B24_CLIENT_ID: 'id',
      B24_CLIENT_SECRET: 'sec',
      REDIS_URL: 'redis://x'
    })
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('flags missing/short key, missing DB, placeholder token', () => {
    const r = checkBackendEnv({ B24_TOKEN_ENC_KEY: Buffer.alloc(16).toString('base64'), B24_APPLICATION_TOKEN: 'CHANGE_ME' })
    expect(r.errors.some(e => /32 bytes/.test(e))).toBe(true)
    expect(r.errors.some(e => /DATABASE_URL/.test(e))).toBe(true)
    expect(r.errors.some(e => /placeholder/.test(e))).toBe(true)
  })

  it('empty B24_APPLICATION_TOKEN is OK (optional — installs authenticate via access_token)', () => {
    // No token set: not an error. application_token is learned from ONAPPINSTALL.
    const r = checkBackendEnv({ B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_CLIENT_ID: 'i', B24_CLIENT_SECRET: 's', REDIS_URL: 'r' })
    expect(r.errors).toEqual([])
    expect(r.errors.some(e => /APPLICATION_TOKEN/.test(e))).toBe(false)
  })

  it('warns (not errors) on missing OAuth creds / Redis', () => {
    const r = checkBackendEnv({ B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_APPLICATION_TOKEN: 't' })
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => /CLIENT_ID/.test(w))).toBe(true)
    expect(r.warnings.some(w => /REDIS_URL/.test(w))).toBe(true)
  })

  it('operator secret: weak → warn; enc-key fallback → key-separation warn; strong → none', () => {
    const base = { B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_APPLICATION_TOKEN: 't', B24_CLIENT_ID: 'i', B24_CLIENT_SECRET: 's', REDIS_URL: 'r' }
    // weak explicit secret
    expect(checkBackendEnv({ ...base, OPERATOR_PASSWORD: 'p', OPERATOR_SESSION_SECRET: 'short' }).warnings.some(w => /weak/.test(w))).toBe(true)
    // fallback to enc key (strong length) → key-separation warning
    expect(checkBackendEnv({ ...base, OPERATOR_PASSWORD: 'p' }).warnings.some(w => /key separation/.test(w))).toBe(true)
    // strong dedicated secret → no operator warning
    expect(checkBackendEnv({ ...base, OPERATOR_PASSWORD: 'p', OPERATOR_SESSION_SECRET: 'a-strong-secret-32-characters-long' }).warnings.some(w => /secret/i.test(w))).toBe(false)
    // no operator password → no operator warnings at all
    expect(checkBackendEnv({ ...base, OPERATOR_SESSION_SECRET: 'short' }).warnings.some(w => /OPERATOR/.test(w))).toBe(false)
  })
})
