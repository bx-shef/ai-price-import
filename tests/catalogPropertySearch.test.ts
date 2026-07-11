import { describe, expect, it } from 'vitest'
import {
  resolveMainIblockId,
  normalizeProperties,
  filterProperties,
  searchCatalogProperties
} from '../server/utils/catalogPropertySearch'
import type { RestCall } from '../server/utils/b24Rest'

// Shapes as a real RestCall (makeRestCall) delivers them: it UNWRAPS the B24 envelope
// (returns `json.result`), so the core sees `{ catalogs }` / `{ productProperties }`
// directly — NOT `{ result: { … } }`. (An earlier draft double-unwrapped `.result`;
// tests returning the raw wire shape hid that the picker was always empty in prod.)
//   catalog.catalog.list → { catalogs: [ { iblockId, productIblockId, name } ] }
//   catalog.productProperty.list → { productProperties: [ { id, code, name, propertyType } ] }
const CATALOGS = {
  catalogs: [
    { iblockId: 25, productIblockId: null, name: 'CRM Product Catalog' },
    { iblockId: 27, productIblockId: 25, name: 'CRM Product Catalog (offers)' }
  ]
}
const PROPERTIES = {
  productProperties: [
    { id: 93, code: 'MORE_PHOTO', name: 'Image', propertyType: 'F' },
    { id: 99, code: 'SUPPLIER_ARTICLE', name: 'Артикул поставщика', propertyType: 'S' },
    { id: 100, code: '', name: 'Безымянное', propertyType: 'S' } // no code → PROPERTY_100
  ]
}

/** Fake RestCall dispatching by method. */
function fakeCall(overrides: Partial<Record<string, unknown>> = {}): RestCall {
  return (method) => {
    if (method === 'catalog.catalog.list') return Promise.resolve(overrides['catalog.catalog.list'] ?? CATALOGS)
    if (method === 'catalog.productProperty.list') return Promise.resolve(overrides['catalog.productProperty.list'] ?? PROPERTIES)
    return Promise.resolve({})
  }
}

describe('resolveMainIblockId', () => {
  it('picks the catalog whose productIblockId is null (main, not offers)', async () => {
    expect(await resolveMainIblockId(fakeCall())).toBe(25)
  })
  it('falls back to the first catalog when none has a null parent', async () => {
    const call = fakeCall({ 'catalog.catalog.list': { catalogs: [{ iblockId: 40, productIblockId: 5 }] } })
    expect(await resolveMainIblockId(call)).toBe(40)
  })
  it('returns null when there are no catalogs', async () => {
    const call = fakeCall({ 'catalog.catalog.list': { catalogs: [] } })
    expect(await resolveMainIblockId(call)).toBeNull()
  })
})

describe('normalizeProperties', () => {
  it('maps to { value: code, label: name }, PROPERTY_<id> when no code', () => {
    const opts = normalizeProperties(PROPERTIES)
    expect(opts).toEqual([
      { value: 'MORE_PHOTO', label: 'Image', code: 'MORE_PHOTO', id: 93 },
      { value: 'SUPPLIER_ARTICLE', label: 'Артикул поставщика', code: 'SUPPLIER_ARTICLE', id: 99 },
      { value: 'PROPERTY_100', label: 'Безымянное', code: undefined, id: 100 }
    ])
  })
  it('drops a property with neither code nor a positive id', () => {
    const opts = normalizeProperties({ productProperties: [{ id: 0, code: '', name: 'X' }] })
    expect(opts).toEqual([])
  })
  it('returns [] for a malformed response', () => {
    expect(normalizeProperties(null)).toEqual([])
    expect(normalizeProperties({})).toEqual([])
  })
})

describe('filterProperties', () => {
  const opts = normalizeProperties(PROPERTIES)
  it('empty query → all', () => {
    expect(filterProperties(opts, '')).toHaveLength(3)
  })
  it('matches on label (case-insensitive Cyrillic)', () => {
    expect(filterProperties(opts, 'артикул').map(o => o.value)).toEqual(['SUPPLIER_ARTICLE'])
  })
  it('matches on value/code', () => {
    expect(filterProperties(opts, 'more_photo').map(o => o.label)).toEqual(['Image'])
  })
})

describe('searchCatalogProperties', () => {
  it('resolves the main catalog, lists its properties, filters by query', async () => {
    const page = await searchCatalogProperties(fakeCall(), 'артикул')
    expect(page).toEqual({ items: [{ value: 'SUPPLIER_ARTICLE', label: 'Артикул поставщика', code: 'SUPPLIER_ARTICLE', id: 99 }], hasMore: false })
  })
  it('empty query returns the full property list', async () => {
    const page = await searchCatalogProperties(fakeCall(), '')
    expect(page.items).toHaveLength(3)
    expect(page.hasMore).toBe(false)
  })
  it('no catalog → empty page (never throws)', async () => {
    const call = fakeCall({ 'catalog.catalog.list': { catalogs: [] } })
    expect(await searchCatalogProperties(call, '')).toEqual({ items: [], hasMore: false })
  })
})
