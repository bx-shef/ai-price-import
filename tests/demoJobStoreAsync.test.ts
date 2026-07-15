import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDemoJobStore,
  toAsyncDemoJobStore,
  createRedisDemoJobStore,
  serializeJobState,
  parseJobState,
  type RedisLike
} from '../server/utils/demoJobStore'
import { buildDemoJobStore } from '../server/utils/demoJobs'
import type { DemoResult } from '../app/utils/demoExtract'

const RESULT = { docType: 'invoice', docTypeLabel: 'счёт', items: [], totals: {}, language: 'ru', warnings: [] } as unknown as DemoResult

// ── pure serialize/parse ────────────────────────────────────────────────────
describe('serializeJobState / parseJobState', () => {
  it('round-trips each state', () => {
    for (const s of [{ status: 'pending' }, { status: 'done', result: RESULT }, { status: 'error', error: 'boom' }] as const) {
      expect(parseJobState(serializeJobState(s))).toEqual(s)
    }
  })

  it('null / empty / corrupt → null (treated as gone)', () => {
    expect(parseJobState(null)).toBeNull()
    expect(parseJobState(undefined)).toBeNull()
    expect(parseJobState('')).toBeNull()
    expect(parseJobState('not json')).toBeNull()
    expect(parseJobState('{"status":"bogus"}')).toBeNull()
    expect(parseJobState('{}')).toBeNull()
  })
})

// ── backend selection (buildDemoJobStore) ────────────────────────────────────
// Note: connectionOptions() memoizes process.env.REDIS_URL at module load; unit tests run
// with REDIS_URL unset, so both branches below resolve to the in-memory backend. The Redis
// branch itself is covered by createRedisDemoJobStore above.
describe('buildDemoJobStore selection', () => {
  afterEach(() => vi.restoreAllMocks())

  it('defaults to a working in-memory store when DEMO_JOBSTORE is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = buildDemoJobStore({})
    const id = await s.create(0)
    expect(id).toBeTruthy()
    expect(await s.get(id!, 0)).toEqual({ status: 'pending' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns and falls back to in-memory when DEMO_JOBSTORE=redis but REDIS_URL is unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = buildDemoJobStore({ DEMO_JOBSTORE: ' Redis ' }) // trimmed + case-insensitive
    const id = await s.create(0)
    expect(id).toBeTruthy() // memory store still works
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('REDIS_URL is unset')
  })
})

// ── in-memory async wrapper keeps identity semantics ─────────────────────────
describe('toAsyncDemoJobStore', () => {
  it('mirrors the sync store over the async interface', async () => {
    let n = 0
    const s = toAsyncDemoJobStore(createDemoJobStore({ ttlMs: 1000, maxJobs: 100, genId: () => `job${++n}` }))
    const id = await s.create(0)
    expect(id).toBe('job1')
    expect(await s.get(id!, 0)).toEqual({ status: 'pending' })
    await s.complete(id!, RESULT, 10)
    expect(await s.get(id!, 10)).toEqual({ status: 'done', result: RESULT })
    await s.sweep(10)
  })

  it('propagates create() null when full', async () => {
    let n = 0
    const s = toAsyncDemoJobStore(createDemoJobStore({ ttlMs: 1000, maxJobs: 1, genId: () => `job${++n}` }))
    expect(await s.create(0)).toBe('job1')
    expect(await s.create(0)).toBeNull()
  })
})

// ── Redis backend over a fake RedisLike ──────────────────────────────────────
/** In-memory fake honouring PX/XX semantics (no expiry simulation needed for these tests). */
function fakeRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async setPx(key, value) { store.set(key, value) },
    async setPxIfExists(key, value) {
      if (!store.has(key)) return false
      store.set(key, value)
      return true
    },
    async get(key) { return store.get(key) ?? null }
  }
}

describe('createRedisDemoJobStore', () => {
  function store(redis = fakeRedis()) {
    let n = 0
    return {
      redis,
      s: createRedisDemoJobStore(redis, { ttlMs: 1000, keyPrefix: 'demo:job:', genId: () => `job${++n}` })
    }
  }

  it('creates a pending job under a namespaced key and reads it back', async () => {
    const { s, redis } = store()
    const id = await s.create(0)
    expect(id).toBe('job1')
    expect(redis.store.has('demo:job:job1')).toBe(true)
    expect(await s.get('job1', 0)).toEqual({ status: 'pending' })
  })

  it('complete / fail update an existing job', async () => {
    const { s } = store()
    const id = await s.create(0)
    await s.complete(id!, RESULT, 10)
    expect(await s.get(id!, 10)).toEqual({ status: 'done', result: RESULT })
    await s.fail(id!, 'late', 20)
    expect(await s.get(id!, 20)).toEqual({ status: 'error', error: 'late' })
  })

  it('complete / fail are no-ops on an unknown/expired id (XX only-if-exists)', async () => {
    const { s, redis } = store()
    await s.complete('ghost', RESULT, 0)
    await s.fail('ghost', 'boom', 0)
    expect(redis.store.has('demo:job:ghost')).toBe(false)
    expect(await s.get('ghost', 0)).toBeNull()
  })

  it('get on unknown id → null', async () => {
    const { s } = store()
    expect(await s.get('nope', 0)).toBeNull()
  })

  it('sweep is a no-op (native TTL)', async () => {
    const { s, redis } = store()
    await s.create(0)
    await s.sweep(999999)
    expect(redis.store.size).toBe(1)
  })
})
