import { describe, expect, it } from 'vitest'
import { MAX_QUEUE_CONCURRENCY, concurrencyFromEnv, queueConcurrency } from '../server/queue/worker'

describe('queueConcurrency (env-overridable worker concurrency, GH #95)', () => {
  it('defaults to 4/2/4 when env is empty', () => {
    expect(queueConcurrency({})).toEqual({ extract: 4, agent: 2, crm: 4 })
  })
  it('applies valid positive-int overrides', () => {
    expect(queueConcurrency({
      QUEUE_EXTRACT_CONCURRENCY: '1', QUEUE_AGENT_CONCURRENCY: '1', QUEUE_CRM_CONCURRENCY: '2'
    })).toEqual({ extract: 1, agent: 1, crm: 2 })
  })
  it('ignores invalid values (0, negative, non-int, junk) → default', () => {
    expect(concurrencyFromEnv({ K: '0' }, 'K', 4)).toBe(4)
    expect(concurrencyFromEnv({ K: '-2' }, 'K', 4)).toBe(4)
    expect(concurrencyFromEnv({ K: '2.5' }, 'K', 4)).toBe(4)
    expect(concurrencyFromEnv({ K: 'abc' }, 'K', 4)).toBe(4)
    expect(concurrencyFromEnv({}, 'K', 4)).toBe(4)
    expect(concurrencyFromEnv({ K: '3' }, 'K', 4)).toBe(3)
  })
  it('clamps an absurd override to MAX_QUEUE_CONCURRENCY (typo guard)', () => {
    expect(concurrencyFromEnv({ K: '999999' }, 'K', 4)).toBe(MAX_QUEUE_CONCURRENCY)
    expect(concurrencyFromEnv({ K: String(MAX_QUEUE_CONCURRENCY + 1) }, 'K', 4)).toBe(MAX_QUEUE_CONCURRENCY)
    expect(concurrencyFromEnv({ K: String(MAX_QUEUE_CONCURRENCY) }, 'K', 4)).toBe(MAX_QUEUE_CONCURRENCY)
  })
})
