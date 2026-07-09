import { describe, expect, it, vi } from 'vitest'
import { findProduct, findProductByArticle, findProductByName } from '../server/utils/productLookup'
import { defaultMapping } from '../app/utils/portalSettings'
import type { DocumentItem } from '../app/types/document'

const item = (over: Partial<DocumentItem> = {}): DocumentItem => ({ name: 'Гвоздь', price: 1, quantity: 1, ...over })

describe('findProductByName', () => {
  it('filters by NAME and returns the smallest positive id', async () => {
    const call = vi.fn(async () => [{ ID: '31' }, { ID: '29' }])
    expect(await findProductByName('Гвоздь', call)).toBe(29)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { NAME: 'Гвоздь' }, select: ['ID'] })
  })
  it('null on empty name or no rows', async () => {
    const call = vi.fn(async () => [])
    expect(await findProductByName('   ', call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
    expect(await findProductByName('x', vi.fn(async () => undefined))).toBeNull()
  })
  it('filters out non-finite / non-positive ids (minId guard)', async () => {
    const call = vi.fn(async () => [{ ID: 'abc' }, { ID: '-1' }, { ID: '0' }, { ID: '7' }])
    expect(await findProductByName('x', call)).toBe(7)
    const allBad = vi.fn(async () => [{ ID: 'abc' }, { ID: '-1' }])
    expect(await findProductByName('x', allBad)).toBeNull()
  })
})

const artCfg = (over: Partial<ReturnType<typeof defaultMapping>['article']> = {}) => ({ ...defaultMapping().article, field: '130', kind: 'text' as const, ...over })

