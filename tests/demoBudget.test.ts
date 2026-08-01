import { describe, expect, it, vi } from 'vitest'
import { BUDGET_TTL_SEC, createDemoBudget, demoBudgetKey, demoDailyLimit, type BudgetStore } from '../server/utils/demoBudget'

describe('demoDailyLimit', () => {
  it('дефолт 200; мусор/пусто/ноль/отрицательное → дефолт', () => {
    expect(demoDailyLimit({})).toBe(200)
    expect(demoDailyLimit({ DEMO_DAILY_LIMIT: '' })).toBe(200)
    expect(demoDailyLimit({ DEMO_DAILY_LIMIT: 'abc' })).toBe(200)
    expect(demoDailyLimit({ DEMO_DAILY_LIMIT: '0' })).toBe(200)
    expect(demoDailyLimit({ DEMO_DAILY_LIMIT: '-5' })).toBe(200)
  })
  it('env-значение с клампом [1, 100000] и округлением вниз', () => {
    expect(demoDailyLimit({ DEMO_DAILY_LIMIT: '50' })).toBe(50)
    expect(demoDailyLimit({ DEMO_DAILY_LIMIT: '2.9' })).toBe(2)
    expect(demoDailyLimit({ DEMO_DAILY_LIMIT: '999999999' })).toBe(100_000)
  })
})

describe('demoBudgetKey', () => {
  it('ключ — UTC-день; смена дня меняет ключ', () => {
    expect(demoBudgetKey(Date.UTC(2026, 7, 1, 12))).toBe('demo:budget:2026-08-01')
    expect(demoBudgetKey(Date.UTC(2026, 7, 1, 23, 59))).toBe('demo:budget:2026-08-01')
    expect(demoBudgetKey(Date.UTC(2026, 7, 2, 0, 1))).toBe('demo:budget:2026-08-02')
  })
})

function fakeStore(): BudgetStore & { counts: Map<string, number>, ttls: Map<string, number>, down: boolean } {
  const counts = new Map<string, number>()
  const ttls = new Map<string, number>()
  return {
    counts,
    ttls,
    down: false,
    async incrWithTtl(key, ttlSec) {
      if (this.down) return null
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      if (n === 1) ttls.set(key, ttlSec)
      return n
    }
  }
}

describe('createDemoBudget', () => {
  it('пускает до лимита включительно, дальше отказывает; счётчик и лимит в решении', async () => {
    const store = fakeStore()
    const b = createDemoBudget(store, { limit: 2, now: () => Date.UTC(2026, 7, 1) })
    expect(await b.consume()).toMatchObject({ allowed: true, used: 1, limit: 2, degraded: false })
    expect(await b.consume()).toMatchObject({ allowed: true, used: 2 })
    expect(await b.consume()).toMatchObject({ allowed: false, used: 3 })
  })
  it('TTL ставится на первом тике дня (48ч — переживает поздний старт дня)', async () => {
    const store = fakeStore()
    const b = createDemoBudget(store, { limit: 5, now: () => Date.UTC(2026, 7, 1) })
    await b.consume()
    expect(store.ttls.get('demo:budget:2026-08-01')).toBe(BUDGET_TTL_SEC)
    expect(BUDGET_TTL_SEC).toBe(48 * 3600)
  })
  it('новый UTC-день — новый ключ, бюджет заново', async () => {
    const store = fakeStore()
    let day = 1
    const b = createDemoBudget(store, { limit: 1, now: () => Date.UTC(2026, 7, day) })
    expect((await b.consume()).allowed).toBe(true)
    expect((await b.consume()).allowed).toBe(false)
    day = 2
    expect((await b.consume()).allowed).toBe(true)
  })
  it('Redis упал (null) → in-memory фолбэк, degraded=true, warning ровно один раз', async () => {
    const store = fakeStore()
    store.down = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = createDemoBudget(store, { limit: 2, now: () => Date.UTC(2026, 7, 1) })
    expect(await b.consume()).toMatchObject({ allowed: true, used: 1, degraded: true })
    expect(await b.consume()).toMatchObject({ allowed: true, used: 2, degraded: true })
    expect(await b.consume()).toMatchObject({ allowed: false, used: 3, degraded: true })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  it('без стора вовсе (нет REDIS_URL) — сразу in-memory фолбэк', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = createDemoBudget(null, { limit: 1, now: () => Date.UTC(2026, 7, 1) })
    expect(await b.consume()).toMatchObject({ allowed: true, degraded: true })
    expect(await b.consume()).toMatchObject({ allowed: false, degraded: true })
    warn.mockRestore()
  })
  it('in-memory фолбэк тоже перекатывается на новый день', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let day = 1
    const b = createDemoBudget(null, { limit: 1, now: () => Date.UTC(2026, 7, day) })
    expect((await b.consume()).allowed).toBe(true)
    expect((await b.consume()).allowed).toBe(false)
    day = 2
    expect((await b.consume()).allowed).toBe(true)
    warn.mockRestore()
  })
})
