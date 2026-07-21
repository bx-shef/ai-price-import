import { describe, expect, it } from 'vitest'
import { normaliseError } from '../server/agent/openaiChat'
import { classifyAgentError } from '../server/agent/retry'

// normaliseError must produce a message that classifyAgentError reads correctly: HTTP 429/5xx and
// network faults (ECONNRESET/ETIMEDOUT/…) are TRANSIENT (retryable); auth/4xx are terminal. The
// key regression: the OpenAI SDK wraps network errors as APIConnectionError with status:undefined
// and a generic "Connection error." message, hiding the real code on `.cause` — it must still be
// classified transient so the retry fires.

describe('normaliseError', () => {
  it('prepends a numeric HTTP status (429/5xx → transient)', () => {
    expect(classifyAgentError(normaliseError({ status: 429, message: 'Too Many Requests' }).message)).toBe('transient')
    expect(classifyAgentError(normaliseError({ status: 503, message: 'Service Unavailable' }).message)).toBe('transient')
  })

  it('keeps a 4xx auth error terminal (no spurious retry)', () => {
    expect(classifyAgentError(normaliseError({ status: 401, message: 'Unauthorized' }).message)).toBe('terminal')
  })

  it('surfaces a network code from .cause so a connection fault is transient', () => {
    // Shape of the OpenAI SDK APIConnectionError: no status, generic message, real code on cause.
    const apiConnErr = Object.assign(new Error('Connection error.'), { status: undefined, cause: { code: 'ECONNRESET' } })
    const m = normaliseError(apiConnErr).message
    expect(m).toContain('ECONNRESET')
    expect(classifyAgentError(m)).toBe('transient')
  })

  it('surfaces a top-level .code when there is no cause', () => {
    const err = Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' })
    expect(classifyAgentError(normaliseError(err).message)).toBe('transient')
  })

  it('reads cause.message when neither status nor a code is present (ETIMEDOUT text)', () => {
    const err = Object.assign(new Error('Connection error.'), { cause: { message: 'connect ETIMEDOUT 1.2.3.4:443' } })
    expect(classifyAgentError(normaliseError(err).message)).toBe('transient')
  })

  it('a plain terminal error stays terminal', () => {
    expect(classifyAgentError(normaliseError(new Error('bad request')).message)).toBe('terminal')
  })
})
