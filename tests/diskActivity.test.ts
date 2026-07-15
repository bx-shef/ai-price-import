import { describe, expect, it, vi } from 'vitest'
import { ensureSubfolder, monthlySubfolderName, pickCommonStorage, uploadFile } from '../server/utils/disk'
import { buildConfigurableActivity, entityOpenPath, safeRelativePath } from '../server/utils/configurableActivity'

describe('disk — common storage + monthly folder', () => {
  it('picks the ENTITY_TYPE=common drive (live shape)', () => {
    const storages = [
      { ID: '1', ENTITY_TYPE: 'user', NAME: 'Игорь' },
      { ID: '3', ENTITY_TYPE: 'common', NAME: 'Общий диск' }
    ]
    expect(pickCommonStorage(storages)?.ID).toBe('3')
    expect(pickCommonStorage([])).toBeNull()
  })
  it('formats YYYY-MM with zero-padded month', () => {
    expect(monthlySubfolderName({ getFullYear: () => 2026, getMonth: () => 6 })).toBe('2026-07')
    expect(monthlySubfolderName({ getFullYear: () => 2026, getMonth: () => 0 })).toBe('2026-01')
  })
})

describe('disk — ensureSubfolder (idempotent)', () => {
  it('returns an existing folder without creating', async () => {
    const call = vi.fn(async () => [{ ID: '89', NAME: '2026-07', TYPE: 'folder' }])
    expect(await ensureSubfolder(3, '2026-07', call)).toBe(89)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('creates when missing', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce([{ ID: '1', NAME: 'other', TYPE: 'folder' }])
      .mockResolvedValueOnce({ ID: '90' })
    expect(await ensureSubfolder(3, '2026-07', call)).toBe(90)
    expect(call).toHaveBeenNthCalledWith(2, 'disk.folder.addsubfolder', { id: 3, data: { NAME: '2026-07' } })
  })
})

describe('disk — uploadFile', () => {
  it('uploads base64 as [name, content] (live-verified param shape)', async () => {
    const call = vi.fn(async () => ({ ID: '91' }))
    expect(await uploadFile(89, 'doc.pdf', 'Qk9G', call)).toBe(91)
    expect(call).toHaveBeenCalledWith('disk.folder.uploadfile', {
      id: 89,
      data: { NAME: 'doc.pdf' },
      fileContent: ['doc.pdf', 'Qk9G']
    })
  })
})

describe('configurableActivity', () => {
  it('builds header/body/footer with a same-portal open button', () => {
    const params = buildConfigurableActivity({
      entityTypeId: 2,
      ownerId: 5,
      title: 'Импорт: Ромашка',
      lines: ['Позиций: 3', 'Поставщик: Ромашка'],
      openPath: '/crm/deal/details/5/'
    }) as Record<string, Record<string, unknown>>
    expect(params.ownerTypeId).toBe(2)
    expect(params.ownerId).toBe(5)
    const layout = params.layout as Record<string, Record<string, Record<string, unknown>>>
    expect(layout.footer.buttons.open).toMatchObject({ action: { type: 'redirect', uri: '/crm/deal/details/5/' } })
    // body.logo is REQUIRED by B24 (verified live: missing → «Поле logo в BodyDto должно быть заполнено»).
    expect(layout.body.logo).toMatchObject({ code: 'document', action: { type: 'redirect', uri: '/crm/deal/details/5/' } })
    expect(Object.keys(layout.body.blocks as object)).toEqual(['line0', 'line1'])
  })

  it('guarantees at least one body block when lines is empty (B24 needs 1..20)', () => {
    const params = buildConfigurableActivity({ entityTypeId: 2, ownerId: 5, title: 'x', lines: [], openPath: '/crm/deal/details/5/' }) as Record<string, Record<string, unknown>>
    const blocks = ((params.layout as Record<string, Record<string, Record<string, unknown>>>).body.blocks) as Record<string, unknown>
    expect(Object.keys(blocks).length).toBeGreaterThanOrEqual(1)
  })
  it('safeRelativePath rejects absolute/scheme URLs', () => {
    expect(safeRelativePath('/crm/deal/details/5/')).toBe('/crm/deal/details/5/')
    expect(safeRelativePath('https://evil.test/')).toBe('/crm/')
    expect(safeRelativePath('//evil.test')).toBe('/crm/')
  })
  it('entityOpenPath maps deal/quote/smart-process', () => {
    expect(entityOpenPath(2, 5)).toBe('/crm/deal/details/5/')
    expect(entityOpenPath(7, 9)).toBe('/crm/quote/show/9/')
    expect(entityOpenPath(1032, 3)).toBe('/crm/type/1032/details/3/')
  })
})
