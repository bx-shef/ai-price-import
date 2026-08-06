import { describe, expect, it, vi } from 'vitest'
import { resolveOffersIblockId, findOfferByXmlId, findOfferForItem } from '../server/utils/offerLookup'

describe('resolveOffersIblockId', () => {
  it('picks the catalog whose productIblockId is set (the offers iblock)', async () => {
    const call = vi.fn(async () => ({
      catalogs: [
        { id: 25, iblockId: 25, productIblockId: null, name: 'Товары' },
        { id: 27, iblockId: 27, productIblockId: 25, name: 'Предложения' }
      ]
    }))
    expect(await resolveOffersIblockId(call)).toBe(27)
    expect(call).toHaveBeenCalledWith('catalog.catalog.list', {})
  })
  it('null when no catalog points at a product iblock (portal without SKU)', async () => {
    const call = vi.fn(async () => ({ catalogs: [{ id: 25, iblockId: 25, productIblockId: null }] }))
    expect(await resolveOffersIblockId(call)).toBeNull()
  })
  it('accepts a bare-array result too; null on empty', async () => {
    expect(await resolveOffersIblockId(vi.fn(async () => [{ id: 9, iblockId: 9, productIblockId: 8 }]))).toBe(9)
    expect(await resolveOffersIblockId(vi.fn(async () => ({})))).toBeNull()
  })
})

describe('findOfferByXmlId', () => {
  it('filters by iblockId + xmlId + active (iblockId in select too) → min id', async () => {
    const call = vi.fn(async () => ({ offers: [{ id: 3, iblockId: 27 }, { id: 5, iblockId: 27 }] }))
    expect(await findOfferByXmlId('1030162', 27, call)).toBe(3)
    expect(call).toHaveBeenCalledWith('catalog.product.offer.list', { filter: { iblockId: 27, xmlId: '1030162', active: 'Y' }, select: ['id', 'iblockId', 'xmlId'] })
  })
  it('null on empty xmlId / missing iblock / no offers (no bad call)', async () => {
    const empty = vi.fn(async () => ({ offers: [] }))
    expect(await findOfferByXmlId('  ', 27, empty)).toBeNull()
    expect(await findOfferByXmlId('x', 0, empty)).toBeNull()
    expect(empty).not.toHaveBeenCalled()
    expect(await findOfferByXmlId('NOPE', 27, empty)).toBeNull()
  })
})

describe('findOfferForItem', () => {
  it('ПО ИМЕНИ НЕ ИЩЕМ: артикул не совпал → null после РОВНО одного запроса', async () => {
    // ⚠ Зеркало решения по базовому товару: ошибочно подобранное торговое предложение так же пишет
    // в карточку клиента чужую позицию. Второй вызов здесь — это и есть возврат подбора по имени.
    const call = vi.fn(async () => ({ offers: [] }))
    expect(await findOfferForItem('A-1', 27, call)).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
    // ⚠ По ВСЕМ вызовам: прежняя проверяла только первый (а он всегда фильтр по xmlId), то есть
    // была истинна по построению и второй линией защиты не являлась.
    // ⚠ Названия товара нет уже в СИГНАТУРЕ, поэтому подставить его в фильтр неоткуда: проверка
    // держится не на строке, а на том, что функция названия не получает.
    for (const [, params] of call.mock.calls) {
      expect(JSON.stringify(params).toLowerCase(), 'в фильтре появилось имя').not.toContain('name')
    }
  })

  it('КАНАРЕЙКА: нет артикула, портал отвечает совпадением на ЛЮБОЙ запрос → всё равно null', async () => {
    // ⚠ Утверждение о поведении, а не о числе вызовов: совпасть при отсутствии артикула может
    // только имя. Переживает батчинг и кэш.
    const call = vi.fn(async () => ({ offers: [{ id: 5 }] }))
    expect(await findOfferForItem(undefined, 27, call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('no offers iblock → null (fail-soft, no call)', async () => {
    const call = vi.fn()
    expect(await findOfferForItem('x', null, call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
