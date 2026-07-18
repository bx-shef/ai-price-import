import { describe, expect, it } from 'vitest'
import {
  CRM_LOCK_DURATION_MS,
  MAX_QUEUE_CONCURRENCY,
  concurrencyFromEnv,
  crmLockTuning,
  queueConcurrency
} from '../server/queue/worker'

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

describe('crmLockTuning (stalled-reprocessing dup guard, GH #163)', () => {
  it('raises the crm lock above the BullMQ default (30s) to keep a live worker from false-stalling', () => {
    const t = crmLockTuning()
    expect(t.lockDuration).toBe(CRM_LOCK_DURATION_MS)
    expect(t.lockDuration).toBeGreaterThan(30_000) // > BullMQ default → renewal window widened
  })
  it('keeps stalledInterval >= lockDuration (the stall scan must not outrun the lock lifetime)', () => {
    const t = crmLockTuning()
    expect(t.stalledInterval).toBeGreaterThanOrEqual(t.lockDuration)
  })
  it('bounds a genuinely crashed job to a single recovery redelivery', () => {
    expect(crmLockTuning().maxStalledCount).toBe(1)
  })
})
