import { describe, expect, it, vi } from 'vitest'
import { readMapping, SETTINGS_KEY, writeMapping } from '../server/utils/appSettings'

describe('readMapping', () => {
  it('parses stored JSON string and normalises', async () => {
    const call = vi.fn().mockResolvedValue(JSON.stringify({ defaultTarget: { entityTypeId: 31 }, saveFile: false }))
    const m = await readMapping(call)
    expect(call).toHaveBeenCalledWith('app.option.get', { option: SETTINGS_KEY })
    expect(m.defaultTarget).toEqual({ entityTypeId: 31 })
    expect(m.saveFile).toBe(false)
  })
  it('handles object result and junk → safe defaults', async () => {
    expect((await readMapping(vi.fn().mockResolvedValue({ saveFile: false }))).saveFile).toBe(false)
    expect((await readMapping(vi.fn().mockResolvedValue('not json'))).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
  it('unset option ("" / null) → defaults (first-run path)', async () => {
    expect((await readMapping(vi.fn().mockResolvedValue(''))).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
    expect((await readMapping(vi.fn().mockResolvedValue(null))).defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
  })
})

describe('writeMapping', () => {
  it('normalises before persisting (never stores junk)', async () => {
    const call = vi.fn().mockResolvedValue(true)
    const out = await writeMapping(call, { defaultTarget: { entityTypeId: -1 }, routingRules: [{ match: {}, target: { entityTypeId: 5 } }] })
    // bad default → 2; empty-condition rule dropped
    expect(out.defaultTarget).toEqual({ entityTypeId: 2, categoryId: 0 })
    expect(out.routingRules).toEqual([])
    const [method, params] = call.mock.calls[0]!
    expect(method).toBe('app.option.set')
    expect(JSON.parse((params as { options: Record<string, string> }).options[SETTINGS_KEY]!).defaultTarget.entityTypeId).toBe(2)
  })
})
