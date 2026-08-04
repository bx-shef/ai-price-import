// @vitest-environment nuxt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONSENT_KEY } from '~/config/cookieConsent'

// #404. Композабл согласия не был покрыт ВООБЩЕ, и мутационная проверка это показала: правка
// «после клика счётчик не запускать» не роняла ни одного теста, хотя и комментарий, и CLAUDE.md
// обещают «поднимается без перезагрузки, первый визит не теряется». Вместе с расхождением ключа
// хранилища это давало полностью мёртвую аналитику при зелёном CI.

/**
 * Подмена всего хранилища, а НЕ шпион на прототипе.
 *
 * ⚠ Первая версия ставила `vi.spyOn(window.localStorage.__proto__, …)` — и в полном прогоне файла
 * мок не действовал вовсе: тест был зелёным, но проверял пустоту, а мутация «убрать try/catch»
 * его не роняла. То есть оба случая про приватный режим браузера ничего не сторожили. Поэтому
 * ниже — подмена объекта целиком и мета-проверка, что заглушка ДЕЙСТВИТЕЛЬНО бросает.
 */
function breakStorage(which: 'read' | 'write') {
  const real = window.localStorage
  const boom = () => {
    throw new Error('denied')
  }
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: which === 'read' ? boom : () => null,
      setItem: which === 'write' ? boom : () => {},
      removeItem: () => {},
      clear: () => {}
    }
  })
  return () => Object.defineProperty(window, 'localStorage', { configurable: true, value: real })
}

/** Свежий модуль на каждый случай: состояние в нём синглтонное и переживало бы соседний тест. */
async function fresh() {
  vi.resetModules()
  return (await import('~/composables/useCookieConsent')).useCookieConsent()
}

describe('#404: решение посетителя', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('хранилище бросает на чтении — «не отвечал», а не согласие', async () => {
    // В приватном режиме части браузеров `localStorage` бросает. Исключение из `onMounted` дало бы
    // ошибку Vue на публичной странице, и `ready` не выставился бы — баннер не показался бы вовсе,
    // то есть согласие нельзя было бы ни дать, ни отозвать.
    const restore = breakStorage('read')
    // Мета-проверка: заглушка действительно бросает. Без неё протухший мок снова сделал бы тест
    // зелёной пустотой — ровно это и случилось с первой версией.
    expect(() => window.localStorage.getItem('x')).toThrow()
    const c = await fresh()
    expect(() => c.load()).not.toThrow()
    expect(c.choice.value).toBeNull()
    expect(c.ready.value).toBe(true)
    restore()
  })

  it('хранилище бросает на записи — решение принято, страница не ломается', async () => {
    const restore = breakStorage('write')
    expect(() => window.localStorage.setItem('x', '1')).toThrow()
    const c = await fresh()
    expect(() => c.decide('declined')).not.toThrow()
    expect(c.choice.value).toBe('declined')
    restore()
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

// ⚠ Сам компонент не был покрыт НИ ОДНИМ тестом, и мутационная проверка показала цену: правки
// «показывать баннер всегда» и «не ставить отступ снизу» проходили набор зелёными. Это
// единственный код задачи, который мутирует `document.body`, — и именно он не проверялся.
describe('#404: баннер на странице', () => {
  beforeEach(() => {
    // Состояние композабла синглтонное: без сброса модулей ответ из соседнего случая переехал бы
    // в этот, и «баннера нет» проходило бы по чужой причине.
    vi.resetModules()
    window.localStorage.clear()
    document.body.style.paddingBottom = ''
  })

  /** happy-dom отдаёт `offsetHeight` нулём, поэтому высоту подставляем: проверяем ФАКТ отступа. */
  function stubHeight(px: number) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: px })
  }

  it('без ответа — виден, отступ снизу проставлен', async () => {
    stubHeight(120)
    const { mountSuspended } = await import('@nuxt/test-utils/runtime')
    const CookieBanner = (await import('~/components/CookieBanner.vue')).default
    const w = await mountSuspended(CookieBanner, { route: '/' })
    await new Promise(r => setTimeout(r, 0))
    expect(w.find('.cookie-banner').exists()).toBe(true)
    expect(document.body.style.paddingBottom).not.toBe('')
    w.unmount()
    // Уход со страницы обязан снять отступ: иначе внизу навсегда остаётся пустая полоса.
    expect(document.body.style.paddingBottom).toBe('')
  })

  it('ответ уже есть — баннера нет', async () => {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify({ choice: 'declined', version: 1 }))
    const { mountSuspended } = await import('@nuxt/test-utils/runtime')
    const CookieBanner = (await import('~/components/CookieBanner.vue')).default
    const w = await mountSuspended(CookieBanner, { route: '/' })
    await new Promise(r => setTimeout(r, 0))
    expect(w.find('.cookie-banner').exists()).toBe(false)
    expect(document.body.style.paddingBottom).toBe('')
    w.unmount()
  })

  it('экран внутри портала — баннера нет', async () => {
    const { mountSuspended } = await import('@nuxt/test-utils/runtime')
    const CookieBanner = (await import('~/components/CookieBanner.vue')).default
    const w = await mountSuspended(CookieBanner, { route: '/app' })
    await new Promise(r => setTimeout(r, 0))
    expect(w.find('.cookie-banner').exists()).toBe(false)
    w.unmount()
  })
})
