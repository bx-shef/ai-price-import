import { describe, expect, it, vi } from 'vitest'
import { buildCreateProductFields, createProductViaRest } from '../server/utils/productCreate'
import type { PortalMapping } from '../app/types/mapping'
import type { DocumentItem } from '../app/types/document'

const baseMapping = (over: Partial<PortalMapping['product']> = {}, field = '99'): PortalMapping => ({
  article: { field, kind: 'string', delimiter: ',' },
  product: { by: 'article', onMissing: 'create', ...over },
  units: { dictionary: {}, defaultCode: 1, autoCreate: false },
  saveFile: false
} as PortalMapping)

const item = (over: Partial<DocumentItem> = {}): DocumentItem => ({ name: 'Насос', price: 100, quantity: 1, ...over })

describe('buildCreateProductFields', () => {
  it('by:article + article → sets NAME and the supplier-article property', () => {
    expect(buildCreateProductFields(item({ article: 'ART-1' }), baseMapping())).toEqual({ NAME: 'Насос', PROPERTY_99: 'ART-1' })
  })
  it('by:name → NAME only (no article property even if the line has one)', () => {
    expect(buildCreateProductFields(item({ article: 'ART-1' }), baseMapping({ by: 'name' }))).toEqual({ NAME: 'Насос' })
  })
  it('by:article but no article on the line → NAME only', () => {
    expect(buildCreateProductFields(item(), baseMapping())).toEqual({ NAME: 'Насос' })
  })
  it('stores a delimiter-bearing article verbatim (known round-trip limit — documented)', () => {
    // A single article that contains the configured delimiter is stored as-is; findProduct
    // splits it on read, so such a product re-creates next import. Pathological but explicit.
    expect(buildCreateProductFields(item({ article: 'A,B' }), baseMapping())).toEqual({ NAME: 'Насос', PROPERTY_99: 'A,B' })
  })
  it('trims/falls back an empty name and normalises the property key (bare id → PROPERTY_<id>)', () => {
    expect(buildCreateProductFields(item({ name: '  ', article: 'X' }), baseMapping())).toMatchObject({ NAME: '(без наименования)', PROPERTY_99: 'X' })
    expect(buildCreateProductFields(item({ article: 'X' }), baseMapping({}, 'PROPERTY_99'))).toHaveProperty('PROPERTY_99', 'X')
  })
})

describe('createProductViaRest', () => {
  it('calls crm.product.add and returns the new id', async () => {
    const call = vi.fn().mockResolvedValue(537)
    const id = await createProductViaRest(item({ article: 'ART-1' }), baseMapping(), call)
    expect(id).toBe(537)
    expect(call).toHaveBeenCalledWith('crm.product.add', { fields: { NAME: 'Насос', PROPERTY_99: 'ART-1' } })
  })
  it('returns null (no REST call) when the item has no name → caller uses a freeform row', async () => {
    const call = vi.fn()
    expect(await createProductViaRest(item({ name: '' }), baseMapping(), call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })
  it('returns null on a non-id response', async () => {
    expect(await createProductViaRest(item(), baseMapping(), vi.fn().mockResolvedValue(0))).toBeNull()
    expect(await createProductViaRest(item(), baseMapping(), vi.fn().mockResolvedValue(undefined))).toBeNull()
  })
})
