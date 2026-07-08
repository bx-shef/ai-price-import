import { describe, expect, it, vi } from 'vitest'
import { resolveFrameMember } from '../server/utils/resolveFrameMember'

const auth = { accessToken: 'tok', domain: 'p.bitrix24.by' }

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { ID: '1' } }) }))
}
function query(rows: Array<Record<string, unknown>>) {
  return vi.fn(async () => ({ rows }))
}

describe('resolveFrameMember', () => {
  it('verifies token then resolves member_id by domain', async () => {
    const r = await resolveFrameMember(auth, { fetchFn: okFetch(), query: query([{ member_id: 'm42' }]) })
    expect(r).toEqual({ ok: true, memberId: 'm42' })
  })

  it('401 when the token is rejected (auth error)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) }))
    const r = await resolveFrameMember(auth, { fetchFn, query: query([{ member_id: 'm42' }]) })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
  })

  it('502 on a transport failure (retryable, not forbidden)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    const r = await resolveFrameMember(auth, { fetchFn, query: query([]) })
    expect(r.status).toBe(502)
  })

  it('401 when the portal is not installed (no member for domain)', async () => {
    const r = await resolveFrameMember(auth, { fetchFn: okFetch(), query: query([]) })
    expect(r).toEqual({ ok: false, status: 401 })
  })
})
