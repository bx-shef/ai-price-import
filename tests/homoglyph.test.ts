import { describe, expect, it } from 'vitest'
import { foldHomoglyphs, homoglyphEqual } from '../app/utils/homoglyph'

describe('foldHomoglyphs', () => {
  it('maps cross-script look-alikes to a canonical form', () => {
    // Cyrillic "аеорсх" vs Latin "aeopcx"
    expect(foldHomoglyphs('А2О20')).toBe(foldHomoglyphs('A2O20'))
    expect(homoglyphEqual('243Э20', '243Э20')).toBe(true)
  })

  it('lower-cases', () => {
    expect(foldHomoglyphs('ABC')).toBe('abc')
  })

  it('preserves Kazakh-specific letters (no Latin twin)', () => {
    // қ ө ғ ң ұ ү ә must survive folding, not collapse to к о г н у у а
    expect(foldHomoglyphs('қаза')).toContain('қ')
    expect(foldHomoglyphs('өнім')).toContain('ө')
    expect(foldHomoglyphs('ғ')).toBe('ғ')
  })

  it('folds Cyrillic і → latin i (has a twin)', () => {
    expect(foldHomoglyphs('і')).toBe('i')
  })
})
