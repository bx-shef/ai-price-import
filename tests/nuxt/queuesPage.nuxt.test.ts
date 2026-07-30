// @vitest-environment nuxt
import { describe, it, expect, beforeEach } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import { readBody } from 'h3'
import QueuesPage from '~/pages/queues.vue'

// Оператор авторизован — проверяем сам экран, а не гейт входа.
mockNuxtImport('useAuth', () => () => ({
  authenticated: ref(true),
  check: async () => {},
  logout: async () => {}
}))

const QUEUES = [{ name: 'crm-sync', waiting: 5, active: 1, completed: 1000, failed: 3, delayed: 0 }]
const PORTALS = [
  { memberId: 'm1', domain: 'a.bitrix24.by', ageDays: 1, expiresInDays: 100, health: 'ok' },
  { memberId: 'm2-dead', domain: 'zzz.bitrix24.ru', ageDays: 200, expiresInDays: 0, health: 'stale' }
]
const RATINGS = [{ memberId: 'm1', domain: 'a.bitrix24.by', state: 'prompted', promptedAtMs: 1, openedAtMs: null }]

let fail = { tokens: false, ratings: false }
let empty = false
const posted: string[] = []

// Перехватываем сетевой слой, а не глобальный $fetch: в Nuxt он резолвится через ofetch, и подмена
// globalThis до страницы не доходит.
let totalsMode: 'ok' | 'empty' | 'failed' = 'ok'
registerEndpoint('/api/ops/queues', () => ({
  queues: QUEUES,
  totals: totalsMode === 'ok' ? { docs: 12, created: 11, lines: 340, errors: 1 } : null,
  totalsFailed: totalsMode === 'failed'
}))
registerEndpoint('/api/ops/tokens', () => {
  if (fail.tokens) throw new Error('boom')
  return { portals: empty ? [] : PORTALS }
})
const FAILED = [
  { queue: 'crm-sync', id: '42', reason: 'портал отверг запись', failedAt: 1700000000000, attempts: 3 }
]
const failedActions: Array<{ action?: string, id?: string }> = []
let unavailable: string[] = []
registerEndpoint('/api/ops/failed', async (event) => {
  if (event.method === 'POST') {
    const body = await readBody(event)
    failedActions.push({ action: body?.action, id: body?.id })
    return { ok: true }
  }
  return { jobs: unavailable.length ? [] : FAILED, unavailable, perQueueLimit: 25 }
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
  failedActions.length = 0
  unavailable = []
  totalsMode = 'ok'
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

describe('Список упавших задач (#271-B)', () => {
  it('число ошибок больше не тупик: раскрывается список с причиной и временем', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'ошибки (в хранилище)')
    const trigger = w.findAll('button').find(b => b.text().includes('ошибки (в хранилище)'))!
    expect(trigger).toBeTruthy() // раньше это была неинтерактивная надпись
    await trigger.trigger('click')
    await flush(w, 'портал отверг запись')
    expect(w.text()).toContain('портал отверг запись')
    expect(w.text()).toContain('попыток: 3')
  })

  it('«Повторить» отправляет действие по этой задаче', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'ошибки (в хранилище)')
    await w.findAll('button').find(b => b.text().includes('ошибки (в хранилище)'))!.trigger('click')
    await flush(w, 'Повторить')
    await w.findAll('button').find(b => b.text() === 'Повторить')!.trigger('click')
    await flush(w, 'Задача снова в очереди')
    expect(failedActions).toEqual([{ action: 'retry', id: '42' }])
  })

  it('«Отбросить» спрашивает подтверждение — задача стирается насовсем', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'ошибки (в хранилище)')
    await w.findAll('button').find(b => b.text().includes('ошибки (в хранилище)'))!.trigger('click')
    await flush(w, 'Отбросить')
    await w.findAll('button').find(b => b.text() === 'Отбросить')!.trigger('click')
    await flush(w, 'Удалить насовсем?')
    // Первый клик ничего не отправляет.
    expect(failedActions).toEqual([])
    await w.findAll('button').find(b => b.text() === 'Да')!.trigger('click')
    await flush(w, 'Задача отброшена')
    expect(failedActions).toEqual([{ action: 'discard', id: '42' }])
    expect(w.text()).not.toContain('портал отверг запись')
  })

  it('показывает, что список усечён — иначе оператор решит, что остальные ошибки исчезли', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'ошибки (в хранилище)')
    await w.findAll('button').find(b => b.text().includes('ошибки (в хранилище)'))!.trigger('click')
    await flush(w, 'Показаны первые')
    // На карточке 3 ошибки, в списке 1 → строка про усечение обязана быть.
    expect(w.text()).toContain('Показаны первые 1 из 3')
  })

  it('очередь не ответила — говорим об этом, а не объясняем пустоту сроком хранения', async () => {
    unavailable = ['crm-sync']
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'ошибки (в хранилище)')
    await w.findAll('button').find(b => b.text().includes('ошибки (в хранилище)'))!.trigger('click')
    await flush(w, 'очередь не ответила')
    expect(w.text()).toContain('Это не значит, что ошибок нет')
  })
})

// #271-C/J/K — то, что оператор видит: объём обработки, отбор порталов, копирование member_id.
describe('консоль: объём обработки и список порталов', () => {
  it('объём подписан отдельно от счётчиков очереди и не притворяется вечным', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'По всем установленным порталам')
    expect(w.text()).toContain('12 документов')
    expect(w.text()).toContain('создано в CRM: 11')
    expect(w.text()).toContain('с ошибкой: 1')
    // Ровно та подпись, ради которой пункт заводился: числа очереди — не итог.
    expect(w.text()).toContain('только то, что ещё хранится в очереди')
    // И честность про уменьшение при удалении портала.
    expect(w.text()).toContain('счётчики портала стираются')
  })

  it('база недоступна — так и говорим, а не показываем пустоту', async () => {
    totalsMode = 'failed'
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'база недоступна')
    expect(w.text()).toContain('не удалось прочитать')
  })

  it('нечего показывать — строки объёма нет вовсе', async () => {
    totalsMode = 'empty'
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'Авторизация порталов')
    expect(w.text()).not.toContain('По всем установленным порталам')
  })

  it('member_id виден в строке портала — по нему идут все действия', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'a.bitrix24.by')
    expect(w.text()).toContain('m2-dead')
  })

  it('«с проблемой» прячет здоровые порталы', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'a.bitrix24.by')
    await w.findAll('button').find(b => b.text().startsWith('С проблемой'))!.trigger('click')
    await flush()
    expect(w.text()).toContain('zzz.bitrix24.ru')
    // Сверяемся по member_id: домен здорового портала есть и в блоке оценок ниже, а `m1` печатает
    // только список авторизации — значит его исчезновение и означает, что строка отфильтрована.
    expect(w.text()).toContain('m2-dead')
    expect(w.text()).not.toContain('m1')
    expect(w.text()).toContain('показано 1 из 2')
  })

  it('из пустой выборки есть выход — «Показать все»', async () => {
    const w = await mountSuspended(QueuesPage)
    await flush(w, 'a.bitrix24.by')
    await w.find('input[type="search"]').setValue('такого домена нет')
    await flush(w, 'Ничего не найдено')
    await w.findAll('button').find(b => b.text() === 'Показать все')!.trigger('click')
    await flush(w, 'a.bitrix24.by')
    expect(w.text()).toContain('a.bitrix24.by')
  })
})
