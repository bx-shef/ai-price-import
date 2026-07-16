import { describe, expect, it, vi } from 'vitest'
import { makeRestCall, restUrl } from '../server/utils/b24Rest'
import { ensureSubfolder, uploadFile } from '../server/utils/disk'
import { buildProductRow, createTargetItem } from '../server/utils/crmWrite'
import { decryptSecret, encryptSecret } from '../server/utils/secretCrypto'
import { isAccessTokenExpired, needsProactiveRefresh } from '../server/utils/accessToken'
import { parseTokenResponse } from '../server/utils/b24Oauth'
import { buildConfigurableActivity, entityOpenPath, safeRelativePath } from '../server/utils/configurableActivity'
import { parsePortalSettings } from '../app/utils/portalSettings'

describe('makeRestCall (injected fetch)', () => {
  it('POSTs to restUrl with auth in body, unwraps result', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: { body?: string }) => ({
      ok: true, status: 200, json: async () => ({ result: [1, 2] })
    }))
    const call = makeRestCall('p.bitrix24.ru', 'tok', fetchFn)
    const res = await call('crm.item.list', { entityTypeId: 2 })
    expect(res).toEqual([1, 2])
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(restUrl('p.bitrix24.ru', 'crm.item.list'))
    expect(JSON.parse(init!.body!)).toEqual({ entityTypeId: 2, auth: 'tok' })
  })
  it('rejects on B24 error body', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: 'QUERY_LIMIT', error_description: 'too many' }) }))
    await expect(makeRestCall('p.bitrix24.ru', 't', fetchFn)('m')).rejects.toThrow(/too many/)
  })
  it('passes an AbortSignal and aborts a hung call (headers phase) as a typed TIMEOUT', async () => {
    // fetch never resolves on its own; it only settles when the injected signal aborts.
    const fetchFn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }) as Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>)
    await expect(makeRestCall('p.bitrix24.ru', 't', fetchFn, 5)('m')).rejects.toThrow(/TIMEOUT/)
    expect(fetchFn.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal)
  })
  it('aborts a stalled response BODY as TIMEOUT (headers arrive, res.json() hangs)', async () => {
    // Real fetch resolves on headers; a dribbled/stalled body must still hit the timeout.
    const fetchFn = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => ({
      ok: true, status: 200,
      json: () => new Promise<unknown>((_res, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }))
    await expect(makeRestCall('p.bitrix24.ru', 't', fetchFn, 5)('m')).rejects.toThrow(/TIMEOUT/)
  })
  it('rethrows a non-timeout transport error as-is (not mislabeled TIMEOUT)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const p = makeRestCall('p.bitrix24.ru', 't', fetchFn, 10_000)('m')
    await expect(p).rejects.toThrow('ECONNREFUSED')
    await expect(p).rejects.not.toThrow(/TIMEOUT/)
  })
  it('clears the abort timer on a fast call (no timer left pending)', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: 'ok' }) }))
      await expect(makeRestCall('p.bitrix24.ru', 't', fetchFn, 10_000)('m')).resolves.toBe('ok')
      expect(vi.getTimerCount()).toBe(0) // proves clearTimeout ran — fails if removed
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('restUrl + SSRF guard', () => {
  it('handles no scheme / no trailing slash for a Bitrix24 host', () => {
    expect(restUrl('p.bitrix24.ru', 'm')).toBe('https://p.bitrix24.ru/rest/m.json')
    expect(restUrl('https://co.bitrix24.by/', 'crm.item.add')).toBe('https://co.bitrix24.by/rest/crm.item.add.json')
  })
  it('refuses non-Bitrix24 / malicious hosts', () => {
    expect(() => restUrl('evil.com', 'm')).toThrow(/UNSAFE_DOMAIN/)
    expect(() => restUrl('bitrix24.ru.evil.com', 'm')).toThrow(/UNSAFE_DOMAIN/)
    expect(() => restUrl('p.bitrix24.ru:22', 'm')).toThrow(/UNSAFE_DOMAIN/)
    expect(() => restUrl('user@p.bitrix24.ru', 'm')).toThrow(/UNSAFE_DOMAIN/)
  })
})

describe('disk async (fake RestCall)', () => {
  it('ensureSubfolder returns existing (idempotent, no create)', async () => {
    const call = vi.fn().mockResolvedValue([{ ID: '8', NAME: '2026-07', TYPE: 'folder' }])
    expect(await ensureSubfolder(3, '2026-07', call)).toBe(8)
    expect(call).toHaveBeenCalledTimes(1) // getchildren only
  })
  it('ensureSubfolder ignores same-name FILE, creates folder', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce([{ ID: '9', NAME: '2026-07', TYPE: 'file' }])
      .mockResolvedValueOnce({ ID: '12' })
    expect(await ensureSubfolder(3, '2026-07', call)).toBe(12)
    expect(call).toHaveBeenLastCalledWith('disk.folder.addsubfolder', { id: 3, data: { NAME: '2026-07' } })
  })
  it('ensureSubfolder null children guard', async () => {
    const call = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ID: '1' })
    expect(await ensureSubfolder(3, 'x', call)).toBe(1)
  })
  it('uploadFile passes fileContent tuple', async () => {
    const call = vi.fn().mockResolvedValue({ ID: '77' })
    expect(await uploadFile(3, 'inv.pdf', 'BASE64', call)).toBe(77)
    expect(call).toHaveBeenCalledWith('disk.folder.uploadfile', { id: 3, data: { NAME: 'inv.pdf' }, fileContent: ['inv.pdf', 'BASE64'] })
  })
})

