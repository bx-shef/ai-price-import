// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest'

// Открыватель слайдера не был покрыт НИЧЕМ — ни одним тестом во всём наборе (проверено поимённо:
// `sliderRoutes` пинит только карту place→маршрут, `frameHeaders` грепает исходник, единственный
// мок в `importJobItem.nuxt.test.ts` возвращает `false` и до payload не доходит). То есть удаление
// ключа, опечатка в его имени и слом фолбэка одинаково оставались зелёными.
//
// ⚠ Почему тест смотрит на ИМЕНА ключей, а не на их список. SDK типизирует
// `openSliderAppPage(params?: any)`, поэтому `bx24_witdh` не ловится ни typecheck'ом, ни глазами
// ревьюера — и уехал бы в портал как неизвестный ключ, который тот молча игнорирует: слайдер
// открылся бы шириной по умолчанию, а не нашей. Именно это и проверяем.
// ⚠ ЖЁСТКОГО списка разрешённых ключей тут намеренно НЕТ. Платформа документирует четыре
// (`bx24_width`, `bx24_label`, `bx24_title`, `bx24_leftBoundary`), и замок «ровно эти два»
// покраснел бы на законном `bx24_leftBoundary` — то есть сторожил бы не дефект, а наше сегодняшнее
// решение.

interface Sent { place?: string, bx24_width?: unknown, bx24_title?: unknown, [k: string]: unknown }

/** Поднимает свежий модуль с подставленным фреймом и шпионом на открывателе слайдера. */
async function withSlider(openSliderAppPage: (p: Sent) => Promise<unknown>) {
  vi.resetModules()
  // Композабл считает себя «во фрейме» по непустому `window.name` — так портал помечает окно.
  window.name = 'test-frame'
  vi.doMock('@bitrix24/b24jssdk', () => ({
    initializeB24Frame: async () => ({
      auth: { isAdmin: false, getAuthData: () => false },
      slider: { openSliderAppPage }
    })
  }))
  const { useB24 } = await import('~/composables/useB24')
  return useB24()
}

describe('openAppSlider: что уходит в портал', () => {
  it('ширина уходит в bx24_width, заголовок — в bx24_title, place — как есть', async () => {
    let sent: Sent | undefined
    const b = await withSlider(async (p) => {
      sent = p
    })

    const ok = await b.openAppSlider('app-options', { width: 720, title: 'Настройки импорта' })

    expect(ok).toBe(true)
    expect(sent).toEqual({ place: 'app-options', bx24_width: 720, bx24_title: 'Настройки импорта' })
    // Отдельно и явно: число доехало числом. Строка «720» портал принял бы, но это уже не наш контракт.
    expect(typeof sent?.bx24_width).toBe('number')
  })

  it('заголовок не передан — ключа НЕТ, а не undefined', async () => {
    // Ветка спреда. `{ bx24_title: undefined }` сериализуется в postMessage как присутствующий ключ,
    // и портал получил бы пустой заголовок вместо своего умолчания.
    let sent: Sent | undefined
    const b = await withSlider(async (p) => {
      sent = p
    })

    await b.openAppSlider('app-main', { width: 1200 })

    expect(sent).not.toHaveProperty('bx24_title')
    expect(sent).toEqual({ place: 'app-main', bx24_width: 1200 })
  })

  it('SDK бросил — false, и наружу ничего не летит', async () => {
    // На этом контракте держится фолбэк `openSettings` → navigateTo('/settings'): проглоти мы
    // отказ как успех, человек остался бы на экране без настроек и без объяснения.
    const b = await withSlider(async () => {
      throw new Error('slider refused')
    })

    await expect(b.openAppSlider('app-options', { width: 720 })).resolves.toBe(false)
  })

  it('вне портала — false, фрейм не поднимается', async () => {
    vi.resetModules()
    window.name = ''
    const { useB24 } = await import('~/composables/useB24')

    await expect(useB24().openAppSlider('app-options', { width: 720 })).resolves.toBe(false)
  })
})