describe('findProductByArticle (%LIKE narrows → exact membership; live-verified)', () => {
  it('text variant: %LIKE query (ordered), membership by newline split', async () => {
    const call = vi.fn(async () => [{ ID: '7', PROPERTY_130: { value: 'A-100\nA-200' } }])
    expect(await findProductByArticle('A-100', artCfg(), call)).toBe(7)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { '%PROPERTY_130': 'A-100' }, select: ['ID', 'PROPERTY_130'], order: { ID: 'ASC' } })
  })
  it('rejects a LIKE false positive (A-10 is NOT an exact member of {A-100, A-200})', async () => {
    const call = vi.fn(async () => [{ ID: '7', PROPERTY_130: { value: 'A-100\nA-200' } }])
    expect(await findProductByArticle('A-10', artCfg(), call)).toBeNull()
  })
  it('string variant: splits by the configured delimiter; accepts a plain-string value', async () => {
    const call = vi.fn(async () => [{ ID: '9', PROPERTY_130: 'BV-12;EXTRA-7' }])
    expect(await findProductByArticle('EXTRA-7', artCfg({ kind: 'string', delimiter: ';' }), call)).toBe(9)
  })
  it('string variant defaults to comma when no delimiter configured', async () => {
    const call = vi.fn(async () => [{ ID: '9', PROPERTY_130: 'BV-12,EXTRA-7' }])
    expect(await findProductByArticle('EXTRA-7', artCfg({ kind: 'string', delimiter: undefined }), call)).toBe(9)
  })
  it('selects the correct product among MIXED candidates (some pass, some fail membership)', async () => {
    const call = vi.fn(async () => [
      { ID: '5', PROPERTY_130: 'A-100\nA-200' }, // substring hit, NOT exact member of 'A-1'
      { ID: '8', PROPERTY_130: 'A-1\nZ-9' }, //     exact member
      { ID: '3', PROPERTY_130: 'A-15' } //         substring hit, not exact
    ])
    expect(await findProductByArticle('A-1', artCfg(), call)).toBe(8)
  })
  it('homoglyph-tolerant membership among returned rows (Cyrillic С ↔ Latin C)', async () => {
    // LIKE already returned the row (bytes agree here); the fold confirms the match.
    const call = vi.fn(async () => [{ ID: '4', PROPERTY_130: 'СTP-5\nX-2' }]) // Cyrillic С
    expect(await findProductByArticle('CTP-5', artCfg(), call)).toBe(4) // Latin C
  })
  it('multiple-value property (array / index-object) is flattened', async () => {
    const arr = vi.fn(async () => [{ ID: '6', PROPERTY_130: ['A-100', 'A-200'] }])
    expect(await findProductByArticle('A-200', artCfg(), arr)).toBe(6)
    const idx = vi.fn(async () => [{ ID: '6', PROPERTY_130: { 0: { value: 'A-100' }, 1: { value: 'A-200' } } }])
    expect(await findProductByArticle('A-200', artCfg(), idx)).toBe(6)
  })
  it('null/missing property value → no match (propValue null branch)', async () => {
    const call = vi.fn(async () => [{ ID: '7', PROPERTY_130: null }])
    expect(await findProductByArticle('A-100', artCfg(), call)).toBeNull()
  })
  it('symbolic (non-numeric) field is REJECTED → no REST call (live: %LIKE on code returns all)', async () => {
    const call = vi.fn(async () => [{ ID: '1' }])
    expect(await findProductByArticle('A-100', artCfg({ field: 'ARTNUMBER' }), call)).toBeNull()
    expect(await findProductByArticle('A-100', artCfg({ field: 'PROPERTY_ART' }), call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('null on empty article or empty field', async () => {
    const call = vi.fn(async () => [])
    expect(await findProductByArticle('', artCfg(), call)).toBeNull()
    expect(await findProductByArticle('A', artCfg({ field: '  ' }), call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
})

describe('findProduct (strategy routing)', () => {
  it('by:\'name\' always uses NAME (ignores article)', async () => {
    const m = defaultMapping()
    m.product.by = 'name'
    const call = vi.fn(async () => [{ ID: '5' }])
    await findProduct(item({ article: 'A-1' }), m, call)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { NAME: 'Гвоздь' }, select: ['ID'] })
  })
  it('by:\'article\' tries the article property first, then falls back to NAME', async () => {
    const m = defaultMapping()
    m.product.by = 'article'
    m.article.field = '130'
    const call = vi.fn()
      .mockResolvedValueOnce([]) // article miss
      .mockResolvedValueOnce([{ ID: '9' }]) // name hit
    expect(await findProduct(item({ article: 'A-1' }), m, call)).toBe(9)
    expect(call).toHaveBeenNthCalledWith(1, 'crm.product.list', { filter: { '%PROPERTY_130': 'A-1' }, select: ['ID', 'PROPERTY_130'], order: { ID: 'ASC' } })
    expect(call).toHaveBeenNthCalledWith(2, 'crm.product.list', { filter: { NAME: 'Гвоздь' }, select: ['ID'] })
  })
  it('by:\'article\' with a matching property returns it WITHOUT a NAME fallback call', async () => {
    const m = defaultMapping()
    m.product.by = 'article'
    m.article.field = '130'
    const call = vi.fn(async () => [{ ID: '12', PROPERTY_130: 'A-1' }])
    expect(await findProduct(item({ article: 'A-1' }), m, call)).toBe(12)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { '%PROPERTY_130': 'A-1' }, select: ['ID', 'PROPERTY_130'], order: { ID: 'ASC' } })
  })

  it('by:\'article\' with property-miss AND name-miss → null', async () => {
    const m = defaultMapping()
    m.product.by = 'article'
    m.article.field = '130'
    const call = vi.fn(async () => [])
    expect(await findProduct(item({ article: 'A-1' }), m, call)).toBeNull()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('by:\'article\' with no article printed goes straight to NAME', async () => {
    const m = defaultMapping()
    m.product.by = 'article'
    m.article.field = '130'
    const call = vi.fn(async () => [{ ID: '4' }])
    expect(await findProduct(item(), m, call)).toBe(4)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { NAME: 'Гвоздь' }, select: ['ID'] })
  })
})
