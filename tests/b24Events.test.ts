import { describe, expect, it } from 'vitest'
import { extractEvent, parseBracketForm } from '../app/utils/b24Events'
import { decideB24Event, safeEqual } from '../server/utils/b24EventsHandler'
import { crmSyncJobId, eventJobId, makeJobId, QUEUES } from '../server/queue/topology'

describe('parseBracketForm', () => {
  it('parses nested PHP bracket form', () => {
    const p = parseBracketForm('event=ONAPPINSTALL&data%5BVERSION%5D=1&auth%5Bmember_id%5D=abc&auth%5Bapplication_token%5D=T0k')
    expect(p.event).toBe('ONAPPINSTALL')
    expect((p.data as Record<string, unknown>).VERSION).toBe('1')
    expect((p.auth as Record<string, unknown>).member_id).toBe('abc')
  })
  it('ignores prototype-polluting keys', () => {
    const p = parseBracketForm('a%5B__proto__%5D%5Bx%5D=1')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(p).toBeDefined()
  })
  it('handles + as space and empty body', () => {
    expect(parseBracketForm('')).toEqual({})
    expect(parseBracketForm('k=a+b').k).toBe('a b')
  })
  it('deep nesting and numeric indices (object, not array)', () => {
    expect(parseBracketForm('a%5Bb%5D%5Bc%5D=1')).toEqual({ a: { b: { c: '1' } } })
    expect(parseBracketForm('x%5B0%5D=a&x%5B1%5D=b')).toEqual({ x: { 0: 'a', 1: 'b' } })
  })
  it('scalar↔nested overwrite; malformed % tolerated (no throw)', () => {
    expect(parseBracketForm('a=1&a%5Bb%5D=2')).toEqual({ a: { b: '2' } })
    expect(() => parseBracketForm('k=%')).not.toThrow()
    expect(parseBracketForm('k=%').k).toBe('%')
  })
})

describe('extractEvent', () => {
  it('normalises shape', () => {
    const ev = extractEvent(parseBracketForm('event=ONAPPUNINSTALL&auth%5Bmember_id%5D=m&auth%5Bapplication_token%5D=X&auth%5Bdomain%5D=p.bitrix24.ru'))
    expect(ev).toMatchObject({ event: 'ONAPPUNINSTALL', memberId: 'm', applicationToken: 'X', domain: 'p.bitrix24.ru' })
  })
})

describe('safeEqual', () => {
  it('constant-time compare, fail-closed on mismatch/length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'ab')).toBe(false)
    expect(safeEqual('', '')).toBe(false)
  })
})

describe('decideB24Event', () => {
  const ok = { event: 'ONAPPINSTALL', memberId: 'm', applicationToken: 'T', domain: 'p', data: {}, auth: {} }

  it('400 on missing event/member', () => {
    expect(decideB24Event({ ...ok, event: '' }, null).status).toBe(400)
    expect(decideB24Event({ ...ok, memberId: '' }, 'T').status).toBe(400)
  })

  describe('known portal (stored token)', () => {
    it('403 on token mismatch (fail-closed)', () => {
      expect(decideB24Event(ok, 'STORED')).toEqual({ status: 403, action: 'ignore' })
    })
    it('register / unregister on matching stored token — no access-token verification', () => {
      expect(decideB24Event(ok, 'T')).toEqual({ status: 200, action: 'register' })
      expect(decideB24Event({ ...ok, event: 'ONAPPUNINSTALL' }, 'T')).toEqual({ status: 200, action: 'unregister' })
    })
    it('200/ignore on an unrelated but authenticated event', () => {
      expect(decideB24Event({ ...ok, event: 'ONCRMDEALADD' }, 'T')).toEqual({ status: 200, action: 'ignore' })
    })
  })

  describe('unknown portal (first install)', () => {
    it('registers via access-token verification when no env gate', () => {
      expect(decideB24Event(ok, null)).toEqual({ status: 200, action: 'register', verifyAccessToken: true })
      expect(decideB24Event(ok, '')).toEqual({ status: 200, action: 'register', verifyAccessToken: true })
    })
    it('optional env gate: matches → register+verify, mismatch → 403', () => {
      expect(decideB24Event(ok, null, 'T')).toEqual({ status: 200, action: 'register', verifyAccessToken: true })
      expect(decideB24Event(ok, null, 'OTHER')).toEqual({ status: 403, action: 'ignore' })
    })
    it('403 on any non-install event for an unknown portal (unverifiable)', () => {
      expect(decideB24Event({ ...ok, event: 'ONAPPUNINSTALL' }, null)).toEqual({ status: 403, action: 'ignore' })
      expect(decideB24Event({ ...ok, event: 'ONCRMDEALADD' }, null)).toEqual({ status: 403, action: 'ignore' })
    })
    it('400 when a first install carries no application_token to remember', () => {
      expect(decideB24Event({ ...ok, applicationToken: '' }, null).status).toBe(400)
    })
  })
})

describe('queue topology', () => {
  it('idempotent job ids sanitise separators', () => {
    expect(makeJobId('a', 'b:c', 'd|e')).toBe('a|b_c|d_e')
    expect(eventJobId('m', 'ONAPPINSTALL', 5)).toBe('ev|m|ONAPPINSTALL|5')
    expect(crmSyncJobId('m', 'job1')).toBe('cs|m|job1')
  })
  it('queue names', () => {
    expect(QUEUES.crmSync).toBe('crm-sync')
  })
})
