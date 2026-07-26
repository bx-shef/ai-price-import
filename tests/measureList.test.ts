import { describe, expect, it, vi } from 'vitest'
import { normalizeMeasures, listMeasures } from '../server/utils/measureList'

describe('normalizeMeasures', () => {
  it('maps rows to { value: code-string, label: title (symbol) } from a flat array', () => {
    const out = normalizeMeasures([
      { code: 6, measureTitle: 'Метр', symbol: 'м' },
      { code: 796, measureTitle: 'Штука', symbol: 'шт' }
    ])
    // Sorted by label (ru): «Метр (м)» < «Штука (шт)»
    expect(out).toEqual([
      { value: '6', label: 'Метр (м)' },
      { value: '796', label: 'Штука (шт)' }
    ])
  })
  it('accepts the { measures: [...] } wrapper shape too', () => {
    const out = normalizeMeasures({ measures: [{ code: 116, measureTitle: 'Килограмм', symbol: 'кг' }] })
    expect(out).toEqual([{ value: '116', label: 'Килограмм (кг)' }])
  })
  it('falls back to symbolIntl, then to «код N» when no name/symbol', () => {
    expect(normalizeMeasures([{ code: 6, symbolIntl: 'MTR' }])).toEqual([{ value: '6', label: 'MTR' }])
    expect(normalizeMeasures([{ code: 9 }])).toEqual([{ value: '9', label: 'код 9' }])
  })
  it('prefers the RUSSIAN symbol over the international one (owner ask: «шт», not «pc.»)', () => {
    // Uppercase B24 field forms with both symbols present → the label shows SYMBOL_RUS.
    expect(normalizeMeasures([{ CODE: 796, MEASURE_TITLE: 'Штука', SYMBOL_RUS: 'шт', SYMBOL_INTL: 'pc.' }]))
      .toEqual([{ value: '796', label: 'Штука (шт)' }])
    // camelCase, only the intl symbol present → falls back to it.
    expect(normalizeMeasures([{ code: 796, measureTitle: 'Штука', symbolIntl: 'pc.' }]))
      .toEqual([{ value: '796', label: 'Штука (pc.)' }])
  })
  it('drops rows with a bad code, dedups by code, skips null/primitive elements', () => {
    const out = normalizeMeasures([
      { code: 0, measureTitle: 'Ноль' },
      { code: -1, measureTitle: 'Минус' },
      null,
      'x',
      { code: 796, measureTitle: 'Штука' },
      { code: 796, measureTitle: 'Дубль' }
    ])
    expect(out).toEqual([{ value: '796', label: 'Штука' }])
  })
  it('returns [] for a non-array / non-{measures} result', () => {
    expect(normalizeMeasures(null)).toEqual([])
    expect(normalizeMeasures({ items: [] })).toEqual([])
  })
})

describe('listMeasures', () => {
  it('calls crm.measure.list (classic — Russian MEASURE_TITLE/SYMBOL_RUS) and normalizes', async () => {
    // Classic shape: uppercase fields with the Russian symbol (what real portals actually return).
    const call = vi.fn(async () => [{ CODE: '796', MEASURE_TITLE: 'Штука', SYMBOL_RUS: 'шт', SYMBOL_INTL: 'pc. 1' }])
    const out = await listMeasures(call)
    expect(call).toHaveBeenCalledWith('crm.measure.list', {})
    expect(out).toEqual([{ value: '796', label: 'Штука (шт)' }]) // Russian, not «pc. 1»
  })
  it('propagates a REST error (route maps it to a status)', async () => {
    const call = vi.fn(async () => {
      throw new Error('ERROR_ACCESS_DENIED')
    })
    await expect(listMeasures(call)).rejects.toThrow('ERROR_ACCESS_DENIED')
  })
})
