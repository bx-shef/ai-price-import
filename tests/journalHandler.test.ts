import { describe, it, expect, vi } from 'vitest'
import { journalRequest, type JournalDeps } from '../server/utils/journalHandler'
import { JOURNAL_PAGE_SIZE } from '../server/utils/importJournal'

const activity = (id: number) => ({
  ID: String(id), SUBJECT: `Импорт ${id}`, COMPLETED: 'Y', CREATED: '2026-08-08T10:00:00+03:00',
  ORIGIN_ID: `job-${id}`, OWNER_TYPE_ID: '4', OWNER_ID: '55'
})

const deps = (over: Partial<JournalDeps> = {}): JournalDeps => ({
  authorize: vi.fn(async () => ({ ok: true, memberId: 'm1', userId: '17' })),
  resolveCall: vi.fn(async () => vi.fn(async () => [activity(1)])),
  originatorCode: 'SH_APP_IMPORT_PRICE_AI',
  ...over
})

describe('#458: роут журнала — отказы', () => {
  it('токен отвергнут → тот статус, что назвала проверка, а не выдуманный', () => {
    // Подмена `auth.status ?? 401` на голый 401 стирала бы разницу между «токен не годится» и
    // «мы не смогли проверить», а это разные советы человеку.
    return Promise.all([
      journalRequest(0, deps({ authorize: async () => ({ ok: false, status: 401, reason: 'token-rejected' }) })),
      journalRequest(0, deps({ authorize: async () => ({ ok: false, status: 502, reason: 'transport' }) }))
    ]).then(([rejected, transport]) => {
      expect(rejected.status).toBe(401)
      expect(rejected.outcome).toBe('auth_failed')
      expect(transport.status).toBe(502)
      expect(transport.outcome).toBe('upstream_error')
    })
  })

  it('портал не сообщил, КТО спрашивает → 403, а НЕ журнал без сужения', async () => {
    // Несущая проверка приватности. Инверсия этого условия отдала бы сотруднику дела всего
    // портала, и по виду экрана это неотличимо — список просто длиннее.
    const call = vi.fn()
    const r = await journalRequest(0, deps({
      authorize: async () => ({ ok: true, memberId: 'm1' }),
      resolveCall: async () => call
    }))
    expect(r.status).toBe(403)
    expect(r.outcome).toBe('forbidden')
    expect(call, 'портал вообще не должен был опрашиваться').not.toHaveBeenCalled()
  })

  it('приложение не установлено (нет токена портала) → 409', async () => {
    const r = await journalRequest(0, deps({ resolveCall: async () => null }))
    expect(r.status).toBe(409)
    expect(r.outcome).toBe('conflict')
  })

  it('портал не ответил → 502, а НЕ пустой журнал', async () => {
    // «Импортов не было» и «мы не смогли посмотреть» противоположны по смыслу, а выглядят
    // одинаково — пустым списком (#408).
    const r = await journalRequest(0, deps({
      resolveCall: async () => vi.fn(async () => {
        throw new Error('rest down')
      })
    }))
    expect(r.status).toBe(502)
    expect(r.body).toEqual({ error: 'journal unavailable' })
  })

  it('транспорт не собрался → тоже 502, а не падение роута', async () => {
    const r = await journalRequest(0, deps({
      resolveCall: async () => {
        throw new Error('no db')
      }
    }))
    expect(r.status).toBe(502)
  })
})

describe('#458: роут журнала — выдача', () => {
  it('фильтр уходит с сотрудником и с нашим маркером', async () => {
    const call = vi.fn(async () => [activity(1)])
    await journalRequest(0, deps({ resolveCall: async () => call }))
    const [method, params] = call.mock.calls[0] as unknown as [string, { filter: Record<string, string> }]
    expect(method).toBe('crm.activity.list')
    expect(params.filter).toEqual({ ORIGINATOR_ID: 'SH_APP_IMPORT_PRICE_AI', RESPONSIBLE_ID: '17' })
  })

  it('смещение из запроса доезжает до портала, мусорное — обнуляется', async () => {
    const call = vi.fn(async () => [])
    await journalRequest('40', deps({ resolveCall: async () => call }))
    expect((call.mock.calls[0] as unknown as [string, { start: number }])[1].start).toBe(40)
    const call2 = vi.fn(async () => [])
    await journalRequest('«сорок»', deps({ resolveCall: async () => call2 }))
    expect((call2.mock.calls[0] as unknown as [string, { start: number }])[1].start).toBe(0)
  })

  it('полная страница означает «есть ещё», неполная — конец списка', async () => {
    // Граница строгая: замена `>=` на `>` теряла бы последнюю страницу целиком.
    const full = Array.from({ length: JOURNAL_PAGE_SIZE }, (_, i) => activity(i + 1))
    const r1 = await journalRequest(0, deps({ resolveCall: async () => vi.fn(async () => full) }))
    expect((r1.body as { hasMore: boolean }).hasMore).toBe(true)
    const r2 = await journalRequest(0, deps({ resolveCall: async () => vi.fn(async () => full.slice(1)) }))
    expect((r2.body as { hasMore: boolean }).hasMore).toBe(false)
  })

  it('ответ портала объектом с `items` читается так же, как массив', async () => {
    // Иначе журнал молча пустой — неотличимо от «импортов не было».
    const r = await journalRequest(0, deps({ resolveCall: async () => vi.fn(async () => ({ items: [activity(1)] })) }))
    expect((r.body as { rows: unknown[] }).rows).toHaveLength(1)
  })
})
