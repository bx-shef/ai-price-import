import { describe, expect, it, vi } from 'vitest'
import { deletePortal, getApplicationToken, getToken, saveToken, updateTokensOnRefresh } from '../server/utils/tokenStore'
import type { PortalToken } from '../server/utils/tokenStore'
import { ensureFreshToken } from '../server/utils/ensureAccessToken'

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
  it('deletePortal purges every per-portal table incl. client documents', async () => {
    const { q, calls } = fakeQuery()
    await deletePortal('m1', q)
    expect(calls.map(c => c.sql.match(/FROM (\w+)/)![1])).toEqual(
      ['portal_tokens', 'job_result', 'metrics_counter', 'import_text', 'import_doc', 'portal_app_rating']
    )
    for (const c of calls) expect(c.params).toEqual(['m1'])
  })

  describe('event-ordering tombstone guard (#77 port)', () => {
    it('saveToken with eventTs=0 skips the guard (no tombstone SQL)', async () => {
      const { q, calls } = fakeQuery()
      expect(await saveToken({ memberId: 'm1', domain: 'p.bitrix24.ru' }, q)).toBe(true)
      expect(calls.every(c => !c.sql.includes('portal_tombstone'))).toBe(true)
    })
    it('saveToken REFUSES a stale install (tombstone deleted_ts >= eventTs), writes nothing', async () => {
      const { q, calls } = fakeQuery([{ x: 1 }]) // SELECT 1 returns a row → blocked
      expect(await saveToken({ memberId: 'm1', domain: 'p.bitrix24.ru' }, q, 50)).toBe(false)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sql).toContain('SELECT 1 FROM portal_tombstone')
      expect(calls[0]!.params).toEqual(['m1', 50])
    })
    it('saveToken proceeds on a newer reinstall and clears the stale tombstone', async () => {
      const { q, calls } = fakeQuery([]) // SELECT returns no row → not blocked
      expect(await saveToken({ memberId: 'm1', domain: 'p.bitrix24.ru' }, q, 500)).toBe(true)
      expect(calls[0]!.sql).toContain('SELECT 1 FROM portal_tombstone')
      expect(calls[1]!.sql).toContain('ON CONFLICT (member_id)') // token upsert
      expect(calls[2]!.sql).toContain('DELETE FROM portal_tombstone')
      expect(calls[2]!.params).toEqual(['m1', 500])
    })
    it('deletePortal writes a GREATEST tombstone before purging when eventTs > 0', async () => {
      const { q, calls } = fakeQuery()
      await deletePortal('m1', q, 777)
      expect(calls[0]!.sql).toContain('INSERT INTO portal_tombstone')
      expect(calls[0]!.sql).toContain('GREATEST')
      expect(calls[0]!.params).toEqual(['m1', 777])
      expect(calls.slice(1).map(c => c.sql.match(/FROM (\w+)/)![1])).toEqual(
        ['portal_tokens', 'job_result', 'metrics_counter', 'import_text', 'import_doc', 'portal_app_rating']
      )
    })
    it('deletePortal with eventTs=0 writes NO tombstone (pre-guard behaviour)', async () => {
      const { q, calls } = fakeQuery()
      await deletePortal('m1', q)
      expect(calls.every(c => !c.sql.includes('portal_tombstone'))).toBe(true)
    })
    it('updateTokensOnRefresh is UPDATE-only (no INSERT) — cannot resurrect a purged portal', async () => {
      const { q, calls } = fakeQuery()
      await updateTokensOnRefresh({ memberId: 'm1', domain: 'p.bitrix24.ru', accessToken: 'new', refreshTokenEnc: 'ENC2' }, q)
      expect(calls[0]!.sql).toMatch(/^\s*UPDATE portal_tokens SET/)
      expect(calls[0]!.sql).not.toContain('INSERT')
      expect(calls[0]!.sql).toContain('WHERE member_id = $1')
      expect(calls[0]!.sql).not.toContain('application_token') // write-once; refresh must not touch it
      expect(calls[0]!.params![0]).toBe('m1')
    })
  })
})

const baseTok: PortalToken = {
  memberId: 'm1', domain: 'p.bitrix24.ru', clientEndpoint: 'https://p.bitrix24.ru/rest/',
  accessToken: 'old', refreshTokenEnc: 'ENC(rt)', applicationToken: 'app',
  expiresIn: 3600, issuedAtMs: 1000, refreshedAtMs: 1000
}

function ensureDeps(overrides: Partial<Parameters<typeof ensureFreshToken>[1]> = {}) {
  const getToken = overrides.getToken ?? vi.fn(async () => baseTok)
  const persistRefresh = vi.fn(async () => {})
  const refreshTransport = vi.fn(async () => ({
    access_token: 'new', refresh_token: 'rt2', expires_in: 3600,
    member_id: 'm1', client_endpoint: 'https://p.bitrix24.ru/rest/', domain: 'oauth.bitrix24.tech'
  }))
  const base = {
    getToken,
    // Passthrough lock (no DB in unit tests); pass a fake locked QueryFn to fn.
    withLock: async <T>(_key: string, fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: [] }>) => Promise<T>) => fn(async () => ({ rows: [] })),
    loadToken: vi.fn(async (_q: unknown, m: string) => getToken(m)),
    persistRefresh,
    refreshTransport,
    decrypt: (e: string) => e.replace(/^ENC\((.*)\)$/, '$1'),
    encrypt: (p: string) => `ENC(${p})`,
    clientId: 'cid',
    clientSecret: 'csec',
    now: () => 1000 + 30 * 60 * 1000 // 30 min later (still valid)
  }
  return { ...base, ...overrides }
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
    expect(deps.persistRefresh).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ accessToken: 'new', refreshTokenEnc: 'ENC(rt2)', domain: 'p.bitrix24.ru' }))
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
  it('in-lock re-read skips the refresh when another worker already refreshed (#35 dedup)', async () => {
    const later = 1000 + 2 * 3600_000
    const freshTok = { ...baseTok, accessToken: 'newer', issuedAtMs: later, expiresIn: 3600 }
    const deps = ensureDeps({
      now: () => later, // pre-lock: baseTok is expired → we take the lock…
      getToken: vi.fn(async () => baseTok),
      loadToken: vi.fn(async () => freshTok) // …but inside the lock the token is already fresh
    })
    const fresh = await ensureFreshToken('m1', deps)
    expect(fresh.accessToken).toBe('newer')
    expect(deps.refreshTransport).not.toHaveBeenCalled() // deduped — no rotation race
  })
  it('uninstalled under the lock (row gone) → throws, never refreshes/resurrects', async () => {
    const deps = ensureDeps({
      now: () => 1000 + 2 * 3600_000,
      getToken: vi.fn(async () => baseTok), // pre-lock: present + expired
      loadToken: vi.fn(async () => null) // in-lock: purged by a concurrent uninstall
    })
    await expect(ensureFreshToken('m1', deps)).rejects.toThrow(/no token/)
    expect(deps.refreshTransport).not.toHaveBeenCalled()
  })
})
