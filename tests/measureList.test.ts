import { describe, expect, it, vi } from 'vitest'
import { normalizeMeasures, listMeasures, fetchMeasureRows, enrichMeasureRow, SYSTEM_MEASURE_RU } from '../server/utils/measureList'

describe('enrichMeasureRow (fill Russian label for system measures the modern API leaves null)', () => {
  it('fills measureTitle/symbol from SYSTEM_MEASURE_RU for a known system code with null fields', () => {
    const out = enrichMeasureRow({ code: 796, measureTitle: null, symbol: null, symbolIntl: 'pc. 1' })
    expect(out.measureTitle).toBe('Штука')
    expect(out.symbol).toBe('шт')
  })
  it('leaves a CUSTOM measure (own title/symbol) untouched', () => {
    const row = { code: 5001, measureTitle: 'Рулон 50м', symbol: 'рул50' }
    expect(enrichMeasureRow(row)).toBe(row) // same ref — not modified
  })
  it('unknown system code with null fields → not enriched (falls back to symbolIntl in the label)', () => {
    const out = enrichMeasureRow({ code: 999, measureTitle: null, symbol: null, symbolIntl: 'x' })
    expect(out.measureTitle == null).toBe(true)
    expect(out.symbol == null).toBe(true)
  })
})

describe('normalizeMeasures', () => {
  it('maps rows to { value, label } and enriches system codes to the Russian label', () => {
    // Live shape of catalog.measure.list for built-ins: null title/symbol, only symbolIntl.
    const out = normalizeMeasures({ measures: [
      { code: 6, measureTitle: null, symbol: null, symbolIntl: 'm' },
      { code: 796, measureTitle: null, symbol: null, symbolIntl: 'pc. 1' }
    ] })
    expect(out).toEqual([
      { value: '6', label: 'Метр (м)' }, // enriched, not «m»
      { value: '796', label: 'Штука (шт)' } // enriched, not «pc. 1»
    ])
  })
  it('uses a CUSTOM measure\'s own title/symbol as-is', () => {
    expect(normalizeMeasures([{ code: 5001, measureTitle: 'Погонный метр', symbol: 'пог.м' }]))
      .toEqual([{ value: '5001', label: 'Погонный метр (пог.м)' }])
  })
  it('accepts a bare array too', () => {
    expect(normalizeMeasures([{ code: 166, measureTitle: null, symbol: null }]))
      .toEqual([{ value: '166', label: 'Килограмм (кг)' }])
  })
  it('unknown system code → falls back to symbolIntl, then to «код N»', () => {
    expect(normalizeMeasures([{ code: 999, symbolIntl: 'MTR' }])).toEqual([{ value: '999', label: 'MTR' }])
    expect(normalizeMeasures([{ code: 998 }])).toEqual([{ value: '998', label: 'код 998' }])
  })
  it('drops rows with a bad code, dedups by code, skips null/primitive elements', () => {
    const out = normalizeMeasures([
      { code: 0, measureTitle: 'Ноль' },
      { code: -1 },
      null,
      'x',
      { code: 5002, measureTitle: 'Ящик', symbol: 'ящ' },
      { code: 5002, measureTitle: 'Дубль', symbol: 'д' }
    ])
    expect(out).toEqual([{ value: '5002', label: 'Ящик (ящ)' }])
  })
  it('returns [] for a non-array / non-{measures} result', () => {
    expect(normalizeMeasures(null)).toEqual([])
    expect(normalizeMeasures({ items: [] })).toEqual([])
  })
})

describe('listMeasures', () => {
  it('calls catalog.measure.list (non-deprecated) and normalizes with Russian enrichment', () => {
    const call = vi.fn(async () => ({ measures: [{ code: 796, measureTitle: null, symbol: null, symbolIntl: 'pc. 1' }] }))
    return listMeasures(call).then((out) => {
      expect(call).toHaveBeenCalledWith('catalog.measure.list', {})
      expect(out).toEqual([{ value: '796', label: 'Штука (шт)' }]) // Russian, not «pc. 1»
    })
  })
  it('propagates a REST error (route maps it to a status)', async () => {
    const call = vi.fn(async () => {
      throw new Error('ERROR_ACCESS_DENIED')
    })
    await expect(listMeasures(call)).rejects.toThrow('ERROR_ACCESS_DENIED')
  })
})

describe('fetchMeasureRows (auto-create index input — enriched so «шт»/«рулон» match a system measure)', () => {
  it('catalog.measure.list → enriched rows (system title/symbol filled); accepts {measures:[]}', async () => {
    const call = vi.fn(async () => ({ measures: [
      { code: 796, measureTitle: null, symbol: null, symbolIntl: 'pc. 1' },
      { code: 5003, measureTitle: 'Комплект', symbol: 'компл' }
    ] }))
    const rows = await fetchMeasureRows(call)
    expect(call).toHaveBeenCalledWith('catalog.measure.list', {})
    expect(rows[0]).toMatchObject({ code: 796, measureTitle: 'Штука', symbol: 'шт' }) // enriched
    expect(rows[1]).toMatchObject({ code: 5003, measureTitle: 'Комплект', symbol: 'компл' }) // custom, as-is
  })
  it('bare-array result works; garbage → []', async () => {
    expect(await fetchMeasureRows(vi.fn(async () => [{ code: 166 }]))).toEqual([{ code: 166, measureTitle: 'Килограмм', symbol: 'кг' }])
    expect(await fetchMeasureRows(vi.fn(async () => ({ nope: 1 })))).toEqual([])
    expect(await fetchMeasureRows(vi.fn(async () => null))).toEqual([])
  })
})

describe('SYSTEM_MEASURE_RU sanity', () => {
  it('covers the Bitrix defaults with live-verified symbols', () => {
    expect(SYSTEM_MEASURE_RU[796]).toEqual({ title: 'Штука', symbol: 'шт' })
    expect(SYSTEM_MEASURE_RU[166]).toEqual({ title: 'Килограмм', symbol: 'кг' })
    expect(SYSTEM_MEASURE_RU[6]).toEqual({ title: 'Метр', symbol: 'м' })
    expect(SYSTEM_MEASURE_RU[112]).toEqual({ title: 'Литр', symbol: 'л.' })
    expect(SYSTEM_MEASURE_RU[163]).toEqual({ title: 'Грамм', symbol: 'г' })
  })
})
