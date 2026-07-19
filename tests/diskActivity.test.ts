import { describe, expect, it, vi } from 'vitest'
import { DISK_APP_FOLDER, ensureSubfolder, makeSaveSourceFile, monthlySubfolderName, pickCommonStorage, sanitizeFileName, saveSourceFileToDisk, uploadFile } from '../server/utils/disk'
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

describe('disk — sanitizeFileName', () => {
  it('strips path separators, falls back on blank, caps at 255', () => {
    expect(sanitizeFileName('a/b\\c.pdf')).toBe('a_b_c.pdf')
    expect(sanitizeFileName('   ')).toBe('document')
    expect(sanitizeFileName('x'.repeat(300)).length).toBe(255)
  })
})

describe('disk — saveSourceFileToDisk (composition)', () => {
  it('common → app folder → monthly subfolder → upload; returns the file id', async () => {
    const call = vi.fn(async (method: string, params: { data?: { NAME?: string } }) => {
      if (method === 'disk.storage.getlist') return [{ ID: '3', ENTITY_TYPE: 'common', NAME: 'Shared', ROOT_OBJECT_ID: '3' }]
      if (method === 'disk.folder.getchildren') return [] // nothing exists → create each
      if (method === 'disk.folder.addsubfolder') return { ID: params.data?.NAME === DISK_APP_FOLDER ? '39' : '77' }
      if (method === 'disk.folder.uploadfile') return { ID: '45', DETAIL_URL: '/company/personal/user/1/disk/file/45/' }
      return null
    })
    const ref = await saveSourceFileToDisk({ base64: 'QQ==', fileName: 'н/акл:адная.pdf', date: { getFullYear: () => 2026, getMonth: () => 6 } }, call)
    expect(ref).toEqual({ id: 45, detailUrl: '/company/personal/user/1/disk/file/45/' })
    expect(call).toHaveBeenCalledWith('disk.folder.addsubfolder', { id: 3, data: { NAME: DISK_APP_FOLDER } }) // app folder under root
    expect(call).toHaveBeenCalledWith('disk.folder.addsubfolder', { id: 39, data: { NAME: '2026-07' } }) // month under app folder
    expect(call).toHaveBeenCalledWith('disk.folder.uploadfile', { id: 77, data: { NAME: 'н_акл:адная.pdf' }, fileContent: ['н_акл:адная.pdf', 'QQ=='] })
  })
  it('throws when the common drive / root is missing', async () => {
    await expect(saveSourceFileToDisk({ base64: 'QQ==', fileName: 'x', date: { getFullYear: () => 2026, getMonth: () => 0 } }, vi.fn(async () => [])))
      .rejects.toThrow(/общий диск/)
  })
  it('is idempotent on retry: an existing same-name file in the month folder is returned, not re-uploaded', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'disk.storage.getlist') return [{ ID: '3', ENTITY_TYPE: 'common', NAME: 'Shared', ROOT_OBJECT_ID: '3' }]
      if (method === 'disk.folder.getchildren') return [
        { ID: '39', NAME: DISK_APP_FOLDER, TYPE: 'folder' },
        { ID: '77', NAME: '2026-07', TYPE: 'folder' },
        { ID: '46', NAME: 'j1__doc.pdf', TYPE: 'file', DETAIL_URL: '/company/disk/file/46/' } // already archived by a prior attempt
      ]
      return null
    })
    const ref = await saveSourceFileToDisk({ base64: 'QQ==', fileName: 'j1__doc.pdf', date: { getFullYear: () => 2026, getMonth: () => 6 } }, call)
    expect(ref).toEqual({ id: 46, detailUrl: '/company/disk/file/46/' })
    expect(call).not.toHaveBeenCalledWith('disk.folder.uploadfile', expect.anything())
  })
})

