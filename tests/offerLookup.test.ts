import { describe, expect, it, vi } from 'vitest'
import { resolveOffersIblockId, findOfferByXmlId, findOfferByName, findOfferForItem } from '../server/utils/offerLookup'

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
    expect(call).toHaveBeenCalledWith('catalog.product.offer.list', { select: ['id', 'iblockId'], filter: { iblockId: 27, xmlId: '1030162', active: 'Y' } })
  })
  it('null on empty xmlId / missing iblock / no offers (no bad call)', async () => {
    const empty = vi.fn(async () => ({ offers: [] }))
    expect(await findOfferByXmlId('  ', 27, empty)).toBeNull()
    expect(await findOfferByXmlId('x', 0, empty)).toBeNull()
    expect(empty).not.toHaveBeenCalled()
    expect(await findOfferByXmlId('NOPE', 27, empty)).toBeNull()
  })
})

describe('findOfferByName', () => {
  it('filters by iblockId + name + active → min id', async () => {
    const call = vi.fn(async () => ({ offers: [{ id: 3, iblockId: 27 }] }))
    expect(await findOfferByName('Мешок', 27, call)).toBe(3)
    expect(call).toHaveBeenCalledWith('catalog.product.offer.list', { select: ['id', 'iblockId'], filter: { iblockId: 27, name: 'Мешок', active: 'Y' } })
  })
})

describe('findOfferForItem', () => {
  it('article-as-xmlId first, then name', async () => {
    // article hit → one call, no name lookup
    const artHit = vi.fn(async () => ({ offers: [{ id: 3, iblockId: 27 }] }))
    expect(await findOfferForItem('1030162', 'Мешок', 27, artHit)).toBe(3)
    expect(artHit).toHaveBeenCalledTimes(1)
    // article miss → falls to name
    const call = vi.fn()
      .mockResolvedValueOnce({ offers: [] }) // xmlId miss
      .mockResolvedValueOnce({ offers: [{ id: 8, iblockId: 27 }] }) // name hit
    expect(await findOfferForItem('NOPE', 'Мешок', 27, call)).toBe(8)
    expect(call).toHaveBeenCalledTimes(2)
  })
  it('no offers iblock → null (fail-soft, no call)', async () => {
    const call = vi.fn()
    expect(await findOfferForItem('x', 'y', null, call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
