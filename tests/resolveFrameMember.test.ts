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
  it('verifies token then resolves member_id by domain (non-admin caller ⇒ admin:false)', async () => {
    const r = await resolveFrameMember(auth, { fetchFn: okFetch(), query: query([{ member_id: 'm42' }]) })
    expect(r).toEqual({ ok: true, memberId: 'm42', admin: false })
  })

  it('exposes admin:true when profile.ADMIN is true (drives the server-side admin gate)', async () => {
    const adminFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: { ID: '1', ADMIN: true } }) }))
    const r = await resolveFrameMember(auth, { fetchFn: adminFetch, query: query([{ member_id: 'm42' }]) })
    expect(r).toEqual({ ok: true, memberId: 'm42', admin: true })
  })

  it('401 when the token is rejected (auth error)', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) }))
    const r = await resolveFrameMember(auth, { fetchFn, query: query([{ member_id: 'm42' }]) })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.reason).toBe('token-rejected')
  })

  it('502 on a transport failure (retryable, not forbidden)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    const r = await resolveFrameMember(auth, { fetchFn, query: query([]) })
    expect(r.status).toBe(502)
    expect(r.reason).toBe('transport')
  })

  it('401 when the portal is not installed (no member for domain)', async () => {
    const r = await resolveFrameMember(auth, { fetchFn: okFetch(), query: query([]) })
    expect(r).toEqual({ ok: false, status: 401, reason: 'not-installed' })
  })

  it('normalises the frame domain (case/trailing slash) before the member lookup', async () => {
    const q = vi.fn(async () => ({ rows: [{ member_id: 'm42' }] }))
    // Frame reports a differently-cased host with a trailing slash; the stored install
    // domain is bare lower-case. Normalisation must let them still match.
    const variant = { accessToken: 'tok', domain: 'BEL.Bitrix24.by/' }
    const r = await resolveFrameMember(variant, { fetchFn: okFetch(), query: q })
    expect(r).toEqual({ ok: true, memberId: 'm42', admin: false })
    // getMemberIdByDomain must be queried with the bare lower-case host.
    expect(q).toHaveBeenCalledWith(expect.any(String), ['bel.bitrix24.by'])
  })

  it('classifies varied B24 auth codes as 401 (not retryable 502)', async () => {
    for (const code of ['unauthorized', 'expired_token', 'insufficient_scope', 'NO_AUTH_FOUND', 'wrong_auth']) {
      const fetchFn = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: code }) }))
      const r = await resolveFrameMember(auth, { fetchFn, query: query([{ member_id: 'm' }]) })
      expect(r.status, code).toBe(401)
    }
  })

  it('a 5xx transport blip is 502 (retryable), not a spurious 401 lockout', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'QUERY_LIMIT_EXCEEDED' }) }))
    const r = await resolveFrameMember(auth, { fetchFn, query: query([{ member_id: 'm' }]) })
    expect(r.status).toBe(502)
  })
})
