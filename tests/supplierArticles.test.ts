import { describe, expect, it } from 'vitest'
import { articleMatches, parseSupplierArticles } from '../app/utils/supplierArticles'

describe('parseSupplierArticles', () => {
  it('text kind: one article per line', () => {
    const v = 'A-100\nB-200\n\n  C-300  '
    expect(parseSupplierArticles(v, { field: 'PROP', kind: 'text' })).toEqual(['A-100', 'B-200', 'C-300'])
  })

  it('string kind: splits by admin delimiter', () => {
    const v = 'A-100; B-200 ;C-300'
    expect(parseSupplierArticles(v, { field: 'PROP', kind: 'string', delimiter: ';' })).toEqual(['A-100', 'B-200', 'C-300'])
  })

  it('string kind: defaults delimiter to comma', () => {
    expect(parseSupplierArticles('a,b', { field: 'P', kind: 'string' })).toEqual(['a', 'b'])
  })

  it('dedupes by homoglyph-folded form', () => {
    // Cyrillic А vs Latin A → same article
    const v = 'А-1\nA-1'
    expect(parseSupplierArticles(v, { field: 'P', kind: 'text' })).toHaveLength(1)
  })

  it('empty value → empty', () => {
    expect(parseSupplierArticles('', { field: 'P', kind: 'text' })).toEqual([])
  })
})

describe('articleMatches', () => {
  it('matches homoglyph-tolerant', () => {
    expect(articleMatches('А-1', ['x', 'A-1'])).toBe(true)
    expect(articleMatches('Z', ['A', 'B'])).toBe(false)
  })
})
