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
  it('calls catalog.measure.list (active filter + code/title/symbol select) and normalizes', async () => {
    const call = vi.fn(async () => [{ code: 796, measureTitle: 'Штука', symbol: 'шт' }])
    const out = await listMeasures(call)
    expect(call).toHaveBeenCalledWith('catalog.measure.list', {
      select: ['code', 'measureTitle', 'symbol', 'symbolIntl', 'isDefault'],
      filter: { active: 'Y' }
    })
    expect(out).toEqual([{ value: '796', label: 'Штука (шт)' }])
  })
  it('propagates a REST error (route maps it to a status)', async () => {
    const call = vi.fn(async () => {
      throw new Error('ERROR_ACCESS_DENIED')
    })
    await expect(listMeasures(call)).rejects.toThrow('ERROR_ACCESS_DENIED')
  })
})
