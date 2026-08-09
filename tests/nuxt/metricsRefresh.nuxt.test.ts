// @vitest-environment nuxt
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

// #444. Метрики читались ОДИН РАЗ при открытии: человек загружал пять документов, видел результаты
// в списке операций — а «Обработано документов» и «Сэкономлено» оставались прежними. Обновились бы
// только при перезагрузке страницы, которую в портале никто не делает.

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\/.*$|<!--[\s\S]*?-->/gm, '')

describe('#444: метрики пересчитываются после импорта', () => {
  it('обновление привязано к СНЯТИЮ блокировки, а не к каждому заданию', () => {
    // ⚠ Импорт идёт пачкой, задания завершаются одно за другим — обновление на каждое было бы
    // пятью лишними запросами подряд. Пока `busy`, экран и так заблокирован; отпустили — пачка
    // отработала, и числа пересчитываются один раз.
    const page = read('../../app/pages/app.vue')
    expect(page).toMatch(/watch\(busy,\s*\(now, was\)\s*=>\s*\{\s*if \(was && !now\) void loadMetrics\(\{ silent: true \}\)/)
  })

  /**
   * Поднимает композабл В КОНТЕКСТЕ ПОРТАЛА.
   *
   * ⚠ Без подставленного фрейма `load()` выходит ДО запроса (нет фрейм-токена), и застабленный
   * `$fetch` не зовётся ни разу: проверка «молчаливый отказ не выставляет ошибку» проходила бы
   * через ветку авторизации, а не через `catch`. То есть мутация «убрать `if (silent) return` из
   * catch» — отмена несущего поведения задачи — тестами НЕ ловилась.
   */
  async function withMetrics(fetchImpl: () => Promise<unknown>) {
    vi.resetModules()
    window.name = 'test-frame'
    vi.doMock('@bitrix24/b24jssdk', () => ({
      initializeB24Frame: async () => ({ auth: { getAuthData: () => ({ access_token: 't', domain: 'p.bitrix24.by' }) } })
    }))
    const $fetch = vi.fn(fetchImpl)
    vi.stubGlobal('$fetch', $fetch)
    const { useMetrics } = await import('~/composables/useMetrics')
    return { m: useMetrics(), $fetch }
  }

  it('фоновое обновление молчит об отказе и не гасит уже показанные числа', async () => {
    // ⚠ Два разных требования приёмки, и оба про одно: перечитывание — удобство, а не действие,
    // которого человек ждёт. Ошибка поверх успешного импорта сообщала бы о поломке, которой нет;
    // индикатор загрузки ради свежих чисел на секунду отнял бы те, что уже есть.
    const { m, $fetch } = await withMetrics(async () => {
      throw new Error('сеть недоступна')
    })
    await m.load({ silent: true })
    // Несущая проверка: запрос ДЕЙСТВИТЕЛЬНО ушёл и упал — то есть отработала ветка `catch`.
    expect($fetch).toHaveBeenCalled()
    expect(m.error.value).toBe('')
    expect(m.loadError.value).toBe('')
    expect(m.loading.value).toBe(false)
  })

  it('обычное чтение об отказе сообщает — иначе экран молчит там, где человек ждёт ответа', async () => {
    // ⚠ Зеркальное утверждение: `silent` не должен стать поведением по умолчанию. При открытии
    // страницы и по кнопке «Обновить» человек ждёт данных и обязан узнать, если их не будет.
    const { m, $fetch } = await withMetrics(async () => {
      throw new Error('сеть недоступна')
    })
    await m.load()
    expect($fetch).toHaveBeenCalled()
    expect(m.loadError.value).not.toBe('')
  })

  it('молчаливое обновление НЕ стирает сообщение о неудавшемся сбросе счётчиков', async () => {
    // ⚠ Общий `error` пишет и `reset()`. Админ, увидевший «Не удалось сбросить метрики», терял бы
    // его от случайно совпавшего по времени фонового чтения: предупреждение мигнуло бы и исчезло,
    // не успев быть прочитанным.
    const { m } = await withMetrics(async () => ({ counters: {}, savings: {} }))
    m.error.value = 'Не удалось сбросить метрики'
    await m.load({ silent: true })
    expect(m.error.value).toBe('Не удалось сбросить метрики')
  })

  it('молчаливое чтение реально ходит на сервер и ЗАМЕНЯЕТ числа', async () => {
    // ⚠ Успешный путь не проверялся вовсе: мутация «`if (silent) return` первой строкой `load`» —
    // то есть автообновление выключено целиком — проходила зелёной. Проверка отказа этого не
    // видит: там запрос тоже «не даёт результата», только по другой причине.
    const { m, $fetch } = await withMetrics(async () => ({
      counters: { docs: 7 }, savings: { hours: 3 }
    }))
    await m.load({ silent: true })
    expect($fetch).toHaveBeenCalledWith('/api/import/metrics', expect.anything())
    expect(m.counters.value).toEqual({ docs: 7 })
    expect(m.savings.value).toEqual({ hours: 3 })
  })

  it('пока молчаливый запрос в пути, на экране остаются ПРЕЖНИЕ числа, а не нули', async () => {
    // ⚠ Пункт приёмки, который до этого не защищал никто: мутация «обнулять `counters`/`savings`
    // ПЕРЕД запросом» проходила зелёной через оба файла тестов. А это ровно тот дефект, который
    // чинил #408: портал с месяцами импорта на долю секунды сообщает, что импортов не было, и при
    // нулях срабатывает ещё и ветка пустого состояния. Проверка отказа его не видит (там числа
    // уцелели бы по другой причине — до присваивания дело не дошло), проверка успеха тоже: она
    // смотрит на состояние ПОСЛЕ ответа, когда обнуление уже перезаписано свежими данными.
    // Поэтому утверждение делается ровно в середине — запрос ушёл, ответ ещё не пришёл.
    let release: (v: unknown) => void = () => {}
    const pending = () => new Promise((res) => {
      release = res
    })
    const { m, $fetch } = await withMetrics(pending)
    m.counters.value = { docs: 40 }
    m.savings.value = { hours: 12 } as never

    const inFlight = m.load({ silent: true })
    // ⚠ Ждём именно ФАКТА ухода запроса, а не одного тика: до `$fetch` лежат `await init()` и
    // `ensureAuth()`. Утверждение на голом `await Promise.resolve()` делалось бы ДО того, как код
    // вообще дошёл до места мутации, и тест был бы зелёным независимо ни от чего.
    for (let i = 0; i < 50 && !$fetch.mock.calls.length; i++) {
      await Promise.resolve()
    }
    expect($fetch, 'запрос так и не ушёл — утверждать нечего').toHaveBeenCalled()
    expect(m.counters.value, 'числа обнулены до прихода ответа').toEqual({ docs: 40 })
    expect(m.savings.value, 'экономия обнулена до прихода ответа').toEqual({ hours: 12 })

    release({ counters: { docs: 45 }, savings: { hours: 14 } })
    await inFlight
    expect(m.counters.value).toEqual({ docs: 45 })
  })

  it('счётчики поднимаются ДО перевода задания в готовое — иначе экран прочитает старые', () => {
    // ⚠ Экран читает метрики ровно в момент, когда последнее задание пачки становится `done`.
    // При обратном порядке между этими действиями лежал апсерт в Postgres, и чтение попадало в
    // окно: числа «на один документ назад». Промах не самозаживает — второго обновления не будет
    // до следующего импорта, а правдоподобно неверная картинка хуже необновлённой.
    const src = read('../../server/queue/handlers.ts')
    expect(src.indexOf('bumpMetricsSafe(deps.bumpMetrics')).toBeLessThan(src.indexOf('await deps.setJobStatus('))
  })
})

describe('#444: решение по странице /metrics — не распространять', () => {
  it('автообновления там нет намеренно', () => {
    // ⚠ Решение записано здесь, а не только в issue: на `/metrics` импорт не происходит — экран
    // открывают, чтобы посмотреть, и закрывают. Автообновление означало бы фоновый опрос без
    // события, которое его оправдывает; ручная «Обновить» на странице есть.
    const page = read('../../app/pages/metrics.vue')
    expect(page).not.toContain('silent: true')
    expect(page, 'на /metrics должна остаться ручная кнопка обновления').toContain('reload')
  })
})
