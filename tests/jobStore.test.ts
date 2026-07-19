import { afterEach, describe, expect, it, vi } from 'vitest'
import { claimJobNotify, createJob, getDiskFileUrl, getJob, getManualOverride, listJobs, setDiskFile, setJobStatus } from '../server/utils/jobStore'
import { createMemoryJobRedis } from '../server/utils/jobStoreRedis'

afterEach(() => vi.restoreAllMocks())

// The store logic is exercised over the in-memory JobRedis (same interface as the live ioredis
// adapter) — no infra, deterministic. A controllable clock drives TTL expiry.

describe('jobStore (Redis-backed)', () => {
  it('createJob → getJob round-trips status/fileName; result starts empty', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'накладная.pdf', r)
    expect(await getJob('m', 'j1', r)).toEqual({ memberId: 'm', jobId: 'j1', status: 'queued', fileName: 'накладная.pdf', result: '' })
  })

  it('getJob is member+job scoped (no cross-portal read)', async () => {
    const r = createMemoryJobRedis()
    await createJob('m1', 'j1', 'f.pdf', r)
    expect(await getJob('m2', 'j1', r)).toBeNull()
    expect(await getJob('m1', 'jX', r)).toBeNull()
  })

  it('setJobStatus updates status + result without dropping fileName', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r)
    await setJobStatus('m', 'j1', 'done', JSON.stringify({ created: true }), r)
    const j = await getJob('m', 'j1', r)
    expect(j?.status).toBe('done')
    expect(j?.result).toBe('{"created":true}')
    expect(j?.fileName).toBe('f.pdf')
  })

  it('manual override round-trips + re-validates (junk → undefined)', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r, { entityTypeId: 2, categoryId: 1 })
    expect(await getManualOverride('m', 'j1', r)).toEqual({ entityTypeId: 2, categoryId: 1 })
    await createJob('m', 'j2', 'f.pdf', r) // no override
    expect(await getManualOverride('m', 'j2', r)).toBeUndefined()
  })

  it('disk file: setDiskFile then getDiskFileUrl normalizes an absolute DETAIL_URL to a relative path', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r)
    await setDiskFile('m', 'j1', { id: 5, detailUrl: 'https://bel.bitrix24.by/docs/file/5/' }, r)
    expect(await getDiskFileUrl('m', 'j1', r)).toBe('/docs/file/5/')
    // absent → null
    await createJob('m', 'j2', 'f.pdf', r)
    expect(await getDiskFileUrl('m', 'j2', r)).toBeNull()
  })

  it('claimJobNotify is once-only: first caller true, all later false', async () => {
    const r = createMemoryJobRedis()
    await createJob('m', 'j1', 'f.pdf', r)
    expect(await claimJobNotify('m', 'j1', r)).toBe(true)
    expect(await claimJobNotify('m', 'j1', r)).toBe(false)
    expect(await claimJobNotify('m', 'j1', r)).toBe(false)
  })

  it('listJobs returns the portal jobs newest-first', async () => {
    // createJob scores the index entry by Date.now() — drive it so the three creates get distinct,
    // increasing scores (as real uploads seconds apart would).
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 10))
    const r = createMemoryJobRedis(() => now)
    await createJob('m', 'old', 'a.pdf', r)
    await createJob('m', 'mid', 'b.pdf', r)
    await createJob('m', 'new', 'c.pdf', r)
    const ids = (await listJobs('m', r)).map(j => j.jobId)
    expect(ids).toEqual(['new', 'mid', 'old'])
  })

  it('listJobs skips jobs whose hash already expired (index entry outlived it)', async () => {
    let t = 0
    const r = createMemoryJobRedis(() => t)
    await createJob('m', 'j1', 'a.pdf', r)
    // Advance past the job TTL so the hash evicts; the index entry may linger but is filtered out.
    t += 49 * 60 * 60 * 1000
    expect(await listJobs('m', r)).toEqual([])
    expect(await getJob('m', 'j1', r)).toBeNull()
  })
})
