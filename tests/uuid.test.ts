import { describe, expect, it, afterEach } from 'vitest'
import { uuidv4 } from '../app/utils/uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('uuidv4', () => {
  const realCrypto = globalThis.crypto
  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true })
  })

  it('returns a valid v4 UUID (version + variant nibbles set)', () => {
    for (let i = 0; i < 50; i++) expect(uuidv4()).toMatch(UUID_RE)
  })
  it('is unique across calls', () => {
    const s = new Set(Array.from({ length: 500 }, () => uuidv4()))
    expect(s.size).toBe(500)
  })
  it('FALLBACK: still a valid v4 UUID when crypto is entirely unavailable (non-secure context)', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
    for (let i = 0; i < 50; i++) expect(uuidv4()).toMatch(UUID_RE)
  })
  it('FALLBACK: uses getRandomValues when randomUUID is missing', () => {
    Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }, configurable: true })
    expect(uuidv4()).toMatch(UUID_RE)
  })
})
