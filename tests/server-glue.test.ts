import { describe, expect, it, vi } from 'vitest'
import { deletePortal, getApplicationToken, getToken, saveToken } from '../server/utils/tokenStore'
import type { PortalToken } from '../server/utils/tokenStore'
import { ensureFreshToken } from '../server/utils/ensureAccessToken'
import { makePortalRestCall } from '../server/utils/portalRest'

function fakeQuery(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string, params?: unknown[] }> = []
  const q = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    return { rows }
  })
  return { q, calls }
}

describe('tokenStore', () => {
  it('saveToken upserts with write-once application_token clause', async () => {
    const { q, calls } = fakeQuery()
    await saveToken({ memberId: 'm1', domain: 'p.bitrix24.ru', accessToken: 'a', applicationToken: 'app' }, q)
    expect(calls[0]!.sql).toContain('ON CONFLICT (member_id)')
    expect(calls[0]!.sql).toContain('COALESCE(NULLIF(portal_tokens.application_token, \'\'), EXCLUDED.application_token)')
    expect(calls[0]!.params![0]).toBe('m1')
  })
  it('getToken maps row', async () => {
    const { q } = fakeQuery([{ member_id: 'm1', domain: 'p', access_token: 'a', expires_in: 3600, issued_at_ms: 5 }])
    const t = await getToken('m1', q)
    expect(t?.accessToken).toBe('a')
    expect(t?.issuedAtMs).toBe(5)
  })
  it('getToken null when absent', async () => {
    expect(await getToken('x', fakeQuery([]).q)).toBeNull()
  })
  it('getApplicationToken', async () => {
    expect(await getApplicationToken('m', fakeQuery([{ application_token: 'app' }]).q)).toBe('app')
    expect(await getApplicationToken('m', fakeQuery([{ application_token: '' }]).q)).toBeNull()
  })
  it('deletePortal purges all three tables', async () => {
    const { q, calls } = fakeQuery()
    await deletePortal('m1', q)
    expect(calls.map(c => c.sql.match(/FROM (\w+)/)![1])).toEqual(['portal_tokens', 'job_result', 'metrics_counter'])
  })
})

const baseTok: PortalToken = {
  memberId: 'm1', domain: 'p.bitrix24.ru', clientEndpoint: 'https://p.bitrix24.ru/rest/',
  accessToken: 'old', refreshTokenEnc: 'ENC(rt)', applicationToken: 'app',
  expiresIn: 3600, issuedAtMs: 1000, refreshedAtMs: 1000
}

function ensureDeps(overrides: Partial<Parameters<typeof ensureFreshToken>[1]> = {}) {
  const saveToken = vi.fn(async () => {})
  const refreshTransport = vi.fn(async () => ({
    access_token: 'new', refresh_token: 'rt2', expires_in: 3600,
    member_id: 'm1', client_endpoint: 'https://p.bitrix24.ru/rest/', domain: 'oauth.bitrix24.tech'
  }))
  return {
    getToken: vi.fn(async () => baseTok),
    saveToken,
    refreshTransport,
    decrypt: (e: string) => e.replace(/^ENC\((.*)\)$/, '$1'),
    encrypt: (p: string) => `ENC(${p})`,
    clientId: 'cid',
    clientSecret: 'csec',
    now: () => 1000 + 30 * 60 * 1000, // 30 min later (still valid)
    ...overrides
  }
}

describe('ensureFreshToken', () => {
  it('returns stored token when not expired', async () => {
    const deps = ensureDeps()
    const fresh = await ensureFreshToken('m1', deps)
    expect(fresh.accessToken).toBe('old')
    expect(deps.refreshTransport).not.toHaveBeenCalled()
  })
  it('refreshes when expired, keeps PORTAL domain, persists new pair', async () => {
    const deps = ensureDeps({ now: () => 1000 + 2 * 3600_000 }) // 2h later → expired
    const fresh = await ensureFreshToken('m1', deps)
    expect(fresh.accessToken).toBe('new')
    expect(fresh.domain).toBe('p.bitrix24.ru') // NOT oauth.bitrix24.tech
    expect(deps.saveToken).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'new', refreshTokenEnc: 'ENC(rt2)', domain: 'p.bitrix24.ru' }))
  })
  it('force refreshes even when time-valid', async () => {
    const deps = ensureDeps()
    await ensureFreshToken('m1', deps, true)
    expect(deps.refreshTransport).toHaveBeenCalled()
  })
  it('throws when no token', async () => {
    await expect(ensureFreshToken('m1', ensureDeps({ getToken: vi.fn(async () => null) }))).rejects.toThrow(/no token/)
  })
  it('throws when refresh needed but no refresh token', async () => {
    const deps = ensureDeps({ getToken: vi.fn(async () => ({ ...baseTok, refreshTokenEnc: '' })) })
    await expect(ensureFreshToken('m1', deps, true)).rejects.toThrow(/no refresh token/)
  })
  it('empty access token forces refresh even when time-valid', async () => {
    const deps = ensureDeps({ getToken: vi.fn(async () => ({ ...baseTok, accessToken: '' })) })
    const fresh = await ensureFreshToken('m1', deps)
    expect(fresh.accessToken).toBe('new')
    expect(deps.refreshTransport).toHaveBeenCalled()
  })
})

describe('makePortalRestCall', () => {
  it('null when portal has no token', async () => {
    const deps = { ...ensureDeps(), getToken: vi.fn(async () => null), fetchFn: vi.fn() }
    expect(await makePortalRestCall('m1', deps)).toBeNull()
  })
  it('calls REST with fresh token', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: 'OK' }) }))
    const deps = { ...ensureDeps(), fetchFn }
    const call = await makePortalRestCall('m1', deps)
    expect(await call!('crm.item.list')).toBe('OK')
  })
  it('retries once after expired_token error (force refresh)', async () => {
    let n = 0
    const fetchFn = vi.fn(async () => {
      n++
      return n === 1
        ? { ok: true, status: 401, json: async () => ({ error: 'expired_token', error_description: 'expired' }) }
        : { ok: true, status: 200, json: async () => ({ result: 'OK2' }) }
    })
    const deps = { ...ensureDeps(), fetchFn }
    const call = await makePortalRestCall('m1', deps)
    expect(await call!('crm.item.add')).toBe('OK2')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(deps.refreshTransport).toHaveBeenCalled() // forced refresh happened
  })
  it('retry exhausted: second call also expired → rejects, called twice', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 401, json: async () => ({ error: 'expired_token', error_description: 'e' }) }))
    const deps = { ...ensureDeps(), fetchFn }
    const call = await makePortalRestCall('m1', deps)
    await expect(call!('m')).rejects.toThrow(/expired_token/)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
  it('non-expired error does not retry', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 403, json: async () => ({ error: 'ACCESS_DENIED', error_description: 'no' }) }))
    const deps = { ...ensureDeps(), fetchFn, refreshTransport: vi.fn(async () => ({ access_token: 'n', refresh_token: 'r', expires_in: 3600, member_id: 'm1', client_endpoint: '' })) }
    const call = await makePortalRestCall('m1', deps)
    await expect(call!('m')).rejects.toThrow(/ACCESS_DENIED/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // only the initial ensureFreshToken (time-valid → no refresh) — no forced retry refresh
    expect(deps.refreshTransport).not.toHaveBeenCalled()
  })
})
