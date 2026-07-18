import { describe, expect, it, vi } from 'vitest'
import { resolveFrameMember, verifyFrameToken } from '../server/utils/resolveFrameMember'
import type { RestCall } from '../server/utils/b24Rest'

const auth = { accessToken: 'tok', domain: 'p.bitrix24.by' }

/** Fake bare-token call-factory: `profile` resolves to the UNWRAPPED result (or throws). */
function makeCall(profile: RestCall) {
  return vi.fn((_domain: string, _token: string) => profile)
}
const okProfile: RestCall = async () => ({ ID: '1' })
function query(rows: Array<Record<string, unknown>>) {
  return vi.fn(async () => ({ rows }))
}

describe('verifyFrameToken (token-only; no member_id / install dependency)', () => {
  it('ok + admin:false for a valid non-admin token', async () => {
    expect(await verifyFrameToken(auth, { makeCall: makeCall(okProfile) })).toEqual({ ok: true, admin: false })
  })
  it('ok + admin:true when profile.ADMIN is true', async () => {
    const admin: RestCall = async () => ({ ID: '1', ADMIN: true })
    expect(await verifyFrameToken(auth, { makeCall: makeCall(admin) })).toEqual({ ok: true, admin: true })
  })
  it('does NOT require an installed portal (no token store) — a valid admin passes with no query', async () => {
    const admin: RestCall = async () => ({ ADMIN: true })
    const r = await verifyFrameToken(auth, { makeCall: makeCall(admin) })
    expect(r.ok).toBe(true) // resolveFrameMember would 401 not-installed here; verifyFrameToken does not
  })
  it('401 token-rejected on an auth error, 502 transport otherwise', async () => {
    const rejected = await verifyFrameToken(auth, { makeCall: makeCall(() => Promise.reject(new Error('invalid_token'))) })
    expect(rejected).toMatchObject({ ok: false, status: 401, reason: 'token-rejected' })
    const down = await verifyFrameToken(auth, { makeCall: makeCall(() => Promise.reject(new Error('network down'))) })
    expect(down).toMatchObject({ ok: false, status: 502, reason: 'transport' })
  })
})

describe('resolveFrameMember', () => {
  it('verifies token then resolves member_id by domain (non-admin caller ⇒ admin:false)', async () => {
    const r = await resolveFrameMember(auth, { makeCall: makeCall(okProfile), query: query([{ member_id: 'm42' }]) })
    expect(r).toEqual({ ok: true, memberId: 'm42', admin: false })
  })

  it('exposes admin:true when profile.ADMIN is true (drives the server-side admin gate)', async () => {
    const admin: RestCall = async () => ({ ID: '1', ADMIN: true })
    const r = await resolveFrameMember(auth, { makeCall: makeCall(admin), query: query([{ member_id: 'm42' }]) })
    expect(r).toEqual({ ok: true, memberId: 'm42', admin: true })
  })

  it('401 when the token is rejected (auth error)', async () => {
    const rejected: RestCall = () => Promise.reject(new Error('invalid_token'))
    const r = await resolveFrameMember(auth, { makeCall: makeCall(rejected), query: query([{ member_id: 'm42' }]) })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.reason).toBe('token-rejected')
  })

  it('502 on a transport failure (retryable, not forbidden)', async () => {
    const down: RestCall = () => Promise.reject(new Error('network down'))
    const r = await resolveFrameMember(auth, { makeCall: makeCall(down), query: query([]) })
    expect(r.status).toBe(502)
    expect(r.reason).toBe('transport')
  })

  it('401 when the portal is not installed (no member for domain)', async () => {
    const r = await resolveFrameMember(auth, { makeCall: makeCall(okProfile), query: query([]) })
    expect(r).toEqual({ ok: false, status: 401, reason: 'not-installed' })
  })

  it('normalises the frame domain (case/trailing slash) before the member lookup', async () => {
    const q = vi.fn(async () => ({ rows: [{ member_id: 'm42' }] }))
    // Frame reports a differently-cased host with a trailing slash; the stored install
    // domain is bare lower-case. Normalisation must let them still match.
    const variant = { accessToken: 'tok', domain: 'BEL.Bitrix24.by/' }
    const r = await resolveFrameMember(variant, { makeCall: makeCall(okProfile), query: q })
    expect(r).toEqual({ ok: true, memberId: 'm42', admin: false })
    // getMemberIdByDomain must be queried with the bare lower-case host.
    expect(q).toHaveBeenCalledWith(expect.any(String), ['bel.bitrix24.by'])
  })

  it('classifies varied B24 auth codes as 401 (not retryable 502)', async () => {
    for (const code of ['unauthorized', 'expired_token', 'insufficient_scope', 'NO_AUTH_FOUND', 'wrong_auth']) {
      const rejected: RestCall = () => Promise.reject(new Error(code))
      const r = await resolveFrameMember(auth, { makeCall: makeCall(rejected), query: query([{ member_id: 'm' }]) })
      expect(r.status, code).toBe(401)
    }
  })

  it('a 5xx / rate-limit transport blip is 502 (retryable), not a spurious 401 lockout', async () => {
    const blip: RestCall = () => Promise.reject(new Error('QUERY_LIMIT_EXCEEDED'))
    const r = await resolveFrameMember(auth, { makeCall: makeCall(blip), query: query([{ member_id: 'm' }]) })
    expect(r.status).toBe(502)
  })
})
