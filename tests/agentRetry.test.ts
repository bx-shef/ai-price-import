import { describe, expect, it } from 'vitest'
import { classifyAgentError, nextBackoffMs, shouldRetry } from '../server/agent/retry'

describe('classifyAgentError', () => {
  it('transient on 429/5xx/rate-limit/network/gateway-timeout', () => {
    for (const m of ['HTTP 429', 'status 503', 'HTTP 504', 'gateway timeout', 'rate limit exceeded', 'ECONNRESET', 'ETIMEDOUT', 'overloaded']) {
      expect(classifyAgentError(m)).toBe('transient')
    }
  })
  it('terminal otherwise — incl. our OWN deadline kill (bare timeout ≠ retry)', () => {
    expect(classifyAgentError('invalid JSON schema')).toBe('terminal')
    expect(classifyAgentError('agent timed out after 120s')).toBe('terminal')
    expect(classifyAgentError('request timeout')).toBe('terminal')
    expect(classifyAgentError('')).toBe('terminal')
  })
})

describe('nextBackoffMs', () => {
  it('grows exponentially within jittered window and caps', () => {
    expect(nextBackoffMs(1, 0)).toBe(500) // 1000 * 2^0 * 0.5
    expect(nextBackoffMs(1, 1)).toBe(1000)
    expect(nextBackoffMs(2, 0)).toBe(1000) // 2000 * 0.5
    expect(nextBackoffMs(10, 1)).toBe(30_000) // capped
  })
})

describe('shouldRetry', () => {
  it('only transient and under budget', () => {
    expect(shouldRetry('transient', 1)).toBe(true)
    expect(shouldRetry('transient', 3)).toBe(false)
    expect(shouldRetry('terminal', 1)).toBe(false)
  })
})
