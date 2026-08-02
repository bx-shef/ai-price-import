import { describe, expect, it, vi } from 'vitest'
import { archiveFileName, commonDiskFileUrl, MAX_DISK_NAME, DISK_APP_FOLDER, ensureSubfolder, makeSaveSourceFile, monthlySubfolderName, pickCommonStorage, sanitizeFileName, saveSourceFileToDisk, uploadFile } from '../server/utils/disk'
import { buildConfigurableActivity, companyOpenPath, entityOpenPath, safeRelativePath } from '../server/utils/configurableActivity'

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
    // URL is CONSTRUCTED from the human path (not the API DETAIL_URL): /docs/file/<enc path>?IFRAME...
    expect(ref).toEqual({ id: 45, detailUrl: commonDiskFileUrl(DISK_APP_FOLDER, '2026-07', 'н_акл:адная.pdf') })
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
    // Existing file → its id from REST, but the open URL is still the constructed one (not DETAIL_URL).
    expect(ref).toEqual({ id: 46, detailUrl: commonDiskFileUrl(DISK_APP_FOLDER, '2026-07', 'j1__doc.pdf') })
    expect(call).not.toHaveBeenCalledWith('disk.folder.uploadfile', expect.anything())
  })
})

describe('#346: имя архивной копии читается человеком', () => {
  const JOB = '2f941553-dfc1-437d-beee-c868d97aec2b'

  it('документ впереди, идентификатор задания сзади, расширение последним', () => {
    // Симптом: в папке приложения все имена начинались с 38 одинаково бессмысленных знаков —
    // в списке был виден столбец UUID, сортировка шла по нему, свою загрузку было не найти.
    expect(archiveFileName(JOB, 'накладная.pdf')).toBe(`накладная__${JOB}.pdf`)
    expect(archiveFileName(JOB, 'накладная.pdf').startsWith('накладная')).toBe(true)
    expect(archiveFileName(JOB, 'накладная.pdf').endsWith('.pdf')).toBe(true)
  })

  it('идентификатор остаётся в имени целиком — на нём держится защита от дубля', () => {
    // `saveSourceFileToDisk` ищет файл по ТОЧНОМУ имени перед загрузкой. «Упрости» имя до одного
    // лишь названия документа — и два разных задания с одинаковым именем файла (а «счёт.pdf» это
    // норма) стали бы одним файлом: второй просто не загрузился бы.
    expect(archiveFileName(JOB, 'счёт.pdf')).toContain(JOB)
    expect(archiveFileName('a', 'счёт.pdf')).not.toBe(archiveFileName('b', 'счёт.pdf'))
  })

  it('длинное имя режется по ИМЕННОЙ части — идентификатор и расширение уцелели', () => {
    // Главная ловушка правки: прежняя схема резала строку целиком, и это было безопасно только
    // потому, что длинное имя стояло в хвосте. Теперь оно впереди — наивный slice(255) отрезал бы
    // и UUID, и расширение, то есть ровно то, ради чего схема существует.
    const out = archiveFileName(JOB, `${'я'.repeat(400)}.pdf`)
    expect(out.length).toBeLessThanOrEqual(MAX_DISK_NAME)
    expect(out.endsWith(`__${JOB}.pdf`)).toBe(true)
  })

  it('файл без расширения не выдумывает его', () => {
    expect(archiveFileName(JOB, 'документ')).toBe(`документ__${JOB}`)
    // Точка в конце — не расширение, иначе получили бы имя, кончающееся на голую точку.
    expect(archiveFileName(JOB, 'документ.')).toBe(`документ.__${JOB}`)
    // Скрытый файл: ведущая точка — часть имени, а не разделитель расширения.
    expect(archiveFileName(JOB, '.gitignore')).toBe(`.gitignore__${JOB}`)
  })

  it('двойное расширение сохраняет последнее — по нему портал понимает тип', () => {
    expect(archiveFileName(JOB, 'архив.tar.gz')).toBe(`архив.tar__${JOB}.gz`)
  })

  it('разделители пути по-прежнему вычищаются', () => {
    // Имя попадает в путь ссылки «Исходный файл»; слэш там развалил бы адрес.
    expect(archiveFileName(JOB, 'папка/счёт.pdf')).toBe(`папка_счёт__${JOB}.pdf`)
  })

  it('пустое имя не даёт имени из одного идентификатора без документа', () => {
    expect(archiveFileName(JOB, '')).toBe(`document__${JOB}`)
  })

  it('пробелы и скобки в имени сохраняются как есть — кодирует их ссылка, а не имя', () => {
    // `commonDiskFileUrl` кодирует посегментно; портить имя заранее нельзя, иначе оно перестанет
    // совпадать с тем, что лежит на Диске, и `findChildFile` не найдёт свою же копию.
    const name = archiveFileName(JOB, 'счёт (копия) 2.pdf')
    expect(name).toBe(`счёт (копия) 2__${JOB}.pdf`)
    expect(commonDiskFileUrl(DISK_APP_FOLDER, '2026-07', name)).toContain('%28')
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
    // #346: имя начинается с ДОКУМЕНТА, идентификатор задания уехал в конец, расширение последнее.
    expect(call).toHaveBeenCalledWith('disk.folder.uploadfile', { id: 77, data: { NAME: 'doc__j1.pdf' }, fileContent: ['doc__j1.pdf', 'QQ=='] }) // ...and the upload
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
    // The recorded ref carries the id from REST but the CONSTRUCTED open URL (job-scoped name).
    expect(recordDiskFile).toHaveBeenCalledWith('m', 'j1', { id: 45, detailUrl: commonDiskFileUrl(DISK_APP_FOLDER, '2026-07', 'doc__j1.pdf') })
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
      ownerTypeId: 2,
      ownerId: 5,
      title: 'Импорт: Ромашка',
      lines: ['Позиций: 3', 'Поставщик: Ромашка'],
      openPath: '/crm/company/details/8/',
      showOpenButton: true,
      openButtonTitle: 'Открыть компанию'
    }) as Record<string, Record<string, unknown>>
    expect(params.ownerTypeId).toBe(2)
    expect(params.ownerId).toBe(5)
    const layout = params.layout as Record<string, Record<string, Record<string, unknown>>>
    expect(layout.footer.buttons.open).toMatchObject({ title: 'Открыть компанию', action: { type: 'redirect', uri: '/crm/company/details/8/' } })
    // body.logo is REQUIRED by B24 (verified live: missing → «Поле logo в BodyDto должно быть заполнено»).
    expect(layout.body.logo).toMatchObject({ code: 'document', action: { type: 'redirect', uri: '/crm/company/details/8/' } })
    expect(Object.keys(layout.body.blocks as object)).toEqual(['line0', 'line1'])
  })

  it('omits the «Открыть» button (and the whole footer) when showOpenButton is false and no file', () => {
    const params = buildConfigurableActivity({
      ownerTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/', showOpenButton: false
    }) as Record<string, Record<string, unknown>>
    const layout = params.layout as Record<string, unknown>
    expect(layout.footer).toBeUndefined()
    // logo still redirects (required) even without a button.
    expect((layout.body as Record<string, Record<string, unknown>>).logo).toMatchObject({ action: { uri: '/crm/deal/details/5/' } })
  })

  it('guarantees at least one body block when lines is empty (B24 needs 1..20)', () => {
    const params = buildConfigurableActivity({ ownerTypeId: 2, ownerId: 5, title: 'x', lines: [], openPath: '/crm/deal/details/5/', showOpenButton: true }) as Record<string, Record<string, unknown>>
    const blocks = ((params.layout as Record<string, Record<string, Record<string, unknown>>>).body.blocks) as Record<string, unknown>
    expect(Object.keys(blocks).length).toBeGreaterThanOrEqual(1)
  })
  // #328 (решение владельца): файл больше НЕ кнопка в подвале — он привязан к самому делу, строкой
  // «Исходный файл: <имя>» внутри записи. Кнопка рядом с делом читалась как «что-то ещё», а строка
  // в деле — как часть документа.
  it('привязывает исходный файл В ТЕЛО дела, подписывая его именем файла', () => {
    const fileUrl = commonDiskFileUrl(DISK_APP_FOLDER, '2026-07', 'j1__doc.xls')
    const withFile = buildConfigurableActivity({
      ownerTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/', showOpenButton: false,
      sourceFileUrl: fileUrl, sourceFileName: 'накладная №5.xls'
    }) as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>
    const block = withFile.layout.body.blocks.sourceFile as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    expect(block.properties.title).toBe('Исходный файл')
    expect(block.properties.block.properties.text).toBe('накладная №5.xls')
    expect(block.properties.block.properties.action).toMatchObject({ type: 'redirect', uri: fileUrl })
    // Кнопки в подвале за файл больше не отвечают.
    expect(withFile.layout.footer).toBeUndefined()
  })

  it('без имени файла подпись нейтральная, а не пустая ссылка', () => {
    const fileUrl = commonDiskFileUrl(DISK_APP_FOLDER, '2026-07', 'j1__doc.xls')
    const p = buildConfigurableActivity({
      ownerTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/', showOpenButton: false, sourceFileUrl: fileUrl
    }) as Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>>>
    expect(p.layout.body.blocks.sourceFile.properties.block.properties.text).toBe('Открыть файл')
  })

  it('чужой адрес файла в дело не попадает', () => {
    // Протокол-относительный адрес увёл бы сотрудника с портала прямо из карточки сделки.
    const hostile = buildConfigurableActivity({
      ownerTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/', showOpenButton: false, sourceFileUrl: '//evil.test/x'
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>
    expect(hostile.layout.body.blocks.sourceFile).toBeUndefined()
    expect(hostile.layout.footer).toBeUndefined()
  })

  it('имя файла — внешний текст: BB-разметка обезврежена', () => {
    const fileUrl = commonDiskFileUrl(DISK_APP_FOLDER, '2026-07', 'j1__doc.xls')
    const p = buildConfigurableActivity({
      ownerTypeId: 2, ownerId: 5, title: 'x', lines: ['1'], openPath: '/crm/deal/details/5/', showOpenButton: false,
      sourceFileUrl: fileUrl, sourceFileName: '[url=https://evil.test]клик[/url]'
    }) as Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>>>
    expect(String(p.layout.body.blocks.sourceFile.properties.block.properties.text)).not.toContain('[url=')
  })

  it('safeRelativePath rejects absolute/scheme URLs', () => {
    expect(safeRelativePath('/crm/deal/details/5/')).toBe('/crm/deal/details/5/')
    expect(safeRelativePath('https://evil.test/')).toBe('/crm/')
    expect(safeRelativePath('//evil.test')).toBe('/crm/')
  })
  it('entityOpenPath / companyOpenPath map the entity paths', () => {
    expect(entityOpenPath(2, 5)).toBe('/crm/deal/details/5/')
    expect(entityOpenPath(7, 9)).toBe('/crm/quote/show/9/')
    expect(entityOpenPath(1032, 3)).toBe('/crm/type/1032/details/3/')
    expect(companyOpenPath(8)).toBe('/crm/company/details/8/')
  })
  it('commonDiskFileUrl encodes each segment + appends the IFRAME slider query', () => {
    const url = commonDiskFileUrl('procure-ai (импорт прайсов)', '2026-07', 'f5__шевчик июнь.xls')
    expect(url.startsWith('/docs/file/')).toBe(true)
    expect(url).toContain('procure-ai%20%28') // space → %20, «(» → %28
    expect(url).toContain('%20%D0%B8%D1%8E%D0%BD%D1%8C.xls') // «·июнь.xls» encoded, dot kept
    expect(url.endsWith('?IFRAME=Y&IFRAME_TYPE=SIDE_SLIDER')).toBe(true)
  })
})
