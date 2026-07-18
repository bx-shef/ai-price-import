import { describe, expect, it } from 'vitest'
import { isCreatableUnit, nextMeasureCode, buildMeasureAddParams, buildMeasureIndex, lookupExistingMeasure, normalizeUnitKey, MEASURE_CODE_FLOOR, MAX_MEASURE_UNIT_LEN } from '../app/utils/measureCreate'

describe('isCreatableUnit (OCR-noise gate)', () => {
  it('accepts sane unit strings (letters, optional digits/punctuation)', () => {
    for (const u of ['шт', 'кг', 'м²', 'пог.м', 'уп', 'дана', 'л/мин', 'kg']) {
      expect(isCreatableUnit(u)).toBe(true)
    }
  })
  it('trims before judging', () => {
    expect(isCreatableUnit('  шт  ')).toBe(true)
  })
  it('rejects empty / whitespace', () => {
    expect(isCreatableUnit('')).toBe(false)
    expect(isCreatableUnit('   ')).toBe(false)
    expect(isCreatableUnit(undefined)).toBe(false)
  })
  it('rejects letterless strings (pure digits / symbols)', () => {
    expect(isCreatableUnit('12')).toBe(false)
    expect(isCreatableUnit('%%')).toBe(false)
    expect(isCreatableUnit('---')).toBe(false)
  })
  it('rejects over-long blobs and hostile charsets', () => {
    expect(isCreatableUnit('a'.repeat(MAX_MEASURE_UNIT_LEN + 1))).toBe(false)
    expect(isCreatableUnit('шт<script>')).toBe(false)
    expect(isCreatableUnit('kg\nрм')).toBe(false)
  })
})

describe('nextMeasureCode', () => {
  it('returns floor when there are no existing codes', () => {
    expect(nextMeasureCode([])).toBe(MEASURE_CODE_FLOOR)
  })
  it('stays above the floor even when existing codes are all low (OKEI standard range)', () => {
    expect(nextMeasureCode([1, 6, 796])).toBe(MEASURE_CODE_FLOOR)
  })
  it('allocates max+1 when existing codes exceed the floor', () => {
    expect(nextMeasureCode([1000, 1005, 1002])).toBe(1006)
  })
  it('ignores non-integer noise', () => {
    expect(nextMeasureCode([Number.NaN, 1003, 2.5])).toBe(1004)
  })
})

describe('normalizeUnitKey', () => {
  it('trims, lowercases, collapses internal whitespace', () => {
    expect(normalizeUnitKey('  ШТ ')).toBe('шт')
    expect(normalizeUnitKey('пог.  м')).toBe('пог. м')
    expect(normalizeUnitKey(undefined)).toBe('')
  })
})

describe('buildMeasureIndex + lookupExistingMeasure (find-before-create)', () => {
  const rows = [
    { code: 796, measureTitle: 'Штука', symbol: 'шт' },
    { code: 6, measureTitle: 'Метр', symbol: 'м' },
    { code: 'bad' } // ignored — no valid code
  ]
  it('collects codes and maps normalized title AND symbol → code', () => {
    const idx = buildMeasureIndex(rows)
    expect(idx.codes.sort((a, b) => a - b)).toEqual([6, 796])
    expect(lookupExistingMeasure('шт', idx)).toBe(796) // by symbol
    expect(lookupExistingMeasure('  Штука ', idx)).toBe(796) // by title, normalized
    expect(lookupExistingMeasure('М', idx)).toBe(6)
  })
  it('returns null for a unit not present', () => {
    expect(lookupExistingMeasure('рулон', buildMeasureIndex(rows))).toBeNull()
  })
  it('tolerates uppercase field-name variants', () => {
    const idx = buildMeasureIndex([{ CODE: 200, MEASURE_TITLE: 'Пара', SYMBOL: 'пар' }])
    expect(lookupExistingMeasure('пар', idx)).toBe(200)
  })
})

describe('buildMeasureAddParams', () => {
  it('builds fields with code/title/symbol and isDefault N', () => {
    expect(buildMeasureAddParams('уп', 1001)).toEqual({
      fields: { code: 1001, measureTitle: 'уп', symbol: 'уп', isDefault: 'N' }
    })
  })
  it('trims and caps the label', () => {
    const p = buildMeasureAddParams(`  ${'ш'.repeat(30)}  `, 1002)
    expect((p.fields.measureTitle as string).length).toBe(MAX_MEASURE_UNIT_LEN)
    expect(p.fields.isDefault).toBe('N')
  })
})
