import { resolveIblocks } from '../server/utils/catalogLookup'
import { describe, expect, it } from 'vitest'
import {
  normalizeProperties,
  filterProperties,
  searchCatalogProperties
} from '../server/utils/catalogPropertySearch'
import type { RestCall } from '../server/utils/b24Rest'

// Shapes as a real RestCall (makeRestCall) delivers them: it UNWRAPS the B24 envelope
// (returns `json.result`), so the core sees `{ catalogs }` / `{ productProperties }`
// directly — NOT `{ result: { … } }`. (An earlier draft double-unwrapped `.result`;
// tests returning the raw wire shape hid that the picker was always empty in prod.)
//   catalog.catalog.list → { catalogs: [ { iblockId, productIblockId, name } ] }
//   catalog.productProperty.list → { productProperties: [ { id, code, name, propertyType } ] }
const CATALOGS = {
  catalogs: [
    { iblockId: 25, productIblockId: null, name: 'CRM Product Catalog' },
    { iblockId: 27, productIblockId: 25, name: 'CRM Product Catalog (offers)' }
  ]
}
const PROPERTIES = {
  productProperties: [
    { id: 93, code: 'MORE_PHOTO', name: 'Image', propertyType: 'F' },
    { id: 99, code: 'SUPPLIER_ARTICLE', name: 'Артикул поставщика', propertyType: 'S' },
    { id: 100, code: '', name: 'Безымянное', propertyType: 'S' } // no code → PROPERTY_100
  ]
}

/** Fake RestCall dispatching by method. */
function fakeCall(overrides: Partial<Record<string, unknown>> = {}): RestCall {
  return (method) => {
    if (method === 'catalog.catalog.list') return Promise.resolve(overrides['catalog.catalog.list'] ?? CATALOGS)
    if (method === 'catalog.productProperty.list') return Promise.resolve(overrides['catalog.productProperty.list'] ?? PROPERTIES)
    return Promise.resolve({})
  }
}

describe('resolveIblocks', () => {
  it('различает инфоблок предложений и родительский инфоблок товаров', async () => {
    // ⚠ Прежде читался ТОЛЬКО основной каталог товаров, и свойства торговых предложений в пикер
    // не попадали вовсе: админ портала с SKU физически не мог выбрать своё свойство артикула.
    expect(await resolveIblocks(fakeCall())).toEqual({ offer: [27], product: [25] })
  })
  it('портал без предложений: только товары', async () => {
    const call = fakeCall({ 'catalog.catalog.list': { catalogs: [{ iblockId: 25, productIblockId: null }] } })
    expect(await resolveIblocks(call)).toEqual({ offer: [], product: [25] })
  })
  it('несколько каталогов → ВСЕ, а не первый (и родитель предложений тоже в списке)', async () => {
    // ⚠ Инвариант ИЗМЕНЁН осознанно (решение владельца 06.08.2026). Прежде функция выбирала ОДИН
    // товарный инфоблок, и на портале с несколькими каталогами позиция из второго не находилась
    // НИКОГДА — исход неотличим от «товара нет в каталоге»: строка уезжает свободной, сумма
    // сходится, статус «Готово». Теперь возвращаются все, а подбор перебирает их до первого
    // попадания.
    // ⚠ Родитель каталога предложений (25) обязан попасть в список товаров, даже если отдельной
    // строкой портал его не прислал: иначе базовый товар под SKU-каталогом был бы недостижим.
    const call = fakeCall({ 'catalog.catalog.list': { catalogs: [
      { iblockId: 40, productIblockId: null },
      { iblockId: 27, productIblockId: 25 }
    ] } })
    expect(await resolveIblocks(call)).toEqual({ offer: [27], product: [40, 25] })
  })

  it('товарный инфоблок не задваивается, придя и сам, и как родитель предложений', async () => {
    const call = fakeCall({ 'catalog.catalog.list': { catalogs: [
      { iblockId: 25, productIblockId: null },
      { iblockId: 27, productIblockId: 25 }
    ] } })
    expect(await resolveIblocks(call)).toEqual({ offer: [27], product: [25] })
  })
  it('каталогов нет → оба null', async () => {
    const call = fakeCall({ 'catalog.catalog.list': { catalogs: [] } })
    expect(await resolveIblocks(call)).toEqual({ offer: [], product: [] })
  })
})

