import { describe, expect, it, vi } from 'vitest'
import { buildProductRow, buildProductRows, computeOpportunity, createTargetItem, ownerTypeCode, setProductRows, supportsOpportunity } from '../server/utils/crmWrite'
import { findCompanyByTaxId } from '../server/utils/companyLookup'
import { buildConfigurableActivity, entityOpenPath } from '../server/utils/configurableActivity'
import { monthlySubfolderName, pickCommonStorage } from '../server/utils/disk'

describe('computeOpportunity', () => {
  it('sums gross: inclusive rows as-is, net rows + VAT', () => {
    // 100×2 incl → 200; net 100×1 @20% → 120 ⇒ 320
    expect(computeOpportunity([
      { price: 100, quantity: 2, taxRate: 22, taxIncluded: 'Y' },
      { price: 100, quantity: 1, taxRate: 20, taxIncluded: 'N' }
    ])).toBe(320)
  })
  it('null taxRate = no VAT; empty rows = 0', () => {
    expect(computeOpportunity([{ price: 50, quantity: 3, taxRate: null, taxIncluded: 'N' }])).toBe(150)
    expect(computeOpportunity([])).toBe(0)
  })
  it('non-finite price → 0; missing quantity → 1 (matches buildProductRow clamps)', () => {
    expect(computeOpportunity([{ price: NaN, quantity: 2, taxIncluded: 'Y' }])).toBe(0)
    expect(computeOpportunity([{ price: 100, quantity: NaN, taxIncluded: 'Y' }])).toBe(100)
  })
  it('rounds per-unit gross BEFORE ×qty (matches Bitrix priceBrutto), not once at the end', () => {
    // net 10.11 @20% → unit round2(12.132)=12.13 ×3 = 36.39 (NOT 36.40 from line-then-round)
    expect(computeOpportunity([{ price: 10.11, quantity: 3, taxRate: 20, taxIncluded: 'N' }])).toBe(36.39)
  })
})

describe('supportsOpportunity', () => {
  it('true for deal/quote/smart-invoice, false for smart-process and others', () => {
    expect(supportsOpportunity(2)).toBe(true)
    expect(supportsOpportunity(7)).toBe(true)
    expect(supportsOpportunity(31)).toBe(true)
    expect(supportsOpportunity(1032)).toBe(false)
    expect(supportsOpportunity(1)).toBe(false)
  })
})

describe('crmWrite', () => {
  it('ownerTypeCode', () => {
    expect(ownerTypeCode(2)).toBe('D')
    expect(ownerTypeCode(7)).toBe('Q')
    expect(ownerTypeCode(31)).toBe('SI')
    expect(ownerTypeCode(1030)).toBe('T1030') // dynamic smart-process
  })
  it('buildProductRow: taxIncluded + clamp + productId omitted when absent', () => {
    const row = buildProductRow({ productName: 'x', price: 4.355, quantity: 2, taxRate: 22, priceIncludesVat: true, measureCode: 796 }, 10)
    expect(row.taxIncluded).toBe('Y')
    expect(row.price).toBe(4.36)
    expect(row).not.toHaveProperty('productId')
  })
  it('buildProductRows maps items via resolver', () => {
    const rows = buildProductRows(
      [{ name: 'a', price: 10, quantity: 1 }, { name: 'b', price: 20, quantity: 3 }],
      () => ({ taxRate: 20, measureCode: 796 }),
      false
    )
    expect(rows).toHaveLength(2)
    expect(rows[1]!.taxIncluded).toBe('N')
    expect(rows[1]!.sort).toBe(20)
  })
  it('createTargetItem + setProductRows call REST correctly', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ item: { id: 55 } })
      .mockResolvedValueOnce({ productRows: [] })
    const id = await createTargetItem({ entityTypeId: 2, categoryId: 1 }, { title: 't' }, call)
    expect(id).toBe(55)
    expect(call).toHaveBeenCalledWith('crm.item.add', { entityTypeId: 2, fields: { title: 't', categoryId: 1 } })
    await setProductRows(2, 55, [{ price: 1 }], call)
    expect(call).toHaveBeenLastCalledWith('crm.item.productrow.set', { ownerType: 'D', ownerId: 55, productRows: [{ price: 1 }] })
  })
})

describe('companyLookup', () => {
  it('returns minimal company id, strips non-digits', async () => {
    const call = vi.fn().mockResolvedValue([{ ENTITY_ID: '30' }, { ENTITY_ID: '12' }])
    expect(await findCompanyByTaxId('УНП 190 000 000', call)).toBe(12)
    expect(call).toHaveBeenCalledWith('crm.requisite.list', expect.objectContaining({ filter: expect.objectContaining({ RQ_INN: '190000000' }) }))
  })
  it('null when none / empty tax id', async () => {
    expect(await findCompanyByTaxId('', vi.fn())).toBeNull()
    expect(await findCompanyByTaxId('123', vi.fn().mockResolvedValue([]))).toBeNull()
  })
})

describe('disk + activity', () => {
  it('pickCommonStorage', () => {
    expect(pickCommonStorage([{ ID: '1', ENTITY_TYPE: 'user', NAME: 'u' }, { ID: '3', ENTITY_TYPE: 'common', NAME: 'Общий' }])?.ID).toBe('3')
  })
  it('monthlySubfolderName', () => {
    expect(monthlySubfolderName({ getFullYear: () => 2026, getMonth: () => 6 })).toBe('2026-07')
  })
  it('entityOpenPath', () => {
    expect(entityOpenPath(2, 5)).toBe('/crm/deal/details/5/')
    expect(entityOpenPath(1030, 9)).toBe('/crm/type/1030/details/9/')
  })
  it('buildConfigurableActivity shape', () => {
    const a = buildConfigurableActivity({ entityTypeId: 2, ownerId: 5, title: 'Импорт', lines: ['1 позиция'], openPath: '/crm/deal/details/5/' })
    expect(a.ownerTypeId).toBe(2)
    expect((a.fields as { typeId: string }).typeId).toBe('CONFIGURABLE')
    expect(a.layout).toBeDefined()
  })
})
