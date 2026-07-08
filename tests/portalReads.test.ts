import { describe, expect, it, vi } from 'vitest'
import { fetchVatRates } from '../server/utils/portalVat'
import { fetchCurrencies } from '../server/utils/portalCurrency'

describe('fetchVatRates', () => {
  it('maps crm.vat.list (null RATE → «Без НДС», string → number)', async () => {
    const call = vi.fn().mockResolvedValue([
      { ID: '1', NAME: 'Без НДС', RATE: null },
      { ID: '3', NAME: 'НДС 0%', RATE: '0.00' },
      { ID: '5', NAME: 'НДС 22%', RATE: '22.00' }
    ])
    const out = await fetchVatRates(call)
    expect(out).toEqual([
      { id: '1', name: 'Без НДС', rate: null },
      { id: '3', name: 'НДС 0%', rate: 0 },
      { id: '5', name: 'НДС 22%', rate: 22 }
    ])
    expect(call).toHaveBeenCalledWith('crm.vat.list', expect.objectContaining({ filter: { ACTIVE: 'Y' } }))
  })
  it('empty on non-array; drops junk rates', async () => {
    expect(await fetchVatRates(vi.fn().mockResolvedValue(undefined))).toEqual([])
    const out = await fetchVatRates(vi.fn().mockResolvedValue([{ ID: '9', NAME: 'x', RATE: 'abc' }]))
    expect(out).toEqual([]) // NaN rate dropped
  })
})

describe('fetchCurrencies', () => {
  it('extracts uppercased 3-letter codes', async () => {
    const call = vi.fn().mockResolvedValue([{ CURRENCY: 'rub' }, { CURRENCY: 'USD' }, { CURRENCY: 'BYN' }])
    expect(await fetchCurrencies(call)).toEqual(['RUB', 'USD', 'BYN'])
  })
  it('filters malformed codes; empty on non-array', async () => {
    expect(await fetchCurrencies(vi.fn().mockResolvedValue([{ CURRENCY: 'US' }, { CURRENCY: '' }, {}]))).toEqual([])
    expect(await fetchCurrencies(vi.fn().mockResolvedValue(null))).toEqual([])
  })
})

describe('findProductByName', () => {
  it('returns min ID on exact-name match, null when none', async () => {
    const { findProductByName } = await import('../server/utils/productLookup')
    expect(await findProductByName('Болт', vi.fn().mockResolvedValue([{ ID: '31' }, { ID: '12' }]))).toBe(12)
    expect(await findProductByName('X', vi.fn().mockResolvedValue([]))).toBeNull()
    expect(await findProductByName('  ', vi.fn())).toBeNull()
  })
})
