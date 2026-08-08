// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest'

// #443. Композабл не был покрыт НИЧЕМ, и мутационная проверка это доказала: можно было снять
// объявление отказа из обоих `catch`, оставить состояние вечным `'idle'`, не выставлять `'live'`
// после запуска — весь набор оставался зелёным. И это ровно тот класс дефекта, который задача
// чинит: неработающий канал живого обновления был неотличим от работающего, потому что обе стороны
// глушили ошибки пустым `catch`. Экран импорта просто никогда не обновлялся после сохранения
// настроек, и узнать об этом было неоткуда.

/** Поднимает свежий модуль с подставленным фреймом портала и pull-клиентом. */
async function withPortal(opts: { framed?: boolean, callThrows?: boolean, startThrows?: boolean } = {}) {
  vi.resetModules()
  // Композабл считает себя «во фрейме» по непустому `window.name` — так портал помечает окно.
  window.name = opts.framed === false ? '' : 'test-frame'
  const call = vi.fn(async () => {
    if (opts.callThrows) throw new Error('pull off')
    return { isSuccess: true }
  })
  vi.doMock('@bitrix24/b24jssdk', () => ({
    initializeB24Frame: async () => ({ actions: { v2: { call: { make: call } } } }),
    B24PullClientManager: class {
      subscribe() { return () => {} }
      async start() {
        if (opts.startThrows) throw new Error('pull server unreachable')
      }

      destroy() {}
    }
  }))
  const { useSettingsSync } = await import('~/composables/useSettingsSync')
  return { sync: useSettingsSync(), call }
}

describe('#443: про неработающий канал живого обновления теперь можно узнать', () => {
  it('подписка поднялась — состояние «живой»', async () => {
    const { sync } = await withPortal()
    sync.subscribeReload(() => {})
    // Подписка асинхронная: даём микрозадачам добежать до `pull.start()`.
    await new Promise(r => setTimeout(r, 0))
    expect(sync.state.value).toBe('live')
    expect(sync.failure.value).toBeNull()
  })

  it('pull-сервер портала недоступен — «недоступно» с причиной, а не тишина', async () => {
    const { sync } = await withPortal({ startThrows: true })
    sync.subscribeReload(() => {})
    await new Promise(r => setTimeout(r, 0))
    expect(sync.state.value).toBe('unavailable')
    expect(sync.failure.value).toBe('pull-failed')
  })

  it('вне фрейма — своя причина: это не поломка портала, а другой сценарий', async () => {
    // ⚠ Отдельный класс, а не общий «не получилось»: вне портала канал не нужен вовсе, и лечить
    // тут нечего. Слить их в один — значит получить тревогу на каждом локальном запуске.
    const { sync } = await withPortal({ framed: false })
    await sync.notifyReload()
    expect(sync.failure.value).toBe('not-framed')
  })

  it('отправка упала — сохранение настроек НЕ падает вместе с ней', async () => {
    // ⚠ Несущее утверждение: канал остаётся best-effort. Правка задачи добавляет наблюдаемость, а
    // не превращает необязательное уведомление соседних вкладок в условие сохранения.
    const { sync } = await withPortal({ callThrows: true })
    await expect(sync.notifyReload()).resolves.toBeUndefined()
    expect(sync.state.value).toBe('unavailable')
    expect(sync.failure.value).toBe('send-failed')
  })
})
