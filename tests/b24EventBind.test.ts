import { describe, expect, it } from 'vitest'
import { buildEventBindCalls, isBindableHandlerUrl } from '../app/utils/b24EventBind'

const HANDLER = 'https://price-import.bx-shef.by/api/b24/events'
const WANTED = ['ONAPPINSTALL', 'ONAPPUNINSTALL'] as const

describe('isBindableHandlerUrl', () => {
  it('accepts absolute http(s) URLs, rejects relative/empty', () => {
    expect(isBindableHandlerUrl(HANDLER)).toBe(true)
    expect(isBindableHandlerUrl('http://localhost:3000/api/b24/events')).toBe(true)
    expect(isBindableHandlerUrl('/api/b24/events')).toBe(false)
    expect(isBindableHandlerUrl('')).toBe(false)
    expect(isBindableHandlerUrl('ftp://x/y')).toBe(false)
  })
})

describe('buildEventBindCalls', () => {
  it('fresh install: binds every wanted event, nothing to unbind', () => {
    const { unbind, bind } = buildEventBindCalls([], WANTED, HANDLER)
    expect(unbind).toEqual([])
    expect(bind.map(c => c.params.event)).toEqual(['ONAPPINSTALL', 'ONAPPUNINSTALL'])
    expect(bind.every(c => c.method === 'event.bind' && c.params.handler === HANDLER)).toBe(true)
  })

  it('idempotent: already bound to our handler → no calls', () => {
    const existing = WANTED.map(event => ({ event, handler: HANDLER }))
    const { unbind, bind } = buildEventBindCalls(existing, WANTED, HANDLER)
    expect(unbind).toEqual([])
    expect(bind).toEqual([])
  })

  it('stale handler (old domain) → unbind then rebind', () => {
    const existing = [{ event: 'ONAPPINSTALL', handler: 'https://old.example/api/b24/events' }]
    const { unbind, bind } = buildEventBindCalls(existing, WANTED, HANDLER)
    expect(unbind).toEqual([{ method: 'event.unbind', params: { event: 'ONAPPINSTALL', handler: 'https://old.example/api/b24/events' } }])
    // both wanted events get (re)bound: ONAPPINSTALL was unbound, ONAPPUNINSTALL never existed
    expect(bind.map(c => c.params.event)).toEqual(['ONAPPINSTALL', 'ONAPPUNINSTALL'])
  })

  it('case-insensitive match; ignores unrelated bindings', () => {
    const existing = [
      { event: 'onappinstall', handler: HANDLER }, // already ours (lower-case wire form)
      { event: 'ONCRMDEALADD', handler: 'https://other/x' } // not wanted → untouched
    ]
    const { unbind, bind } = buildEventBindCalls(existing, WANTED, HANDLER)
    expect(unbind).toEqual([])
    expect(bind.map(c => c.params.event)).toEqual(['ONAPPUNINSTALL'])
  })
})
