// @vitest-environment nuxt
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSENT_KEY } from '~/config/cookieConsent'

// #404. Композабл согласия не был покрыт ВООБЩЕ, и мутационная проверка это показала: правка
// «после клика счётчик не запускать» не роняла ни одного теста, хотя и комментарий, и CLAUDE.md
// обещают «поднимается без перезагрузки, первый визит не теряется». Вместе с расхождением ключа
// хранилища это давало полностью мёртвую аналитику при зелёном CI.

/** Свежий модуль на каждый случай: состояние в нём синглтонное и переживало бы соседний тест. */
async function fresh() {
  vi.resetModules()
  return (await import('~/composables/useCookieConsent')).useCookieConsent()
}

describe('#404: решение посетителя', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete (window as unknown as { __ymStart?: unknown }).__ymStart
  })

  it('согласие — счётчик поднимается сразу и решение сохраняется', async () => {
    const start = vi.fn()
    ;(window as unknown as { __ymStart: () => void }).__ymStart = start
    const c = await fresh()
    c.decide('accepted')
    expect(start).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(CONSENT_KEY)).toContain('accepted')
  })

  it('отказ — счётчик не трогаем', async () => {
    const start = vi.fn()
    ;(window as unknown as { __ymStart: () => void }).__ymStart = start
    const c = await fresh()
    c.decide('declined')
    expect(start).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(CONSENT_KEY)).toContain('declined')
  })

  it('счётчик не настроен — не падаем', async () => {
    // Пустой `NUXT_PUBLIC_METRIKA_ID` ⇒ сниппета нет ⇒ функции нет. Это не ошибка.
    const c = await fresh()
    expect(() => c.decide('accepted')).not.toThrow()
  })

  it('прочитанное решение поднимает счётчик и снимает баннер', async () => {
    const start = vi.fn()
    ;(window as unknown as { __ymStart: () => void }).__ymStart = start
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ choice: 'accepted', version: 1 }))
    const c = await fresh()
    c.load()
    expect(c.choice.value).toBe('accepted')
    expect(c.ready.value).toBe(true)
  })

  it('хранилище бросает — читаем как «не отвечал», а не как согласие', async () => {
    // В приватном режиме части браузеров `localStorage` бросает. Сторона ошибки выбрана: баннер
    // покажется снова, аналитика не запустится.
    const spy = vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const c = await fresh()
    expect(() => c.load()).not.toThrow()
    expect(c.choice.value).toBeNull()
    expect(c.ready.value).toBe(true)
    spy.mockRestore()
  })

  it('запись не удалась — решение всё равно принято, страница не ломается', async () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const c = await fresh()
    expect(() => c.decide('declined')).not.toThrow()
    expect(c.choice.value).toBe('declined')
    spy.mockRestore()
  })

  it('передумать можно: сброс возвращает вопрос', async () => {
    // Документ обещает возможность изменить решение. Без сброса единственным способом была бы
    // очистка данных сайта в браузере — то есть «дать в один клик, отозвать через настройки».
    const c = await fresh()
    c.decide('accepted')
    c.reset()
    expect(c.choice.value).toBeNull()
    expect(window.localStorage.getItem(CONSENT_KEY)).toBeNull()
  })
})
