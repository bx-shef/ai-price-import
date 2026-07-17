import { describe, expect, it } from 'vitest'
import { dictionaryToRows, rowsToDictionary, hasDuplicateUnits } from '../app/utils/unitsDictionary'

describe('dictionaryToRows', () => {
  it('builds rows sorted by unit', () => {
    expect(dictionaryToRows({ шт: 796, м: 6, кг: 116 })).toEqual([
      { unit: 'кг', code: 116 },
      { unit: 'м', code: 6 },
      { unit: 'шт', code: 796 }
    ])
  })
  it('drops empty keys, non-finite, and finite-but-invalid codes (0/negative/non-integer)', () => {
    // Aligned with rowsToDictionary: a measure code must be a positive integer, so a stored
    // 6.5 / -6 / 0 (only reachable via out-of-band app.option editing) never becomes a phantom row.
    expect(dictionaryToRows({
      '': 6,
      'a': Number.NaN as unknown as number,
      'b': 6.5,
      'c': -6,
      'd': 0,
      'кг': 116
    })).toEqual([{ unit: 'кг', code: 116 }])
  })
  it('returns [] for null/undefined/non-object', () => {
    expect(dictionaryToRows(null)).toEqual([])
    expect(dictionaryToRows(undefined)).toEqual([])
  })
})

describe('rowsToDictionary', () => {
  it('lowercases + trims keys and keeps positive integer codes', () => {
    expect(rowsToDictionary([
      { unit: '  М  ', code: 6 },
      { unit: 'КГ', code: 116 }
    ])).toEqual({ м: 6, кг: 116 })
  })
  it('drops rows with an empty unit or a bad code (null/zero/negative/non-integer)', () => {
    expect(rowsToDictionary([
      { unit: '', code: 6 },
      { unit: 'a', code: null },
      { unit: 'b', code: 0 },
      { unit: 'c', code: -1 },
      { unit: 'd', code: 1.5 },
      { unit: 'e', code: 796 }
    ])).toEqual({ e: 796 })
  })
  it('dedups by normalized key (last non-empty wins)', () => {
    expect(rowsToDictionary([
      { unit: 'м', code: 6 },
      { unit: ' М ', code: 999 }
    ])).toEqual({ м: 999 })
  })
  it('round-trips with dictionaryToRows (editor output survives the parse convention)', () => {
    const dict = { м: 6, кг: 116, шт: 796 }
    expect(rowsToDictionary(dictionaryToRows(dict))).toEqual(dict)
  })
})

describe('hasDuplicateUnits', () => {
  it('is true when a unit key repeats case/space-insensitively', () => {
    expect(hasDuplicateUnits([{ unit: 'м', code: 6 }, { unit: ' М ', code: 7 }])).toBe(true)
  })
  it('is false for distinct or empty keys', () => {
    expect(hasDuplicateUnits([{ unit: 'м', code: 6 }, { unit: 'кг', code: 116 }])).toBe(false)
    expect(hasDuplicateUnits([{ unit: '', code: 6 }, { unit: '', code: 7 }])).toBe(false)
  })
})
