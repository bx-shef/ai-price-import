import { describe, expect, it } from 'vitest'
import { OP_MAX_AGE_MS, operatorAllowed, opsTokenOk } from '../server/utils/operatorSession'
import { signSession } from '../server/utils/session'

const env = { OPERATOR_PASSWORD: 'p', OPERATOR_SESSION_SECRET: 'sekret' }

describe('operatorAllowed', () => {
  it('true for a fresh valid cookie', () => {
    const cookie = signSession('sekret', 1_000_000)
    expect(operatorAllowed(cookie, env, 1_000_000 + 5000)).toBe(true)
  })
  it('false for missing / tampered / expired cookie', () => {
    expect(operatorAllowed(undefined, env, 1)).toBe(false)
    expect(operatorAllowed('garbage', env, 1)).toBe(false)
    const cookie = signSession('sekret', 1000)
    expect(operatorAllowed(cookie, env, 1000 + OP_MAX_AGE_MS + 1)).toBe(false) // expired
    expect(operatorAllowed(cookie, { OPERATOR_SESSION_SECRET: 'other' }, 2000)).toBe(false) // wrong secret
  })
})

describe('opsTokenOk', () => {
  it('constant-time match; fail-closed when the expected token is unset', () => {
    expect(opsTokenOk('secret-token', 'secret-token')).toBe(true)
    expect(opsTokenOk('secret-token', 'nope')).toBe(false)
    expect(opsTokenOk('', '')).toBe(false) // unset ⇒ deny (empty header must not pass)
    expect(opsTokenOk('', 'anything')).toBe(false)
  })
})