describe('normalizeProperties', () => {
  it('maps to { value: code, label: name }, PROPERTY_<id> when no code', () => {
    // ⚠ Картинка (`F`) ОТСЕЯНА: под артикул годятся только строковые/текстовые свойства. Прежде
    // пикер показывал всё подряд, и выбрать картинку можно было в один клик — а последствие
    // молчаливое: подбор не находит ничего, потому что искомого в этом поле не бывает.
    const opts = normalizeProperties(PROPERTIES)
    expect(opts).toEqual([
      { value: 'SUPPLIER_ARTICLE', label: 'Артикул поставщика', code: 'SUPPLIER_ARTICLE', id: 99, scope: 'product', group: 'Товары' },
      { value: 'PROPERTY_100', label: 'Безымянное', code: undefined, id: 100, scope: 'product', group: 'Товары' }
    ])
  })
  it('drops a property with neither code nor a positive id', () => {
    const opts = normalizeProperties({ productProperties: [{ id: 0, code: '', name: 'X' }] })
    expect(opts).toEqual([])
  })
  it('returns [] for a malformed response', () => {
    expect(normalizeProperties(null)).toEqual([])
    expect(normalizeProperties({})).toEqual([])
  })
})

describe('filterProperties', () => {
  const opts = normalizeProperties(PROPERTIES)
  it('empty query → all', () => {
    // Две, а не три: картинка отсеяна по типу.
    expect(filterProperties(opts, '')).toHaveLength(2)
  })
  it('matches on label (case-insensitive Cyrillic)', () => {
    expect(filterProperties(opts, 'артикул').map(o => o.value)).toEqual(['SUPPLIER_ARTICLE'])
  })
  it('matches on value/code', () => {
    expect(filterProperties(opts, 'supplier').map(o => o.label)).toEqual(['Артикул поставщика'])
  })
})

/** Fake SdkTransport: `.call` for catalog.catalog.list, `.list` for the full property fetch
 *  (returns the flat productProperties array, as makeSdkListCall does). */
function fakeTransport(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    call: fakeCall(overrides),
    list: async (_method: string, _params?: Record<string, unknown>, opts?: { idKey?: string, listKey?: string }) => {
      // The picker must request the grouped key + lowercase cursor for catalog.productProperty.list.
      expect(opts).toEqual({ idKey: 'id', listKey: 'productProperties' })
      const rows = (overrides['catalog.productProperty.list'] as { productProperties?: unknown[] })?.productProperties
      return rows ?? PROPERTIES.productProperties
    }
  }
}

describe('searchCatalogProperties', () => {
  it('перечисляет ОБА инфоблока, предложения первыми', async () => {
    // ⚠ Фейк отдаёт один и тот же список свойств на оба инфоблока, поэтому строки удваиваются —
    // важен здесь ПОРЯДОК групп и то, что второй инфоблок вообще опрашивается.
    const page = await searchCatalogProperties(fakeTransport(), 'артикул')
    expect(page.items.map(o => o.group)).toEqual(['Торговые предложения (SKU)', 'Товары'])
    expect(page.items.every(o => o.value === 'SUPPLIER_ARTICLE')).toBe(true)
    expect(page.hasMore).toBe(false)
  })
  it('empty query returns the full property list', async () => {
    const page = await searchCatalogProperties(fakeTransport(), '')
    expect(page.items).toHaveLength(4) // по два годных свойства на каждый из двух инфоблоков
    expect(page.hasMore).toBe(false)
  })
  it('no catalog → empty page (never throws, never lists properties)', async () => {
    const t = fakeTransport({ 'catalog.catalog.list': { catalogs: [] } })
    expect(await searchCatalogProperties(t, '')).toEqual({ items: [], hasMore: false })
  })
})
