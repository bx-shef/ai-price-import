import { describe, expect, it } from 'vitest'
import { shouldAutosave } from '../app/utils/autosave'

describe('shouldAutosave (settings echo-guard predicate)', () => {
  it('arms only when ready AND the content changed', () => {
    expect(shouldAutosave('{"a":1}', '{"a":0}', true)).toBe(true)
  })
  it('does not arm before the first load (ready=false), even on a change', () => {
    expect(shouldAutosave('{"a":1}', '{"a":0}', false)).toBe(false)
  })
  it('suppresses the reseed echo — identical content does not arm', () => {
    const json = '{"a":1,"b":2}'
    expect(shouldAutosave(json, json, true)).toBe(false)
  })
  it('treats a differing key ORDER as a change (one corrective save, not a loop)', () => {
    // JSON.stringify preserves insertion order; if the server returns a different order the guard
    // sees a difference and arms one more save that converges — documented behaviour, not a loop.
    expect(shouldAutosave('{"a":1,"b":2}', '{"b":2,"a":1}', true)).toBe(true)
  })
})