describe('buildProductRow edge cases', () => {
  it('taxRate null («Без НДС») is preserved', () => {
    expect(buildProductRow({ productName: 'x', price: 10, quantity: 1, taxRate: null, priceIncludesVat: false, measureCode: 796 }, 10).taxRate).toBeNull()
  })
  it('productId>0 kept, <=0 omitted', () => {
    expect(buildProductRow({ productId: 42, productName: 'x', price: 1, quantity: 1, taxRate: 0, priceIncludesVat: true, measureCode: 1 }, 10).productId).toBe(42)
    expect(buildProductRow({ productId: 0, productName: 'x', price: 1, quantity: 1, taxRate: 0, priceIncludesVat: true, measureCode: 1 }, 10)).not.toHaveProperty('productId')
  })
  it('non-finite price/quantity fall back', () => {
    const r = buildProductRow({ productName: 'x', price: Number.POSITIVE_INFINITY, quantity: Number.NaN, taxRate: 0, priceIncludesVat: true, measureCode: 1 }, 10)
    expect(r.price).toBe(0)
    expect(r.quantity).toBe(1)
  })
})

describe('createTargetItem branches', () => {
  it('includes stageId; throws when no id', async () => {
    const call = vi.fn().mockResolvedValue({ item: { id: 9 } })
    await createTargetItem({ entityTypeId: 31, stageId: 'DT31_1:N' }, {}, call)
    expect((call.mock.calls[0]![1] as { fields: Record<string, unknown> }).fields.stageId).toBe('DT31_1:N')
    await expect(createTargetItem({ entityTypeId: 2 }, {}, vi.fn().mockResolvedValue({ item: {} }))).rejects.toThrow(/no id/)
  })
})

describe('secretCrypto failure paths', () => {
  const key = Buffer.alloc(32, 3).toString('base64')
  it('tampered ciphertext throws (GCM auth)', () => {
    const enc = encryptSecret('secret', key)
    const parts = enc.split(':')
    const tampered = `${parts[0]}:${parts[1]}:${Buffer.from('zzzz').toString('base64')}`
    expect(() => decryptSecret(tampered, key)).toThrow()
  })
  it('wrong key throws; malformed blob throws', () => {
    const enc = encryptSecret('secret', key)
    expect(() => decryptSecret(enc, Buffer.alloc(32, 9).toString('base64'))).toThrow()
    expect(() => decryptSecret('onepart', key)).toThrow(/malformed/)
  })
})

describe('token/lifetime boundaries', () => {
  const t0 = 1_000_000_000_000
  const day = 86_400_000
  it('needsProactiveRefresh inclusive at 177d', () => {
    expect(needsProactiveRefresh(t0, t0 + 177 * day)).toBe(true)
    expect(needsProactiveRefresh(t0, t0 + 176 * day)).toBe(false)
  })
  it('isAccessTokenExpired with expiresIn<=0 falls back to 1h', () => {
    expect(isAccessTokenExpired(t0, 0, t0 + 100)).toBe(false)
    expect(isAccessTokenExpired(t0, 0, t0 + 3600_000)).toBe(true)
  })
  it('parseTokenResponse defaults', () => {
    const t = parseTokenResponse({ access_token: 'a', refresh_token: 'r' })
    expect(t.expires_in).toBe(3600)
    expect(t.member_id).toBe('')
  })
})

describe('configurableActivity deeper', () => {
  it('safeRelativePath blocks scheme/protocol-relative', () => {
    expect(safeRelativePath('/crm/deal/details/5/')).toBe('/crm/deal/details/5/')
    expect(safeRelativePath('https://evil.com')).toBe('/crm/')
    expect(safeRelativePath('//evil.com')).toBe('/crm/')
    expect(safeRelativePath('javascript:alert(1)')).toBe('/crm/')
  })
  it('entityOpenPath quote branch', () => {
    expect(entityOpenPath(7, 3)).toBe('/crm/quote/show/3/')
  })
  it('builds body blocks from lines (capped) + footer button', () => {
    const a = buildConfigurableActivity({ entityTypeId: 2, ownerId: 5, title: 'T', lines: Array.from({ length: 15 }, (_, i) => `l${i}`), openPath: '/crm/deal/details/5/' })
    const blocks = (a.layout as { body: { blocks: Record<string, unknown> } }).body.blocks
    expect(Object.keys(blocks)).toHaveLength(10)
    const btn = (a.layout as { footer: { buttons: { open: { action: { uri: string } } } } }).footer.buttons.open
    expect(btn.action.uri).toBe('/crm/deal/details/5/')
  })
})

describe('portalSettings coercion nuances', () => {
  it('keeps categoryId/stageId (stringified), drops bad rule target', () => {
    const m = parsePortalSettings({
      defaultTarget: { entityTypeId: 31, categoryId: 2, stageId: 5 },
      routingRules: [{ match: { type: 'x' }, target: { entityTypeId: 0 } }]
    })
    expect(m.defaultTarget).toEqual({ entityTypeId: 31, categoryId: 2, stageId: '5' })
    expect(m.routingRules[0]!.target).toEqual({ entityTypeId: 2 }) // fallback default
  })
  it('chat ids pass-through only when string; saveFile default OFF (opt-in); dictionary non-object → {}', () => {
    expect(parsePortalSettings({ notifyChatId: 'chat1', errorChatId: 5 }).notifyChatId).toBe('chat1')
    expect(parsePortalSettings({ errorChatId: 5 }).errorChatId).toBeUndefined()
    expect(parsePortalSettings({}).saveFile).toBe(false) // opt-in — privacy default
    expect(parsePortalSettings({ saveFile: true }).saveFile).toBe(true) // explicit true enables
    expect(parsePortalSettings({ units: { dictionary: 'nope' } }).units.dictionary).toEqual({})
  })
})
