import { describe, expect, it, vi } from 'vitest'
import { findProduct, findProductByArticle, findProductByXmlId } from '../server/utils/productLookup'
import { defaultMapping } from '../app/utils/portalSettings'
import type { DocumentItem } from '../app/types/document'

// ⚠ Формы запросов — `catalog.product.list` (методы `crm.product.*` DEPRECATED): `iblockId`
// обязателен и в фильтре, и в `select`; поля в lowerCamel; строки приходят под ключом `products`.
const PRODUCT_IBLOCK = 25
const IB = { offer: [], product: [PRODUCT_IBLOCK] }
const rows = (...products: Array<Record<string, unknown>>) => ({ products })

const item = (over: Partial<DocumentItem> = {}): DocumentItem => ({ name: 'Гвоздь', price: 1, quantity: 1, ...over })

const artCfg = (over: Partial<ReturnType<typeof defaultMapping>['article']> = {}) => ({ ...defaultMapping().article, field: '130', kind: 'text' as const, ...over })

describe('findProductByArticle (%LIKE narrows → exact membership; live-verified)', () => {
  it('text variant: %LIKE query (ordered), membership by newline split', async () => {
    const call = vi.fn(async () => rows({ id: 7, property130: { value: 'A-100\nA-200' } }))
    expect(await findProductByArticle('A-100', artCfg(), PRODUCT_IBLOCK, call)).toBe(7)
    expect(call).toHaveBeenCalledWith('catalog.product.list', { filter: { 'iblockId': PRODUCT_IBLOCK, '%property130': 'A-100', 'active': 'Y' }, select: ['id', 'iblockId', 'property130'], order: { id: 'asc' } })
  })
  it('rejects a LIKE false positive (A-10 is NOT an exact member of {A-100, A-200})', async () => {
    const call = vi.fn(async () => rows({ id: 7, property130: { value: 'A-100\nA-200' } }))
    expect(await findProductByArticle('A-10', artCfg(), PRODUCT_IBLOCK, call)).toBeNull()
  })
  it('string variant: splits by the configured delimiter; accepts a plain-string value', async () => {
    const call = vi.fn(async () => rows({ id: 9, property130: 'BV-12;EXTRA-7' }))
    expect(await findProductByArticle('EXTRA-7', artCfg({ kind: 'string', delimiter: ';' }), PRODUCT_IBLOCK, call)).toBe(9)
  })
  it('string variant defaults to comma when no delimiter configured', async () => {
    const call = vi.fn(async () => rows({ id: 9, property130: 'BV-12,EXTRA-7' }))
    expect(await findProductByArticle('EXTRA-7', artCfg({ kind: 'string', delimiter: undefined }), PRODUCT_IBLOCK, call)).toBe(9)
  })
  it('selects the correct product among MIXED candidates (some pass, some fail membership)', async () => {
    const call = vi.fn(async () => rows(
      { id: 5, property130: 'A-100\nA-200' }, // substring hit, NOT exact member of 'A-1'
      { id: 8, property130: 'A-1\nZ-9' }, //     exact member
      { id: 3, property130: 'A-15' } //         substring hit, not exact
    ))
    expect(await findProductByArticle('A-1', artCfg(), PRODUCT_IBLOCK, call)).toBe(8)
  })
  it('homoglyph-tolerant membership among returned rows (Cyrillic С ↔ Latin C)', async () => {
    // LIKE already returned the row (bytes agree here); the fold confirms the match.
    const call = vi.fn(async () => rows({ id: 4, property130: 'СTP-5\nX-2' })) // Cyrillic С
    expect(await findProductByArticle('CTP-5', artCfg(), PRODUCT_IBLOCK, call)).toBe(4) // Latin C
  })
  it('multiple-value property (array / index-object) is flattened', async () => {
    const arr = vi.fn(async () => rows({ id: 6, property130: ['A-100', 'A-200'] }))
    expect(await findProductByArticle('A-200', artCfg(), PRODUCT_IBLOCK, arr)).toBe(6)
    const idx = vi.fn(async () => rows({ id: 6, property130: { 0: { value: 'A-100' }, 1: { value: 'A-200' } } }))
    expect(await findProductByArticle('A-200', artCfg(), PRODUCT_IBLOCK, idx)).toBe(6)
  })
  it('null/missing property value → no match (propValue null branch)', async () => {
    const call = vi.fn(async () => rows({ id: 7, property130: null }))
    expect(await findProductByArticle('A-100', artCfg(), PRODUCT_IBLOCK, call)).toBeNull()
  })
  it('symbolic (non-numeric) field is REJECTED → no REST call (live: %LIKE on code returns all)', async () => {
    const call = vi.fn(async () => rows({ id: 1 }))
    expect(await findProductByArticle('A-100', artCfg({ field: 'ARTNUMBER' }), PRODUCT_IBLOCK, call)).toBeNull()
    expect(await findProductByArticle('A-100', artCfg({ field: 'PROPERTY_ART' }), PRODUCT_IBLOCK, call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('null on empty article or empty field', async () => {
    const call = vi.fn(async () => rows())
    expect(await findProductByArticle('', artCfg(), PRODUCT_IBLOCK, call)).toBeNull()
    expect(await findProductByArticle('A', artCfg({ field: '  ' }), PRODUCT_IBLOCK, call)).toBeNull()
    expect(await findProductByArticle('A', artCfg(), null, call), 'нет инфоблока товаров ⇒ запроса нет').toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})

describe('findProductByXmlId (external code «внешний код», ACTIVE-only)', () => {
  it('filters by xmlId + active and returns the smallest positive id', async () => {
    const call = vi.fn(async () => rows({ id: 18, xmlId: 'EXT-42' }, { id: 15, xmlId: 'EXT-42' }))
    expect(await findProductByXmlId('EXT-42', PRODUCT_IBLOCK, call)).toBe(15)
    expect(call).toHaveBeenCalledWith('catalog.product.list', { filter: { iblockId: PRODUCT_IBLOCK, xmlId: 'EXT-42', active: 'Y' }, select: ['id', 'iblockId', 'xmlId'] })
  })
  it('РАЗНЫЕ написания кода в ответе → «не подобрано», а не произвольный из них', async () => {
    // ⚠ Живая проба 06.08.2026: портал сравнивает `xmlId` БЕЗ учёта регистра (это коллация базы, не
    // API), и два товара — `AIPI_CASE_PROBE` и `aipi_case_probe` — вернулись на КАЖДЫЙ из четырёх
    // запросов, включая префикс `=`. Прежний `minId` молча брал меньший id: документ с кодом в
    // нижнем регистре получал в сделку товар с верхним. Это не «не нашли», а «нашли не тот».
    const call = vi.fn(async () => rows({ id: 77, xmlId: 'ZQ-1' }, { id: 79, xmlId: 'zq-1' }))
    expect(await findProductByXmlId('zq-1', PRODUCT_IBLOCK, call)).toBeNull()
  })
  it('одно написание в ответе → берём его (терпимость к регистру сохранена)', async () => {
    const call = vi.fn(async () => rows({ id: 79, xmlId: 'ZQ-1' }))
    expect(await findProductByXmlId('zq-1', PRODUCT_IBLOCK, call)).toBe(79)
  })
  it('null on empty code, no iblock or no rows (no REST call for those)', async () => {
    const call = vi.fn(async () => rows())
    expect(await findProductByXmlId('   ', PRODUCT_IBLOCK, call)).toBeNull()
    expect(await findProductByXmlId('x', null, call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(await findProductByXmlId('x', PRODUCT_IBLOCK, vi.fn(async () => undefined))).toBeNull()
  })
})

describe('findProduct (strategy routing)', () => {
  it('ПО ИМЕНИ НЕ ИЩЕМ: артикул не совпал ни свойством, ни внешним кодом → null, третьего вызова нет', async () => {
    // ⚠ Решение владельца 2026-08-05. Имя товара не идентификатор: у каждого поставщика своё
    // написание одной позиции. Неверно подобранный товар пишет в карточку клиента ЧУЖУЮ позицию —
    // со своей ценой, единицей и остатком, — и всплывает это в отчётах, а не при импорте.
    // Проверяется ЧИСЛО вызовов: возврат подбора по имени — это ровно третий `catalog.product.list`.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => rows())
    expect(await findProduct(item({ article: 'A-1' }), m, call, IB)).toBeNull()
    expect(call).toHaveBeenCalledTimes(2)
    for (const [, params] of call.mock.calls) {
      expect(JSON.stringify(params).toUpperCase(), 'в фильтре появилось имя товара').not.toContain('NAME')
    }
  })

  it('КАНАРЕЙКА: у строки НЕТ артикула, портал отвечает совпадением на ЛЮБОЙ запрос → всё равно null', async () => {
    // ⚠ Утверждение о ПОВЕДЕНИИ, безразличное к числу и форме запросов. Счётчик вызовов сам по себе
    // хрупок: батчинг двух лукапов в один `callBatch` или мемоизация подбора на джобу сдвинут число,
    // не меняя поведения, — и тогда счётчик поправят «до зелёного», а вместе с ним умрёт единственное
    // утверждение о подборе по имени.
    // ⚠ Артикула у строки НЕТ намеренно: тогда совпасть может ТОЛЬКО имя, и «нашлось» однозначно
    // означает его возврат. С артикулом канарейка была бы неверной — там законно совпадает внешний код.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => rows({ id: 7, name: 'Гвоздь' }))
    expect(await findProduct(item(), m, call, IB)).toBeNull()
  })

  it('нет артикула в документе → null БЕЗ единого запроса', async () => {
    // ⚠ Раньше эта строка уходила искать по имени. Теперь запроса нет вовсе: искать нечем.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => rows({ id: 4 }))
    expect(await findProduct(item(), m, call, IB)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('нет свойства артикула в настройках → внешний код ВСЁ РАВНО пробуется', async () => {
    // ⚠ Внешний код `XML_ID` — системное поле `crm.product`, настройки оно не требует. Прежде обе
    // ветки сидели под одним гейтом `article.field`, и портал, где админ не выбрал свойство
    // артикула, не делал в каталог НИ ОДНОГО запроса — даже когда артикулы документа буквально
    // равны внешним кодам его товаров. Пока существовал подбор по имени, дыру частично прикрывал
    // он; с его удалением она стала видимой и дорогой.
    const m = defaultMapping()
    m.article.field = ''
    const call = vi.fn(async () => rows({ id: 21, xmlId: 'EXT-1' }))
    expect(await findProduct(item({ article: 'EXT-1' }), m, call, IB)).toBe(21)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('catalog.product.list', { filter: { iblockId: PRODUCT_IBLOCK, xmlId: 'EXT-1', active: 'Y' }, select: ['id', 'iblockId', 'xmlId'] })
  })

  it('свойство ищется ПОСЛЕ внешнего кода и ровно один раз', async () => {
    // ⚠ Порядок изменён 2026-08-05 (решение владельца): сперва внешние коды, потом свойство.
    // Внешний код настройки не требует, поэтому портал, где админ ничего не выбрал, всё равно
    // подбирает товар. Прежде свойство стояло первым, а внешний код базового товара был заперт за
    // настройкой свойства — то есть на ненастроенном портале не пробовался вовсе.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn()
      .mockResolvedValueOnce(rows()) // внешний код — промах
      .mockResolvedValueOnce(rows({ id: 12, property130: 'A-1' })) // свойство — попадание
    expect(await findProduct(item({ article: 'A-1' }), m, call, IB)).toBe(12)
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenNthCalledWith(1, 'catalog.product.list', { filter: { iblockId: PRODUCT_IBLOCK, xmlId: 'A-1', active: 'Y' }, select: ['id', 'iblockId', 'xmlId'] })
    expect(call).toHaveBeenNthCalledWith(2, 'catalog.product.list', { filter: { 'iblockId': PRODUCT_IBLOCK, '%property130': 'A-1', 'active': 'Y' }, select: ['id', 'iblockId', 'property130'], order: { id: 'asc' } })
  })
  it('внешний код совпал → свойство НЕ запрашивается', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => rows({ id: 21, xmlId: 'EXT-1' }))
    expect(await findProduct(item({ article: 'EXT-1' }), m, call, IB)).toBe(21)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('catalog.product.list', { filter: { iblockId: PRODUCT_IBLOCK, xmlId: 'EXT-1', active: 'Y' }, select: ['id', 'iblockId', 'xmlId'] })
  })

  it('OFFER (SKU) has PRIORITY: article matches an offer xmlId → returns offer id, no product lookup', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async (method: string) =>
      method === 'catalog.product.offer.list' ? { offers: [{ id: 3, iblockId: 27, xmlId: '1030162' }] } : rows())
    // Инфоблок предложений задан → они пробуются ПЕРВЫМИ; попадание ⇒ базовый товар не запрашивается.
    expect(await findProduct(item({ article: '1030162' }), m, call, { offer: [27], product: [PRODUCT_IBLOCK] })).toBe(3)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('catalog.product.offer.list', { filter: { iblockId: 27, xmlId: '1030162', active: 'Y' }, select: ['id', 'iblockId', 'xmlId'] })
  })

  it('offer miss → falls through to the base-product lookup', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    // Внешний код предложения — промах; внешний код товара — промах; свойство — попадание.
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'catalog.product.offer.list') return { offers: [] }
      const filter = params.filter as Record<string, unknown>
      return 'xmlId' in filter ? rows() : rows({ id: 77, property130: 'A-1' })
    })
    expect(await findProduct(item({ article: 'A-1' }), m, call, { offer: [27], product: [PRODUCT_IBLOCK] })).toBe(77)
    expect(call).toHaveBeenCalledWith('catalog.product.list', { filter: { 'iblockId': PRODUCT_IBLOCK, '%property130': 'A-1', 'active': 'Y' }, select: ['id', 'iblockId', 'property130'], order: { id: 'asc' } })
  })

  it('НЕСКОЛЬКО товарных каталогов: перебираем до первого попадания', async () => {
    // ⚠ Решение владельца 06.08.2026. Прежде брался ПЕРВЫЙ каталог, и товар из второго не
    // находился НИКОГДА, причём молча: строка уезжала свободной позицией, сумма сходилась, статус
    // «Готово» — исход неотличим от «такого товара в каталоге нет».
    const m = defaultMapping()
    m.article.field = ''
    const call = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      const filter = params.filter as Record<string, unknown>
      return filter.iblockId === 31 ? rows({ id: 55, xmlId: 'EXT-9' }) : rows()
    })
    expect(await findProduct(item({ article: 'EXT-9' }), m, call, { offer: [], product: [25, 31] })).toBe(55)
    expect(call, 'первый каталог промахнулся ⇒ обязан быть второй запрос').toHaveBeenCalledTimes(2)
  })

  it('НЕОДНОЗНАЧНОСТЬ прекращает подбор целиком, а не только текущий каталог', async () => {
    // ⚠ Дефект, найденный разбором в первой редакции перебора: `findCatalogByXmlId` отвечал `null`
    // и на «не нашли», и на «отказался выбирать из двух написаний», а перебор шёл дальше. Тогда
    // каталог A с парой `ZQ-1`/`zq-1` давал отказ, а каталог B подсовывал ПОСТОРОННИЙ товар —
    // то есть гард против подмены товара сам приводил к подмене, только из другого каталога.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      const filter = params.filter as Record<string, unknown>
      return filter.iblockId === 25
        ? rows({ id: 5, xmlId: 'ZQ-1' }, { id: 6, xmlId: 'zq-1' }) // неоднозначно
        : rows({ id: 99, xmlId: 'ZQ-1' }) // чужой каталог, «нашлось бы»
    })
    expect(await findProduct(item({ article: 'zq-1' }), m, call, { offer: [], product: [25, 31] })).toBeNull()
    expect(call, 'после отказа по неоднозначности во второй каталог ходить нельзя').toHaveBeenCalledTimes(1)
  })

  it('портал вернул НЕ ТО: строки, чей внешний код не равен запрошенному → подбора нет', async () => {
    // ⚠ Сверка на клиенте нужна и здесь, а не только у свойства: портал уже был замечен на том,
    // что молча игнорирует непонятный фильтр и отдаёт весь список. Плюс значение уходит в `LIKE`,
    // где `%`/`_` — джокеры: артикул «ZQ_1» совпал бы расширенно, и проверка неоднозначности
    // молчала бы (написание в ответе одно).
    const m = defaultMapping()
    m.article.field = ''
    const call = vi.fn(async () => rows({ id: 7, xmlId: 'СОВСЕМ-ДРУГОЕ' }, { id: 8 }))
    expect(await findProduct(item({ article: 'ZQ_1' }), m, call, IB)).toBeNull()
  })

  it('нашли в первом каталоге → во второй не ходим', async () => {
    // Обратная половина: перебор идёт ТОЛЬКО пока не нашли, иначе портал с N каталогами платил бы
    // N запросов за каждую УСПЕШНО подобранную позицию.
    const m = defaultMapping()
    m.article.field = ''
    const call = vi.fn(async () => rows({ id: 55, xmlId: 'EXT-9' }))
    expect(await findProduct(item({ article: 'EXT-9' }), m, call, { offer: [], product: [25, 31] })).toBe(55)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('offersIblockId null (no SKU catalog) → offers skipped entirely (pre-offer behaviour)', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => rows({ id: 9, property130: 'A-1' }))
    expect(await findProduct(item({ article: 'A-1' }), m, call, IB)).toBe(9)
    // No catalog.product.offer.list call at all.
    expect(call).not.toHaveBeenCalledWith('catalog.product.offer.list', expect.anything())
  })
})
