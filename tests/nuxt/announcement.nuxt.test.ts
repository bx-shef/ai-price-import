// @vitest-environment nuxt
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Announcement } from '~/utils/announcement'
import { announcementSeenKey } from '~/utils/announcement'

// #469. Решение «показывать или нет» живёт в браузере: отметку «видел» держит `localStorage`
// сотрудника, срок проверяется ПОВТОРНО здесь. Чистые тесты `announcement.ts` сюда не достают —
// мутации «ставить отметку только по кнопке», «не перепроверять срок» и «показывать повторно»
// проходили бы при зелёном CI, а стоят они ровно того, ради чего механизм заведён.

const NOW = Date.parse('2026-08-08T12:00:00Z')
const live = (over: Partial<Announcement> = {}): Announcement => ({
  id: 'a1',
  title: 'Акция',
  text: 'Скидка',
  publishedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 3 * 24 * 3600 * 1000).toISOString(),
  ...over
})

/** Свежий композабл с подменённым `$fetch` и портальной авторизацией. */
async function setup(announcement: Announcement | null, opts: { framed?: boolean } = {}) {
  vi.resetModules()
  vi.doMock('~/composables/useB24', () => ({
    useB24: () => ({ init: vi.fn(async () => {}), ensureAuth: vi.fn(async () => (opts.framed === false ? null : 'token')) })
  }))
  vi.doMock('~/utils/frameHeaders', () => ({
    buildFrameHeaders: (t: unknown) => (t ? { Authorization: 'Bearer t' } : null)
  }))
  const fetchMock = vi.fn(async () => ({ announcement }))
  vi.stubGlobal('$fetch', fetchMock)
  const { useAnnouncement } = await import('~/composables/useAnnouncement')
  return { api: useAnnouncement(), fetchMock }
}

describe('показ объявления (#469)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.setSystemTime(NOW)
  })

  it('действующее объявление открывается', async () => {
    const { api } = await setup(live())
    await api.check()
    expect(api.open.value).toBe(true)
    expect(api.announcement.value?.title).toBe('Акция')
  })

  it('уже закрытое НЕ открывается', async () => {
    localStorage.setItem(announcementSeenKey('a1'), '1')
    const { api } = await setup(live())
    await api.check()
    expect(api.open.value).toBe(false)
  })

  it('ЛЮБОЕ закрытие помечает как виденное — «закрыл, не читая» второй попытки не даёт', async () => {
    // Решение владельца. Ставить отметку только по кнопке значило бы, что случайно закрытое окно
    // вернётся завтра и послезавтра.
    const { api } = await setup(live())
    await api.check()
    api.dismiss()
    expect(api.open.value).toBe(false)
    expect(localStorage.getItem(announcementSeenKey('a1'))).toBe('1')
  })

  it('истёкшее не показывается, даже если сервер его отдал', async () => {
    // Вкладку рабочего экрана не перезагружают сутками: открытая до конца акции страница показала
    // бы окно уже после её окончания.
    const { api } = await setup(live({ expiresAt: new Date(NOW - 1000).toISOString() }))
    await api.check()
    expect(api.open.value).toBe(false)
  })

  it('вне портала запрос не делается вовсе', async () => {
    const { api, fetchMock } = await setup(live(), { framed: false })
    await api.check()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(api.open.value).toBe(false)
  })

  it('повторный `check` второго запроса не шлёт', async () => {
    const { api, fetchMock } = await setup(live())
    await api.check()
    await api.check()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('отказ сервера молчит — объявление это украшение', async () => {
    vi.resetModules()
    vi.doMock('~/composables/useB24', () => ({
      useB24: () => ({ init: vi.fn(async () => {}), ensureAuth: vi.fn(async () => 'token') })
    }))
    vi.doMock('~/utils/frameHeaders', () => ({ buildFrameHeaders: () => ({ Authorization: 'Bearer t' }) }))
    vi.stubGlobal('$fetch', vi.fn(async () => {
      throw new Error('502')
    }))
    const { useAnnouncement } = await import('~/composables/useAnnouncement')
    const api = useAnnouncement()
    await expect(api.check()).resolves.toBeUndefined()
    expect(api.open.value).toBe(false)
  })
})
