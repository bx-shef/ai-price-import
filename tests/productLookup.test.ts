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

describe('findProductByArticle', () => {
  it('normalises a bare code to PROPERTY_<code> and filters by it', async () => {
    const call = vi.fn(async () => [{ ID: '7' }])
    expect(await findProductByArticle('A-100', '130', call)).toBe(7)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { PROPERTY_130: 'A-100' }, select: ['ID'] })
  })
  it('keeps an already-prefixed PROPERTY_ key', async () => {
    const call = vi.fn(async () => [{ ID: '7' }])
    await findProductByArticle('A-100', 'PROPERTY_ARTNUMBER', call)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { PROPERTY_ARTNUMBER: 'A-100' }, select: ['ID'] })
  })
  it('null on empty article or empty field', async () => {
    const call = vi.fn(async () => [{ ID: '1' }])
    expect(await findProductByArticle('', '130', call)).toBeNull()
    expect(await findProductByArticle('A', '  ', call)).toBeNull()
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
    expect(call).toHaveBeenNthCalledWith(1, 'crm.product.list', { filter: { PROPERTY_130: 'A-1' }, select: ['ID'] })
    expect(call).toHaveBeenNthCalledWith(2, 'crm.product.list', { filter: { NAME: 'Гвоздь' }, select: ['ID'] })
  })
  it('by:\'article\' with a matching property returns it WITHOUT a NAME fallback call', async () => {
    const m = defaultMapping()
    m.product.by = 'article'
    m.article.field = '130'
    const call = vi.fn(async () => [{ ID: '12' }])
    expect(await findProduct(item({ article: 'A-1' }), m, call)).toBe(12)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('crm.product.list', { filter: { PROPERTY_130: 'A-1' }, select: ['ID'] })
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
