import { describe, expect, it, vi } from 'vitest'
import { findProduct, findProductByArticle, findProductByXmlId } from '../server/utils/productLookup'
import { defaultMapping } from '../app/utils/portalSettings'
import type { DocumentItem } from '../app/types/document'

const item = (over: Partial<DocumentItem> = {}): DocumentItem => ({ name: 'Гвоздь', price: 1, quantity: 1, ...over })

const artCfg = (over: Partial<ReturnType<typeof defaultMapping>['article']> = {}) => ({ ...defaultMapping().article, field: '130', kind: 'text' as const, ...over })

describe('findProductByArticle (%LIKE narrows → exact membership; live-verified)', () => {
  it('text variant: %LIKE query (ordered), membership by newline split', async () => {
    const call = vi.fn(async () => [{ ID: '7', PROPERTY_130: { value: 'A-100\nA-200' } }])
    expect(await findProductByArticle('A-100', artCfg(), call)).toBe(7)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { '%PROPERTY_130': 'A-100', 'ACTIVE': 'Y' }, select: ['ID', 'PROPERTY_130'], order: { ID: 'ASC' } })
  })
  it('rejects a LIKE false positive (A-10 is NOT an exact member of {A-100, A-200})', async () => {
    const call = vi.fn(async () => [{ ID: '7', PROPERTY_130: { value: 'A-100\nA-200' } }])
    expect(await findProductByArticle('A-10', artCfg(), call)).toBeNull()
  })
  it('string variant: splits by the configured delimiter; accepts a plain-string value', async () => {
    const call = vi.fn(async () => [{ ID: '9', PROPERTY_130: 'BV-12;EXTRA-7' }])
    expect(await findProductByArticle('EXTRA-7', artCfg({ kind: 'string', delimiter: ';' }), call)).toBe(9)
  })
  it('string variant defaults to comma when no delimiter configured', async () => {
    const call = vi.fn(async () => [{ ID: '9', PROPERTY_130: 'BV-12,EXTRA-7' }])
    expect(await findProductByArticle('EXTRA-7', artCfg({ kind: 'string', delimiter: undefined }), call)).toBe(9)
  })
  it('selects the correct product among MIXED candidates (some pass, some fail membership)', async () => {
    const call = vi.fn(async () => [
      { ID: '5', PROPERTY_130: 'A-100\nA-200' }, // substring hit, NOT exact member of 'A-1'
      { ID: '8', PROPERTY_130: 'A-1\nZ-9' }, //     exact member
      { ID: '3', PROPERTY_130: 'A-15' } //         substring hit, not exact
    ])
    expect(await findProductByArticle('A-1', artCfg(), call)).toBe(8)
  })
  it('homoglyph-tolerant membership among returned rows (Cyrillic С ↔ Latin C)', async () => {
    // LIKE already returned the row (bytes agree here); the fold confirms the match.
    const call = vi.fn(async () => [{ ID: '4', PROPERTY_130: 'СTP-5\nX-2' }]) // Cyrillic С
    expect(await findProductByArticle('CTP-5', artCfg(), call)).toBe(4) // Latin C
  })
  it('multiple-value property (array / index-object) is flattened', async () => {
    const arr = vi.fn(async () => [{ ID: '6', PROPERTY_130: ['A-100', 'A-200'] }])
    expect(await findProductByArticle('A-200', artCfg(), arr)).toBe(6)
    const idx = vi.fn(async () => [{ ID: '6', PROPERTY_130: { 0: { value: 'A-100' }, 1: { value: 'A-200' } } }])
    expect(await findProductByArticle('A-200', artCfg(), idx)).toBe(6)
  })
  it('null/missing property value → no match (propValue null branch)', async () => {
    const call = vi.fn(async () => [{ ID: '7', PROPERTY_130: null }])
    expect(await findProductByArticle('A-100', artCfg(), call)).toBeNull()
  })
  it('symbolic (non-numeric) field is REJECTED → no REST call (live: %LIKE on code returns all)', async () => {
    const call = vi.fn(async () => [{ ID: '1' }])
    expect(await findProductByArticle('A-100', artCfg({ field: 'ARTNUMBER' }), call)).toBeNull()
    expect(await findProductByArticle('A-100', artCfg({ field: 'PROPERTY_ART' }), call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('null on empty article or empty field', async () => {
    const call = vi.fn(async () => [])
    expect(await findProductByArticle('', artCfg(), call)).toBeNull()
    expect(await findProductByArticle('A', artCfg({ field: '  ' }), call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})

describe('findProductByXmlId (external code «внешний код», ACTIVE-only)', () => {
  it('filters by XML_ID + ACTIVE and returns the smallest positive id', async () => {
    const call = vi.fn(async () => [{ ID: '18' }, { ID: '15' }])
    expect(await findProductByXmlId('EXT-42', call)).toBe(15)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { XML_ID: 'EXT-42', ACTIVE: 'Y' }, select: ['ID'] })
  })
  it('null on empty code or no rows (no REST call for empty)', async () => {
    const call = vi.fn(async () => [])
    expect(await findProductByXmlId('   ', call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(await findProductByXmlId('x', vi.fn(async () => undefined))).toBeNull()
  })
})

describe('findProduct (strategy routing)', () => {
  it('ПО ИМЕНИ НЕ ИЩЕМ: артикул не совпал ни свойством, ни внешним кодом → null, третьего вызова нет', async () => {
    // ⚠ Решение владельца 2026-08-05. Имя товара не идентификатор: у каждого поставщика своё
    // написание одной позиции. Неверно подобранный товар пишет в карточку клиента ЧУЖУЮ позицию —
    // со своей ценой, единицей и остатком, — и всплывает это в отчётах, а не при импорте.
    // Проверяется ЧИСЛО вызовов: возврат подбора по имени — это ровно третий `crm.product.list`.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => [])
    expect(await findProduct(item({ article: 'A-1' }), m, call)).toBeNull()
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
    const call = vi.fn(async () => [{ ID: '7', NAME: 'Гвоздь' }])
    expect(await findProduct(item(), m, call)).toBeNull()
  })

  it('нет артикула в документе → null БЕЗ единого запроса', async () => {
    // ⚠ Раньше эта строка уходила искать по имени. Теперь запроса нет вовсе: искать нечем.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => [{ ID: '4' }])
    expect(await findProduct(item(), m, call)).toBeNull()
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
    const call = vi.fn(async () => [{ ID: '21' }])
    expect(await findProduct(item({ article: 'EXT-1' }), m, call)).toBe(21)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { XML_ID: 'EXT-1', ACTIVE: 'Y' }, select: ['ID'] })
  })

  it('свойство ищется ПОСЛЕ внешнего кода и ровно один раз', async () => {
    // ⚠ Порядок изменён 2026-08-05 (решение владельца): сперва внешние коды, потом свойство.
    // Внешний код настройки не требует, поэтому портал, где админ ничего не выбрал, всё равно
    // подбирает товар. Прежде свойство стояло первым, а внешний код базового товара был заперт за
    // настройкой свойства — то есть на ненастроенном портале не пробовался вовсе.
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn()
      .mockResolvedValueOnce([]) // внешний код — промах
      .mockResolvedValueOnce([{ ID: '12', PROPERTY_130: 'A-1' }]) // свойство — попадание
    expect(await findProduct(item({ article: 'A-1' }), m, call)).toBe(12)
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenNthCalledWith(1, 'crm.product.list', { filter: { XML_ID: 'A-1', ACTIVE: 'Y' }, select: ['ID'] })
    expect(call).toHaveBeenNthCalledWith(2, 'crm.product.list', { filter: { '%PROPERTY_130': 'A-1', 'ACTIVE': 'Y' }, select: ['ID', 'PROPERTY_130'], order: { ID: 'ASC' } })
  })
  it('внешний код совпал → свойство НЕ запрашивается', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => [{ ID: '21' }])
    expect(await findProduct(item({ article: 'EXT-1' }), m, call)).toBe(21)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { XML_ID: 'EXT-1', ACTIVE: 'Y' }, select: ['ID'] })
  })

  it('OFFER (SKU) has PRIORITY: article matches an offer xmlId → returns offer id, no product lookup', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async (method: string) =>
      method === 'catalog.product.offer.list' ? { offers: [{ id: 3, iblockId: 27 }] } : [])
    // offersIblockId=27 → offers tried first, article '1030162' matches → offer id 3, no crm.product.list.
    expect(await findProduct(item({ article: '1030162' }), m, call, 27)).toBe(3)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('catalog.product.offer.list', { select: ['id', 'iblockId'], filter: { iblockId: 27, xmlId: '1030162', active: 'Y' } })
  })

  it('offer miss → falls through to the base-product lookup', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    // Внешний код предложения — промах; внешний код товара — промах; свойство — попадание.
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'catalog.product.offer.list') return { offers: [] }
      const filter = params.filter as Record<string, unknown>
      return 'XML_ID' in filter ? [] : [{ ID: '77', PROPERTY_130: 'A-1' }]
    })
    expect(await findProduct(item({ article: 'A-1' }), m, call, 27)).toBe(77)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { '%PROPERTY_130': 'A-1', 'ACTIVE': 'Y' }, select: ['ID', 'PROPERTY_130'], order: { ID: 'ASC' } })
  })

  it('offersIblockId null (no SKU catalog) → offers skipped entirely (pre-offer behaviour)', async () => {
    const m = defaultMapping()
    m.article.field = '130'
    const call = vi.fn(async () => [{ ID: '9', PROPERTY_130: 'A-1' }])
    expect(await findProduct(item({ article: 'A-1' }), m, call, null)).toBe(9)
    // No catalog.product.offer.list call at all.
    expect(call).not.toHaveBeenCalledWith('catalog.product.offer.list', expect.anything())
  })
})
