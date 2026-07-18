import { describe, expect, it, vi } from 'vitest'
import { isAuthRejection } from '../server/utils/b24Rest'
import { BARE_TOKEN_REJECTED, makeBareTokenSdkCall } from '../server/utils/b24Sdk'
import { ensureSubfolder, uploadFile } from '../server/utils/disk'
import { buildProductRow, createTargetItem } from '../server/utils/crmWrite'
import { decryptSecret, encryptSecret } from '../server/utils/secretCrypto'
import { isAccessTokenExpired, needsProactiveRefresh } from '../server/utils/accessToken'
import { parseTokenResponse } from '../server/utils/b24Oauth'
import { buildConfigurableActivity, entityOpenPath, safeRelativePath } from '../server/utils/configurableActivity'
import { parsePortalSettings } from '../app/utils/portalSettings'

describe('makeBareTokenSdkCall (SDK bare-token transport)', () => {
  // The frame/install access token has NO server-side refresh; the call rides the SDK. We can
  // exercise the SSRF guard without a network (it rejects BEFORE the SDK sends), and pin the
  // bare-token rejection contract (BARE_TOKEN_REJECTED is classified as an auth rejection so the
  // verify paths return 401/403, not 502/503).
  it('refuses a non-Bitrix24 / malicious host before any network call', async () => {
    for (const host of ['evil.com', 'bitrix24.ru.evil.com', 'p.bitrix24.ru:22', 'user@p.bitrix24.ru']) {
      await expect(makeBareTokenSdkCall(host, 'tok')('profile')).rejects.toThrow(/UNSAFE_DOMAIN/)
    }
  })
  it('a bare-token auth error is classified as a rejection (→401/403, not transport)', () => {
    // A bare token cannot refresh — the custom refresh hook throws BARE_TOKEN_REJECTED, which
    // isAuthRejection must recognise so a forged frame/install token yields 401/403.
    expect(isAuthRejection(new Error(BARE_TOKEN_REJECTED))).toBe(true)
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
  it('sends categoryId for a deal but SKIPS it for a lead (etid 1 has no CATEGORY_ID, #135)', async () => {
    const dealCall = vi.fn().mockResolvedValue({ item: { id: 5 } })
    await createTargetItem({ entityTypeId: 2, categoryId: 7 }, {}, dealCall)
    expect((dealCall.mock.calls[0]![1] as { fields: Record<string, unknown> }).fields.categoryId).toBe(7)
    const leadCall = vi.fn().mockResolvedValue({ item: { id: 8 } })
    await createTargetItem({ entityTypeId: 1, categoryId: 7 }, {}, leadCall) // stray categoryId (carried over)
    expect((leadCall.mock.calls[0]![1] as { fields: Record<string, unknown> }).fields).not.toHaveProperty('categoryId')
  })
  it('SKIPS stageId for a lead (crm.item.add ignores lead stage) but sends it for a deal', async () => {
    const leadCall = vi.fn().mockResolvedValue({ item: { id: 8 } })
    await createTargetItem({ entityTypeId: 1, stageId: 'IN_PROCESS' }, {}, leadCall)
    expect((leadCall.mock.calls[0]![1] as { fields: Record<string, unknown> }).fields).not.toHaveProperty('stageId')
    const dealCall = vi.fn().mockResolvedValue({ item: { id: 5 } })
    await createTargetItem({ entityTypeId: 2, stageId: 'C1:NEW' }, {}, dealCall)
    expect((dealCall.mock.calls[0]![1] as { fields: Record<string, unknown> }).fields.stageId).toBe('C1:NEW')
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
  it('BB-neutralises the uploader-controlled title + lines (no [url=…]/mention injection into the timeline)', () => {
    const a = buildConfigurableActivity({
      entityTypeId: 2, ownerId: 5,
      title: 'Импорт: [url=http://evil]ООО[/url]',
      lines: ['Поставщик: [b]X[/b]', 'Позиций: 3'],
      openPath: '/crm/deal/details/5/'
    })
    const title = (a.layout as { header: { title: string } }).header.title
    const blocks = (a.layout as { body: { blocks: Record<string, { properties: { value: string } }> } }).body.blocks
    expect(title).not.toMatch(/\[|\]/) // brackets folded to fullwidth ［ ］
    expect(title).toContain('［url=http://evil］')
    expect(blocks.line0!.properties.value).not.toMatch(/\[|\]/)
    expect(blocks.line0!.properties.value).toContain('［b］X［/b］')
  })
})

describe('portalSettings coercion nuances', () => {
  it('keeps a string stageId + category, drops a non-string stageId and a bad rule target', () => {
    // stageId is string-only now (aligned with parseManualTarget) — a numeric stageId is dropped.
    const m = parsePortalSettings({
      defaultTarget: { entityTypeId: 31, categoryId: 2, stageId: 'DT31_2:N' },
      routingRules: [{ match: { type: 'x' }, target: { entityTypeId: 0 } }]
    })
    expect(m.defaultTarget).toEqual({ entityTypeId: 31, categoryId: 2, stageId: 'DT31_2:N' })
    // a non-string stageId (5) is dropped, not stringified
    expect(parsePortalSettings({ defaultTarget: { entityTypeId: 31, stageId: 5 } }).defaultTarget).toEqual({ entityTypeId: 31 })
    // a negative categoryId is dropped (≥0 gate, shared with parseManualTarget)
    expect(parsePortalSettings({ defaultTarget: { entityTypeId: 2, categoryId: -1 } }).defaultTarget).toEqual({ entityTypeId: 2 })
    expect(m.routingRules[0]!.target).toEqual({ entityTypeId: 2, categoryId: 0 }) // fallback default (deal/0)
  })
  it('chat ids pass-through only when string; saveFile default OFF (opt-in); dictionary non-object → {}', () => {
    expect(parsePortalSettings({ notifyChatId: 'chat1', errorChatId: 5 }).notifyChatId).toBe('chat1')
    expect(parsePortalSettings({ errorChatId: 5 }).errorChatId).toBeUndefined()
    expect(parsePortalSettings({}).saveFile).toBe(false) // opt-in — privacy default
    expect(parsePortalSettings({ saveFile: true }).saveFile).toBe(true) // explicit true enables
    expect(parsePortalSettings({ units: { dictionary: 'nope' } }).units.dictionary).toEqual({})
  })
})
