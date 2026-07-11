import { describe, expect, it } from 'vitest'
import { decodeText, ext, MAX_DEMO_BYTES, validateDemoFile } from '../server/utils/demoUpload'

describe('ext', () => {
  it('lower-cases the extension, ignores path, handles dotfiles/no-ext', () => {
    expect(ext('Счёт.TXT')).toBe('txt')
    expect(ext('a/b/c.CSV')).toBe('csv')
    expect(ext('noext')).toBe('')
    expect(ext('.gitignore')).toBe('') // leading dot only → no extension
  })
})

describe('validateDemoFile', () => {
  it('accepts txt/csv/tsv + xlsx within the size cap', () => {
    expect(validateDemoFile('doc.txt', 100)).toEqual({ ok: true })
    expect(validateDemoFile('data.csv', 100).ok).toBe(true)
    expect(validateDemoFile('price.xlsx', 100).ok).toBe(true) // Excel now supported
  })
  it('rejects empty (400), oversized (413), wrong ext (415)', () => {
    expect(validateDemoFile('doc.txt', 0)).toMatchObject({ ok: false, status: 400 })
    expect(validateDemoFile('doc.txt', MAX_DEMO_BYTES + 1)).toMatchObject({ ok: false, status: 413 })
    expect(validateDemoFile('doc.pdf', 100)).toMatchObject({ ok: false, status: 415 }) // PDF still full-version only
    expect(validateDemoFile('scan.jpg', 100)).toMatchObject({ ok: false, status: 415 })
  })
})

describe('decodeText', () => {
  it('decodes UTF-8', () => {
    const bytes = new TextEncoder().encode('Поставщик: ООО Тест')
    expect(decodeText(bytes)).toContain('Поставщик')
  })
  it('falls back to Windows-1251 for non-UTF-8 bytes', () => {
    // «Тест» in Windows-1251 (0xD2 0xE5 0xF1 0xF2) is invalid UTF-8 → CP1251 path.
    const cp1251 = new Uint8Array([0xD2, 0xE5, 0xF1, 0xF2])
    expect(decodeText(cp1251)).toBe('Тест')
  })
})
