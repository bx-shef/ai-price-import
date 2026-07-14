import { describe, expect, it } from 'vitest'
import { createDemoJobStore } from '../server/utils/demoJobStore'
import type { DemoResult } from '../app/utils/demoExtract'

const RESULT = { docType: 'invoice', docTypeLabel: 'счёт', items: [], totals: {}, language: 'ru', warnings: [] } as unknown as DemoResult

function store(maxJobs = 100, ttlMs = 1000) {
  let n = 0
  return createDemoJobStore({ ttlMs, maxJobs, genId: () => `job${++n}` })
}

describe('createDemoJobStore', () => {
  it('creates a pending job and reads it back', () => {
    const s = store()
    const id = s.create(0)
    expect(id).toBe('job1')
    expect(s.get(id!, 0)).toEqual({ status: 'pending' })
    expect(s.size()).toBe(1)
  })

  it('completing a job returns the result', () => {
    const s = store()
    const id = s.create(0)!
    s.complete(id, RESULT, 10)
    expect(s.get(id, 10)).toEqual({ status: 'done', result: RESULT })
  })

  it('failing a job returns the error', () => {
    const s = store()
    const id = s.create(0)!
    s.fail(id, 'boom', 10)
    expect(s.get(id, 10)).toEqual({ status: 'error', error: 'boom' })
  })

  it('unknown id → null', () => {
    expect(store().get('nope', 0)).toBeNull()
  })

  it('expires a job after the TTL and sweeps it out', () => {
    const s = store(100, 1000)
    const id = s.create(0)!
    expect(s.get(id, 999)).toEqual({ status: 'pending' })
    expect(s.get(id, 1000)).toBeNull() // expiresAt reached
    s.sweep(1000)
    expect(s.size()).toBe(0)
  })

  it('completing refreshes the TTL so the client has time to fetch', () => {
    const s = store(100, 1000)
    const id = s.create(0)!
    s.complete(id, RESULT, 900) // new expiresAt = 900 + 1000
    expect(s.get(id, 1500)).toEqual({ status: 'done', result: RESULT }) // still alive past the original 1000
  })

  it('returns null when full, then frees room after expired jobs are swept', () => {
    const s = store(2, 1000)
    expect(s.create(0)).toBe('job1')
    expect(s.create(0)).toBe('job2')
    expect(s.create(0)).toBeNull() // full, nothing expired yet
    // Later, the first two have expired → create() sweeps and succeeds. genId is only
    // called on success (the failed create above did not burn an id), so this is job3.
    expect(s.create(1000)).toBe('job3')
  })

  it('complete/fail are no-ops on an unknown or expired id', () => {
    const s = store(100, 1000)
    s.complete('ghost', RESULT, 0) // must not throw
    const id = s.create(0)!
    s.fail(id, 'late', 2000) // id already expired (TTL 1000) → ignored
    expect(s.get(id, 2000)).toBeNull()
  })
})