describe('disk — makeSaveSourceFile (file-extract wiring)', () => {
  function diskCall() {
    return vi.fn(async (method: string, params: { data?: { NAME?: string } }) => {
      if (method === 'disk.storage.getlist') return [{ ID: '3', ENTITY_TYPE: 'common', NAME: 'Shared', ROOT_OBJECT_ID: '3' }]
      if (method === 'disk.folder.getchildren') return []
      if (method === 'disk.folder.addsubfolder') return { ID: params.data?.NAME === DISK_APP_FOLDER ? '39' : '77' }
      if (method === 'disk.folder.uploadfile') return { ID: '45' }
      return null
    })
  }
  it('saveFile OFF → resolves nothing, never reads bytes or uploads', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([65]))
    const call = diskCall()
    const hook = makeSaveSourceFile({
      resolveCall: async () => ({ call }),
      loadMapping: async () => ({ saveFile: false }),
      readBytes,
      now: () => 0
    })
    await hook('m', 'j1', 'doc.pdf')
    expect(readBytes).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })
  it('no portal token (resolveCall → null) → skip without loading the mapping', async () => {
    const loadMapping = vi.fn(async () => ({ saveFile: true }))
    const hook = makeSaveSourceFile({ resolveCall: async () => null, loadMapping, readBytes: async () => new Uint8Array(), now: () => 0 })
    await hook('m', 'j1', 'doc.pdf')
    expect(loadMapping).not.toHaveBeenCalled()
  })
  it('saveFile ON → resolves ONE transport, reuses it for mapping + upload, job-scoped name', async () => {
    const call = diskCall()
    const resolveCall = vi.fn(async () => ({ call }))
    const loadMapping = vi.fn(async () => ({ saveFile: true }))
    const hook = makeSaveSourceFile({ resolveCall, loadMapping, readBytes: async () => new Uint8Array([65]), now: () => Date.UTC(2026, 6, 1) })
    await hook('m', 'j1', 'doc.pdf')
    expect(resolveCall).toHaveBeenCalledTimes(1) // transport built once (no double token-load)
    expect(loadMapping).toHaveBeenCalledWith(call) // SAME call handed to the mapping read...
    expect(call).toHaveBeenCalledWith('disk.folder.uploadfile', { id: 77, data: { NAME: 'j1__doc.pdf' }, fileContent: ['j1__doc.pdf', 'QQ=='] }) // ...and the upload
  })
  it('runs the Disk write under the per-portal serializer when provided', async () => {
    const call = diskCall()
    const serialize = vi.fn(async (_key: string, fn: () => Promise<void>) => {
      await fn()
    })
    const hook = makeSaveSourceFile({
      resolveCall: async () => ({ call }),
      loadMapping: async () => ({ saveFile: true }),
      readBytes: async () => new Uint8Array([65]),
      serialize,
      now: () => Date.UTC(2026, 6, 1)
    })
    await hook('m', 'j1', 'doc.pdf')
    expect(serialize).toHaveBeenCalledWith('disk-archive:m', expect.any(Function))
    expect(call).toHaveBeenCalledWith('disk.folder.uploadfile', expect.anything()) // upload still happened
  })
  it('records the archived file ref (id + DETAIL_URL) so crm-sync can link it on the дело', async () => {
    const call = vi.fn(async (method: string, params: { data?: { NAME?: string } }) => {
      if (method === 'disk.storage.getlist') return [{ ID: '3', ENTITY_TYPE: 'common', NAME: 'S', ROOT_OBJECT_ID: '3' }]
      if (method === 'disk.folder.getchildren') return []
      if (method === 'disk.folder.addsubfolder') return { ID: params.data?.NAME === DISK_APP_FOLDER ? '39' : '77' }
      if (method === 'disk.folder.uploadfile') return { ID: '45', DETAIL_URL: '/company/disk/file/45/' }
      return null
    })
    const recordDiskFile = vi.fn(async () => {})
    const hook = makeSaveSourceFile({
      resolveCall: async () => ({ call }),
      loadMapping: async () => ({ saveFile: true }),
      readBytes: async () => new Uint8Array([65]),
      recordDiskFile,
      now: () => Date.UTC(2026, 6, 1)
    })
    await hook('m', 'j1', 'doc.pdf')
    expect(recordDiskFile).toHaveBeenCalledWith('m', 'j1', { id: 45, detailUrl: '/company/disk/file/45/' })
  })
})

describe('disk — uploadFile', () => {
  it('uploads base64 as [name, content] (live-verified param shape)', async () => {
    const call = vi.fn(async () => ({ ID: '91', DETAIL_URL: '/company/disk/file/91/' }))
    expect(await uploadFile(89, 'doc.pdf', 'Qk9G', call)).toEqual({ id: 91, detailUrl: '/company/disk/file/91/' })
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
  it('adds an «Исходный файл» button ONLY for a valid same-portal DETAIL_URL', () => {
    const withFile = buildConfigurableActivity({
      entityTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/',
      sourceFileUrl: '/company/personal/user/1/disk/file/45/'
    }) as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>
    expect(withFile.layout.footer.buttons.sourceFile).toMatchObject({
      title: 'Исходный файл', action: { type: 'redirect', uri: '/company/personal/user/1/disk/file/45/' }
    })
    // protocol-relative / absolute DETAIL_URL is dropped (no off-portal redirect button)
    const hostile = buildConfigurableActivity({
      entityTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/', sourceFileUrl: '//evil.test/x'
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    expect(hostile.layout.footer.buttons.sourceFile).toBeUndefined()
    // absent → no button
    const none = buildConfigurableActivity({ entityTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/' }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    expect(none.layout.footer.buttons.sourceFile).toBeUndefined()
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
