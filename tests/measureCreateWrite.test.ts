import { describe, expect, it, vi } from 'vitest'
import { createMeasureViaRest } from '../server/utils/measureCreateWrite'

describe('createMeasureViaRest', () => {
  it('creates a measure and returns the allocated code', async () => {
    const call = vi.fn(async () => ({ measure: { code: 1001 } }))
    const code = await createMeasureViaRest('уп', [1000], call)
    expect(code).toBe(1001)
    expect(call).toHaveBeenCalledWith('catalog.measure.add', {
      fields: { code: 1001, measureTitle: 'уп', symbol: 'уп', isDefault: 'N' }
    })
  })

  it('returns null (no REST) for a non-creatable unit', async () => {
    const call = vi.fn()
    expect(await createMeasureViaRest('12', [], call)).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it('retries with the next code on a duplicate-code error (SDK .code shape), then succeeds', async () => {
    let n = 0
    const call = vi.fn(async (_method: string, params: { fields: { code: number } }) => {
      n++
      // The live SDK throws an AjaxError carrying the numeric code on `.code`.
      if (n === 1) throw Object.assign(new Error('Duplicate entry for key [code]'), { code: '200600000000' })
      return { measure: { code: params.fields.code } } // portal echoes the sent code
    })
    const code = await createMeasureViaRest('кг', [1000], call)
    // first code for [1000] is 1001; collision → bumped to 1002 on the retry
    expect(code).toBe(1002)
    expect(call).toHaveBeenCalledTimes(2)
    expect((call.mock.calls[0]![1] as { fields: { code: number } }).fields.code).toBe(1001)
    expect((call.mock.calls[1]![1] as { fields: { code: number } }).fields.code).toBe(1002)
  })

  it('detects a duplicate by the description text alone (no code field)', async () => {
    let n = 0
    const call = vi.fn(async (_method: string, params: { fields: { code: number } }) => {
      n++
      if (n === 1) throw new Error('Duplicate entry for key [code]')
      return { measure: { code: params.fields.code } }
    })
    expect(await createMeasureViaRest('кг', [1000], call)).toBe(1002)
  })

  it('gives up (null) after repeated duplicate collisions', async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error('dup'), { code: '200600000000' })
    })
    expect(await createMeasureViaRest('кг', [1000], call)).toBeNull()
    expect(call).toHaveBeenCalledTimes(5)
  })

  it('returns null (best-effort) on any other error', async () => {
    const call = vi.fn(async () => {
      throw new Error('Access Denied')
    })
    expect(await createMeasureViaRest('кг', [1000], call)).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('falls back to the allocated code when the response omits measure.code', async () => {
    const call = vi.fn(async () => ({}))
    expect(await createMeasureViaRest('уп', [1000], call)).toBe(1001)
  })
})
