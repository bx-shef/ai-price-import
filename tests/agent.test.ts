import { describe, expect, it } from 'vitest'
import { extractJson } from '../server/agent/extractJson'

describe('extractJson', () => {
  it('extracts the last balanced JSON object', () => {
    expect(extractJson('noise before {"a":1,"b":{"c":2}} trailing')).toEqual({ a: 1, b: { c: 2 } })
  })
  it('handles braces inside strings', () => {
    expect(extractJson('log {"name":"a}b{c","ok":true}')).toEqual({ name: 'a}b{c', ok: true })
  })
  it('handles escaped quotes (odd + even counts)', () => {
    expect(extractJson('{"v":"5\\" pipe"}')).toEqual({ v: '5" pipe' })
    expect(extractJson('log {"name":"ООО \\"Ромашка\\"","taxId":"190"}')).toEqual({ name: 'ООО "Ромашка"', taxId: '190' })
    expect(extractJson('{"note":"ends with quote\\""}')).toEqual({ note: 'ends with quote"' })
  })
  it('selects the last complete top-level object', () => {
    expect(extractJson('{"a":1} noise {"b":2}')).toEqual({ b: 2 })
  })
  it('null on no/invalid json / oversize', () => {
    expect(extractJson('no json here')).toBeNull()
    expect(extractJson('{broken')).toBeNull()
    expect(extractJson('')).toBeNull()
    expect(extractJson('{"a":1}'.padEnd(2_000_001, ' '))).toBeNull()
  })
})
