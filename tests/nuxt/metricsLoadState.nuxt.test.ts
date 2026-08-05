// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest'

// #408. Композаблы не были покрыты вовсе, и мутационная проверка нашла два выживших мутанта, каждый
// оставляет человека в тупике: «не выставлять `loaded` при отсутствии авторизации» (вечный
// скелетон ВНУТРИ портала, без данных и без объяснения) и «не чистить ошибку загрузки при успехе»
// (после одной сетевой неудачи экран навсегда остаётся в «Не удалось загрузить», и «Обновить»
// перестаёт лечить).

async function withAuth(auth: unknown, fetchImpl: unknown) {
  vi.resetModules()
  window.name = 'test-frame'
  vi.doMock('@bitrix24/b24jssdk', () => ({ initializeB24Frame: async () => ({ auth }) }))
  vi.stubGlobal('$fetch', fetchImpl)
  const { useMetrics } = await import('~/composables/useMetrics')
  return useMetrics()
}

const OK_AUTH = { getAuthData: () => ({ access_token: 't', domain: 'x.bitrix24.by' }), isAdmin: false }
const RESULT = { counters: {}, savings: { minutesSaved: 0 }, moneyBlocker: null }

describe('#408: состояние загрузки метрик', () => {
  it('нет фрейм-авторизации — попытка всё равно ЗАВЕРШИЛАСЬ и названа причина', async () => {
    // ⚠ Голый выход оставлял `loaded` ложным навсегда: сотрудник ВНУТРИ портала, чья авторизация
    // истекла и не обновилась, видел заглушку без данных, без объяснения и без реакции на
    // «Обновить» — повтор шёл тем же путём.
    const m = await withAuth({ getAuthData: () => false }, async () => RESULT)
    await m.load()
    expect(m.loaded.value).toBe(true)
    expect(m.loadError.value).not.toBe('')
  })

  it('успешная загрузка снимает прежнюю ошибку', async () => {
    // ⚠ Иначе «Обновить» переставала лечить: одна сетевая неудача — и экран навсегда в отказе.
    let fail = true
    const m = await withAuth(OK_AUTH, async () => {
      if (fail) throw new Error('сеть')
      return RESULT
    })
    await m.load()
    expect(m.loadError.value).not.toBe('')
    fail = false
    await m.load()
    expect(m.loadError.value).toBe('')
    expect(m.loaded.value).toBe(true)
  })

  it('отказ загрузки виден как ошибка, а не как вечная заглушка', async () => {
    const m = await withAuth(OK_AUTH, async () => {
      throw new Error('сеть')
    })
    await m.load()
    expect(m.loaded.value).toBe(true)
    expect(m.loadError.value).not.toBe('')
  })
})
