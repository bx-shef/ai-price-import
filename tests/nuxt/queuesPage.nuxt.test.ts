// @vitest-environment nuxt
import { describe, it, expect, beforeEach } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import QueuesPage from '~/pages/queues.vue'

// Оператор авторизован — проверяем сам экран, а не гейт входа.
mockNuxtImport('useAuth', () => () => ({
  authenticated: ref(true),
  check: async () => {},
  logout: async () => {}
}))

const QUEUES = [{ name: 'crm-sync', waiting: 5, active: 1, completed: 1000, failed: 3, delayed: 0 }]
const PORTALS = [{ memberId: 'm1', domain: 'a.bitrix24.by', ageDays: 1, expiresInDays: 100, health: 'ok' }]
const RATINGS = [{ memberId: 'm1', domain: 'a.bitrix24.by', state: 'prompted', promptedAtMs: 1, openedAtMs: null }]

let fail = { tokens: false, ratings: false }
let empty = false
const posted: string[] = []

// Перехватываем сетевой слой, а не глобальный $fetch: в Nuxt он резолвится через ofetch, и подмена
// globalThis до страницы не доходит.
registerEndpoint('/api/ops/queues', () => ({ queues: QUEUES }))
registerEndpoint('/api/ops/tokens', () => {
  if (fail.tokens) throw new Error('boom')
  return { portals: empty ? [] : PORTALS }
})
registerEndpoint('/api/ops/app-rating', (event) => {
  if (event.method === 'POST') {
    posted.push('app-rating')
    return { ok: true }
  }
  if (fail.ratings) throw new Error('boom')
  return { portals: empty ? [] : RATINGS }
})

beforeEach(() => {
  fail = { tokens: false, ratings: false }
  empty = false
  posted.length = 0
})

/** Ждём, пока страница реально дорисуется: запросы идут через сетевой слой, один тик не покрывает. */
const flush = async (w?: { text: () => string }, needle?: string) => {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10))
    if (!w || !needle || w.text().includes(needle)) return
  }
}

describe('Операторская консоль (#271)', () => {
  it('C: счётчики подписаны «в хранилище» — очередь считает сохранённые задачи, а не итог за всё время', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'готово (в хранилище)')
    expect(w.text()).toContain('готово (в хранилище)')
    expect(w.text()).toContain('ошибки (в хранилище)')
  })

  it('D: выдуманной полосы прогресса нет, вместо неё — оценка времени разбора', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'в очереди сейчас 6')
    expect(w.text()).toContain('в очереди сейчас 6')
    expect(w.html()).not.toContain('width:') // прежняя полоса рисовалась инлайн-стилем
  })

  it('E: блок с упавшим запросом показывает ошибку, а не исчезает молча', async () => {
    fail = { tokens: true, ratings: true }
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'Не удалось получить состояние порталов')
    expect(w.text()).toContain('Не удалось получить состояние порталов')
    expect(w.text()).toContain('Не удалось получить оценки приложения')
  })

  it('F: заголовки блоков видны и при пустых данных — оператор узнаёт, что раздел существует', async () => {
    empty = true
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'Приложение пока не установлено')
    expect(w.text()).toContain('Авторизация порталов')
    expect(w.text()).toContain('Оценки приложения')
    expect(w.text()).toContain('Приложение пока не установлено ни на один портал')
  })

  it('I: «Отзыв оставлен» требует подтверждения — состояние терминально, откат только через базу', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush()
    await flush(w, 'Отзыв оставлен')
    const btn = w.findAll('button').find(b => b.text() === 'Отзыв оставлен')!
    expect(btn).toBeTruthy()
    await btn.trigger('click')
    await flush(w, 'Отметить окончательно?')
    // Первый клик НЕ отправляет запрос, а спрашивает.
    expect(w.text()).toContain('Отметить окончательно?')
    expect(posted).toEqual([])
  })

  it('A: показывает время последнего обновления', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'обновлено в')
    expect(w.text()).toMatch(/обновлено в \d{2}:\d{2}:\d{2}/)
  })
})
