// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest'

// #480. Склейка перечитывания настроек — ПОВЕДЕНИЕМ, а не грепом по исходнику.
//
// ⚠ Прежняя проверка проводки искала в файле строку `flight.run(loadOnce)`. Такой гард верен всегда,
// пока строка физически на месте: подмена задачи на пустышку, перенос вызова в ветку, которая не
// срабатывает, — всё это он пропускает. Здесь считается ЧИСЛО СЕТЕВЫХ ЗАПРОСОВ, то есть ровно то,
// ради чего механизм заведён.

/**
 * Свежий композабл с подменённой фрейм-авторизацией и `$fetch`.
 *
 * ⚠ Именно `vi.doMock` + `resetModules`, а НЕ `mockNuxtImport`: `useSettings` импортирует `useB24`
 * ЯВНО (`import { useB24 } from './useB24'`), а не автоимпортом Nuxt, и перехват автоимпорта его не
 * трогает. С ним тест «зеленел» на нуле запросов — то есть проверял бы, что механизм не работает
 * вовсе. Тот же приём, что в тесте объявления.
 */
async function freshSettings(fetchMock: () => Promise<unknown>) {
  vi.resetModules()
  vi.doMock('~/composables/useB24', () => ({
    useB24: () => ({
      init: vi.fn(async () => {}),
      ensureAuth: vi.fn(async () => ({ accessToken: 'token', domain: 'p.bitrix24.by' })),
      inFrame: () => true
    })
  }))
  vi.stubGlobal('$fetch', fetchMock)
  const { useSettings } = await import('~/composables/useSettings')
  return useSettings()
}

/** Ответ роута настроек — форма важна только тем, что композабл её принимает. */
const settingsResponse = () => ({
  mapping: { configured: true, onMissing: 'freeform' },
  admin: true,
  baseCurrency: 'BYN',
  currencyUnknown: false
})

const tick = () => new Promise(r => setTimeout(r))

describe('#480: перечитывание настроек склеивается на уровне композабла', () => {
  it('десять одновременных загрузок дают ДВА запроса, а не десять', async () => {
    // Ровно поведение портала с десятком открытых экранов: событие «настройки изменились» приходит
    // всем разом. Второй запрос — законный хвостовой повтор: он гарантированно начат позже
    // последнего события, иначе присоединившийся получил бы состояние ДО сохранения.
    let inflight!: (v: unknown) => void
    const gate = new Promise((r) => {
      inflight = r
    })
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) await gate
      return settingsResponse()
    })
    const api = await freshSettings(fetchMock)
    const first = api.load()
    for (let i = 0; i < 9; i++) void api.load()
    await tick()
    expect(calls, 'запросы ушли параллельно — склейки нет').toBe(1)
    inflight(null)
    await first
    expect(calls, 'хвостовой повтор обязан быть ровно один').toBe(2)
    vi.unstubAllGlobals()
  })

  it('присоединившийся ждёт ХВОСТ, а не первый ответ', async () => {
    // Иначе экран, разбуженный событием, покажет настройки ДО сохранения — и останется с ними до
    // следующего события. Тихо и правдоподобно.
    let version = 'старая'
    const seen: string[] = []
    let inflight!: (v: unknown) => void
    const gate = new Promise((r) => {
      inflight = r
    })
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      const v = version
      if (calls === 1) await gate
      seen.push(v)
      return settingsResponse()
    })
    const api = await freshSettings(fetchMock)
    const first = api.load()
    await tick()
    version = 'новая' // сохранение случилось, пока первый запрос в воздухе
    void api.load()
    inflight(null)
    await first
    expect(seen.at(-1), 'последним применилось состояние ДО сохранения').toBe('новая')
    vi.unstubAllGlobals()
  })

  it('экран не остаётся в состоянии «грузим» после склейки', async () => {
    // `loaded` — то, на чём построен экран (#408). Если склейка оставит его false, экран замрёт в
    // скелетоне: данные пришли, а показать их некому.
    const fetchMock = vi.fn(async () => settingsResponse())
    const api = await freshSettings(fetchMock)
    await Promise.all([api.load(), api.load(), api.load()])
    expect(api.loaded.value, 'экран замер в заглушке').toBe(true)
    expect(api.loading.value, 'индикатор загрузки завис').toBe(false)
    vi.unstubAllGlobals()
  })

  it('отказ сети не запирает экран — следующая загрузка идёт заново', async () => {
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('сеть')
      return settingsResponse()
    })
    const api = await freshSettings(fetchMock)
    await api.load()
    expect(api.loadError.value, 'отказ обязан быть назван').toBeTruthy()
    await api.load()
    expect(calls).toBe(2)
    expect(api.loadError.value, 'после успешной загрузки отказ должен сняться').toBe('')
    vi.unstubAllGlobals()
  })
})
