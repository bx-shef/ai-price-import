import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  REDACT_ATTR_KEYS,
  SAFE_MANUAL_ATTR_KEYS,
  isRedactedKey,
  pickSafeAttributes,
  portalHash,
  redactAttributes
} from '../server/utils/telemetryAttributes'

describe('pickSafeAttributes (manual-span allowlist)', () => {
  it('keeps allowlisted primitive keys', () => {
    expect(pickSafeAttributes({
      'dep.system': 'bitrix24',
      'dep.status': 'ok',
      'job.op_count': 5,
      'job.ok': true,
      'proc.lines': 12,
      'proc.created': true,
      'portal.hash': 'abc123'
    })).toEqual({
      'dep.system': 'bitrix24',
      'dep.status': 'ok',
      'job.op_count': 5,
      'job.ok': true,
      'proc.lines': 12,
      'proc.created': true,
      'portal.hash': 'abc123'
    })
  })

  it('drops non-allowlisted keys (e.g. a smuggled supplier / article / price / УНП)', () => {
    expect(pickSafeAttributes({
      'dep.system': 'bitrix24',
      'supplier': 'ООО Ромашка',
      'article': 'ART-1042',
      'price': 1840,
      'unp': '190000000'
    })).toEqual({ 'dep.system': 'bitrix24' })
  })

  it('drops object/null values even under an allowlisted key (no payload smuggling)', () => {
    expect(pickSafeAttributes({ 'dep.system': { nested: 'x' }, 'dep.status': null, 'dep.method': 'GET' }))
      .toEqual({ 'dep.method': 'GET' })
  })

  it('drops an array value (only scalars allowed — no payload smuggling)', () => {
    expect(pickSafeAttributes({ 'proc.warnings': [1, 2, 3], 'proc.lines': 2 })).toEqual({ 'proc.lines': 2 })
  })

  it('the allowlist contains no obviously-sensitive key', () => {
    for (const k of SAFE_MANUAL_ATTR_KEYS) {
      expect(/purpose|amount|price|supplier|article|product|inn|unp|назнач|цена|поставщ|артикул|товар|инн|унп/i.test(k)).toBe(false)
    }
  })
})

describe('isRedactedKey (auto-instrumentation scrub)', () => {
  it('redacts SQL text and URL/query keys (can carry literals / tokens)', () => {
    expect(isRedactedKey('db.statement')).toBe(true)
    expect(isRedactedKey('db.query.text')).toBe(true)
    expect(isRedactedKey('http.url')).toBe(true)
    expect(isRedactedKey('url.query')).toBe(true)
  })
  it('redacts by sensitive marker substring (body/token/secret/authorization/cookie)', () => {
    expect(isRedactedKey('http.request.body')).toBe(true)
    expect(isRedactedKey('custom.access_token')).toBe(true)
    expect(isRedactedKey('req.Authorization')).toBe(true)
    expect(isRedactedKey('set-cookie')).toBe(true)
  })
  it('keeps safe shape keys', () => {
    expect(isRedactedKey('http.method')).toBe(false)
    expect(isRedactedKey('db.system')).toBe(false)
    expect(isRedactedKey('net.peer.name')).toBe(false)
  })
})

describe('redactAttributes', () => {
  it('strips sensitive keys, keeps safe ones, does not mutate input', () => {
    const input = { 'http.method': 'POST', 'db.statement': 'SELECT * FROM x WHERE acc=$1', 'net.peer.name': 'oauth.bitrix.info' }
    const out = redactAttributes(input)
    expect(out).toEqual({ 'http.method': 'POST', 'net.peer.name': 'oauth.bitrix.info' })
    expect(input['db.statement']).toBe('SELECT * FROM x WHERE acc=$1') // unchanged
  })
})

describe('preload redact list parity (no drift with the canonical TS list)', () => {
  // The preload otel.instrument.mjs can't import the TS bundle, so it INLINES the redact keys.
  // This guards against the two lists drifting apart (a new sensitive key added to one only).
  const preload = readFileSync(fileURLToPath(new URL('../otel.instrument.mjs', import.meta.url)), 'utf8')
  it('every canonical REDACT_ATTR_KEY appears in the preload', () => {
    for (const key of REDACT_ATTR_KEYS) {
      expect(preload).toContain(`'${key}'`)
    }
  })
  it('the preload shares the same sensitive markers', () => {
    for (const marker of ['body', 'payload', 'token', 'secret', 'password', 'authorization', 'cookie']) {
      expect(preload).toContain(`'${marker}'`)
    }
  })
})

describe('portalHash', () => {
  it('is stable, short hex, and non-reversible (not the member id)', () => {
    const h = portalHash('member-123')
    expect(h).toMatch(/^[0-9a-f]{12}$/)
    expect(h).not.toContain('member-123')
    expect(portalHash('member-123')).toBe(h) // stable
    expect(portalHash('member-456')).not.toBe(h) // distinct
  })
  it('maps empty/absent to "unknown" without throwing', () => {
    expect(portalHash('')).toBe('unknown')
    expect(portalHash(undefined)).toBe('unknown')
    expect(portalHash(null)).toBe('unknown')
  })
})
