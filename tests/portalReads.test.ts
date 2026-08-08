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

describe('fetchBaseCurrency', () => {
  it('returns the BASE:Y currency, not the first row', async () => {
    const { fetchBaseCurrency } = await import('../server/utils/portalCurrency')
    const call = vi.fn().mockResolvedValue([
      { CURRENCY: 'USD', BASE: 'N' },
      { CURRENCY: 'kzt', BASE: 'Y' },
      { CURRENCY: 'BYN', BASE: 'N' }
    ])
    expect(await fetchBaseCurrency(call)).toBe('KZT')
  })
  it('null when nothing is marked base / the answer is junk', async () => {
    const { fetchBaseCurrency } = await import('../server/utils/portalCurrency')
    expect(await fetchBaseCurrency(vi.fn().mockResolvedValue([{ CURRENCY: 'RUB', BASE: 'N' }]))).toBeNull()
    expect(await fetchBaseCurrency(vi.fn().mockResolvedValue([{ CURRENCY: 'RU', BASE: 'Y' }]))).toBeNull()
    expect(await fetchBaseCurrency(vi.fn().mockResolvedValue(null))).toBeNull()
  })
})

describe('findProduct — подбора по имени НЕТ', () => {
  it('дефолтные настройки + строка без артикула → null, ни одного запроса', async () => {
    // ⚠ Раньше здесь утверждалось обратное («resolves by item name»), и это было верно для той
    // редакции. Решение владельца 2026-08-05: имя товара не идентификатор, подбор по нему убран —
    // ошибочное совпадение писало бы в карточку клиента чужую позицию.
    const { findProduct } = await import('../server/utils/productLookup')
    const { defaultMapping } = await import('../app/utils/portalSettings')
    const call = vi.fn().mockResolvedValue([{ ID: '7' }])
    expect(await findProduct({ name: 'Гвоздь', price: 1, quantity: 1 }, defaultMapping(), call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})
