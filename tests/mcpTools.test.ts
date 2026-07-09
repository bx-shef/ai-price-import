import { describe, expect, it, vi } from 'vitest'
import * as tools from '../mcp/tools'
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
  it('rejects non-positive entityTypeId (0 / negative are never valid owners)', async () => {
    await expect(createTargetTool({ target: { entityTypeId: 0 }, fields: {} }, vi.fn())).rejects.toThrow(/entityTypeId required/)
    await expect(createTargetTool({ target: { entityTypeId: -1 }, fields: {} }, vi.fn())).rejects.toThrow(/entityTypeId required/)
  })
})

const snake = (s: string) => s.replace(/Tool$/, '').replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => (c as string).toUpperCase())

describe('tool allowlist', () => {
  it('advertises exactly the implemented tools', () => {
    expect(MCP_TOOL_NAMES).toEqual(['find_supplier', 'create_target'])
  })
  it('every advertised name has a matching exported *Tool fn (no phantom tools)', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(typeof (tools as Record<string, unknown>)[`${camel(name)}Tool`]).toBe('function')
    }
  })
  it('every exported *Tool fn is advertised (no orphan/unlisted tools)', () => {
    const impl = Object.keys(tools).filter(k => k.endsWith('Tool') && typeof (tools as Record<string, unknown>)[k] === 'function')
    for (const k of impl) expect(MCP_TOOL_NAMES).toContain(snake(k))
  })
})
