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

  it('warns (not errors) on missing OAuth creds / Redis', () => {
    const r = checkBackendEnv({ B24_TOKEN_ENC_KEY: key32, DATABASE_URL: 'x', B24_APPLICATION_TOKEN: 't' })
    expect(r.errors).toEqual([])
    expect(r.warnings.some(w => /CLIENT_ID/.test(w))).toBe(true)
    expect(r.warnings.some(w => /REDIS_URL/.test(w))).toBe(true)
  })
})
