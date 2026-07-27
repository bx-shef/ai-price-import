import { describe, expect, it, vi } from 'vitest'
import { CRM_MODE_SIMPLE, fetchCrmMode, leadsEnabled } from '../server/utils/crmMode'

describe('crmMode', () => {
  it('fetchCrmMode unwraps the bare integer result', async () => {
    expect(await fetchCrmMode(vi.fn(async () => 1))).toBe(1)
    expect(await fetchCrmMode(vi.fn(async () => 2))).toBe(2)
    expect(await fetchCrmMode(vi.fn(async () => '2'))).toBe(2) // numeric string coerced
  })
  it('fetchCrmMode → null on a non-integer / failed read (fail-open upstream)', async () => {
    expect(await fetchCrmMode(vi.fn(async () => 'x'))).toBeNull()
    expect(await fetchCrmMode(vi.fn(() => Promise.reject(new Error('boom'))))).toBeNull()
  })
  it('leadsEnabled: only the explicit simple mode disables leads; unknown → true', () => {
    expect(leadsEnabled(1)).toBe(true) // classic
    expect(leadsEnabled(CRM_MODE_SIMPLE)).toBe(false) // simple (no leads)
    expect(leadsEnabled(null)).toBe(true) // unknown → fail-open
  })
})
