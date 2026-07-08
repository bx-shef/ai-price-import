import { describe, expect, it, vi } from 'vitest'
import { createTargetTool, findSupplierTool, MCP_TOOL_NAMES } from '../mcp/tools'

describe('findSupplierTool', () => {
  it('returns companyId via lookup', async () => {
    const call = vi.fn().mockResolvedValue([{ ENTITY_ID: '42' }])
    expect(await findSupplierTool({ taxId: '190000000' }, call)).toEqual({ companyId: 42 })
  })
  it('validates input', async () => {
    // @ts-expect-error intentionally invalid input for validation test
    await expect(findSupplierTool({}, vi.fn())).rejects.toThrow(/taxId required/)
  })
})

describe('createTargetTool', () => {
  it('creates entity + rows', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ item: { id: 7 } })
      .mockResolvedValueOnce({ productRows: [] })
    const r = await createTargetTool({ target: { entityTypeId: 2 }, fields: { title: 't' }, rows: [{ price: 1 }] }, call)
    expect(r).toEqual({ entityId: 7 })
    expect(call).toHaveBeenCalledWith('crm.item.add', expect.objectContaining({ entityTypeId: 2 }))
    expect(call).toHaveBeenLastCalledWith('crm.item.productrow.set', expect.objectContaining({ ownerType: 'D', ownerId: 7 }))
  })
  it('skips rows when none', async () => {
    const call = vi.fn().mockResolvedValue({ item: { id: 9 } })
    await createTargetTool({ target: { entityTypeId: 2 }, fields: {} }, call)
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('validates target', async () => {
    // @ts-expect-error intentionally invalid input for validation test
    await expect(createTargetTool({ fields: {} }, vi.fn())).rejects.toThrow(/entityTypeId required/)
  })
})

describe('tool allowlist', () => {
  it('exposes the three abstract tools', () => {
    expect(MCP_TOOL_NAMES).toEqual(['find_supplier', 'find_product', 'create_target'])
  })
})
