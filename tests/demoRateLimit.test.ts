import { describe, expect, it } from 'vitest'
import { clientKey, createRateLimiter } from '../server/utils/demoRateLimit'

describe('createRateLimiter — 3 per 10 min window', () => {
  const WIN = 10 * 60 * 1000

  it('allows up to max then blocks with retryAfter', () => {
    const rl = createRateLimiter(3, WIN)
    expect(rl.check('ip', 0)).toMatchObject({ allowed: true, remaining: 2 })
    expect(rl.check('ip', 100)).toMatchObject({ allowed: true, remaining: 1 })
    expect(rl.check('ip', 200)).toMatchObject({ allowed: true, remaining: 0 })
    const blocked = rl.check('ip', 300)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBe(WIN - 300) // until the oldest (t=0) ages out
  })

  it('frees a slot once the window slides past the oldest hit', () => {
    const rl = createRateLimiter(3, WIN)
    rl.check('ip', 0)
    rl.check('ip', 100)
    rl.check('ip', 200)
    expect(rl.check('ip', WIN - 1).allowed).toBe(false)
    // At WIN the t=0 hit expires → one slot frees up.
    expect(rl.check('ip', WIN + 1).allowed).toBe(true)
  })

  it('keys are independent', () => {
    const rl = createRateLimiter(1, WIN)
    expect(rl.check('a', 0).allowed).toBe(true)
    expect(rl.check('a', 1).allowed).toBe(false)
    expect(rl.check('b', 1).allowed).toBe(true)
  })

  it('sweep drops fully-expired keys to bound memory', () => {
    const rl = createRateLimiter(3, WIN)
    rl.check('a', 0)
    rl.check('b', 0)
    expect(rl.size()).toBe(2)
    rl.sweep(WIN + 1)
    expect(rl.size()).toBe(0)
  })
})

describe('clientKey', () => {
  it('takes the LAST XFF hop (nginx appends the real peer; earlier hops are spoofable)', () => {
    // Attacker sends "1.2.3.4"; nginx appends the true peer 203.0.113.5 at the end.
    expect(clientKey('1.2.3.4, 203.0.113.5', '203.0.113.5')).toBe('203.0.113.5')
    expect(clientKey('203.0.113.5', '10.0.0.9')).toBe('203.0.113.5')
  })
  it('falls back to the socket address, then "unknown"', () => {
    expect(clientKey(undefined, '198.51.100.7')).toBe('198.51.100.7')
    expect(clientKey('', '')).toBe('unknown')
  })
})
