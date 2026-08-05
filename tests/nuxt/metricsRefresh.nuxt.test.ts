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

  it('фоновое обновление молчит об отказе и не гасит уже показанные числа', async () => {
    // ⚠ Два разных требования приёмки, и оба про одно: перечитывание — удобство, а не действие,
    // которого человек ждёт. Ошибка поверх успешного импорта сообщала бы о поломке, которой нет;
    // индикатор загрузки ради свежих чисел на секунду отнял бы те, что уже есть.
    vi.resetModules()
    const $fetch = vi.fn(async () => {
      throw new Error('сеть недоступна')
    })
    vi.stubGlobal('$fetch', $fetch)
    const { useMetrics } = await import('~/composables/useMetrics')
    const m = useMetrics()
    // Молчаливое чтение: отказ не выставляет ни ошибку, ни признак «загружаем».
    await m.load({ silent: true })
    expect(m.error.value).toBe('')
    expect(m.loadError.value).toBe('')
    expect(m.loading.value).toBe(false)
  })

  it('обычное чтение об отказе сообщает — иначе экран молчит там, где человек ждёт ответа', async () => {
    // ⚠ Зеркальное утверждение: `silent` не должен стать поведением по умолчанию. При открытии
    // страницы и по кнопке «Обновить» человек ждёт данных и обязан узнать, если их не будет.
    vi.resetModules()
    vi.stubGlobal('$fetch', vi.fn(async () => {
      throw new Error('сеть недоступна')
    }))
    const { useMetrics } = await import('~/composables/useMetrics')
    const m = useMetrics()
    await m.load()
    expect(m.loadError.value).not.toBe('')
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
