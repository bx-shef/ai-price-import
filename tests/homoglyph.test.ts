import { describe, expect, it } from 'vitest'
import { foldHomoglyphs, homoglyphEqual } from '../app/utils/homoglyph'

describe('foldHomoglyphs', () => {
  it('maps Russian Cyrillic look-alikes to Latin (discriminating)', () => {
    // рост (Cyrillic р,о,с,т) → р→p, о→o, с→c, т NOT folded → 'poct'
    expect(foldHomoglyphs('рос')).toBe('poc')
    // Cyrillic "РОС" vs Latin "POC" collide after folding
    expect(homoglyphEqual('РОС', 'POC')).toBe(true)
    // but two genuinely different strings do not
    expect(homoglyphEqual('РОС', 'POK')).toBe(false)
  })

  it('lower-cases', () => {
    expect(foldHomoglyphs('ABC')).toBe('abc')
  })

  it('preserves ALL Kazakh-distinctive letters, incl. і and һ', () => {
    expect(foldHomoglyphs('і')).toBe('і') // NOT latin i
    expect(foldHomoglyphs('һ')).toBe('һ') // NOT latin h
    expect(foldHomoglyphs('қ')).not.toBe('k') // must not collapse қ→k
    expect(foldHomoglyphs('өнім')).toBe('өнім') // fully preserved
  })

  it('does not fold borderline lower-case pairs (к/м/т/н/в)', () => {
    expect(foldHomoglyphs('кмтнв')).toBe('кмтнв')
  })
})
