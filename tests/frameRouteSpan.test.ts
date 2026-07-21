import { describe, expect, it } from 'vitest'
import { withFrameRouteSpan } from '../server/utils/frameRouteSpan'

// With no OTel SDK registered (the default in tests) withSpan returns a no-op span, so these
// verify the CONTROL FLOW: the handler runs, its result passes through, span.outcome is a mutable
// carrier the handler can set, and a throw propagates (never swallowed).

describe('withFrameRouteSpan', () => {
  it('runs the handler and returns its result (default outcome ok)', async () => {
    let seen = ''
    const r = await withFrameRouteSpan(
      { name: 'http.test.get', method: 'GET', op: 'test.load', domain: 'foo.bitrix24.by' },
      async (span) => {
        seen = span.outcome
        return { value: 7 }
      }
    )
    expect(r).toEqual({ value: 7 })
    expect(seen).toBe('ok') // handler sees the default before mutating it
  })

  it('lets the handler set an outcome for an early return', async () => {
    const r = await withFrameRouteSpan(
      { name: 'http.test.get', method: 'GET', op: 'test.load', domain: undefined },
      async (span) => {
        span.outcome = 'no_auth'
        return { error: 'x' }
      }
    )
    expect(r).toEqual({ error: 'x' })
  })

  it('rethrows on error (never swallows)', async () => {
    const err = new Error('boom')
    await expect(withFrameRouteSpan(
      { name: 'http.test.get', method: 'GET', op: 'test.load', domain: 'foo.bitrix24.by' },
      async () => { throw err }
    )).rejects.toBe(err)
  })
})
