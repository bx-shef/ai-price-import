// @vitest-environment happy-dom
// ⚠ Своё окружение на файл: проект `unit` идёт в node без DOM, а композабл зовёт
// `onBeforeUnmount` — значит поднимать его надо в живом компоненте, а компоненту нужен узел.
// Полное окружение Nuxt здесь избыточно: проверяем чистый композабл, а не экран.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFlashMessage } from '../app/composables/useFlashMessage'
import { FLASH_MS } from '../app/utils/opsMonitor'

/**
 * Сообщение о результате действия оператора гаснет само и не переезжает на соседнюю строку (#271-G).
 *
 * ЗАЧЕМ ТЕСТ. При разборе консоли на блоки (#523) общая на страницу карта таймеров заменилась
 * композаблом — и осталась НЕ покрытой ничем: ни авто-очистка, ни `clear()` не проверялись, хотя
 * оба закрывают конкретные дефекты. Забытый `clear()` в следующем действии не уронил бы ни один
 * тест, а на экране это выглядит так: оператор жмёт «Переавторизовать» на втором портале и до
 * ответа сервера читает исход ПЕРВОГО как свой.
 *
 * ⚠ Композабл зовёт `onBeforeUnmount`, поэтому поднимаем его внутри компонента: вне setup хук
 * ругается предупреждением, и тест сторожил бы не то, что работает в приложении.
 */

/** Поднять композабл в живом экземпляре компонента и вернуть его наружу. */
async function inComponent(): Promise<ReturnType<typeof useFlashMessage> & { unmount: () => void }> {
  const { defineComponent, createApp, h } = await import('vue')
  let api: ReturnType<typeof useFlashMessage> | null = null
  const C = defineComponent({
    setup() {
      api = useFlashMessage()
      return () => h('div')
    }
  })
  const app = createApp(C)
  app.mount(document.createElement('div'))
  return { ...api!, unmount: () => app.unmount() }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('#271-G: сообщение о результате действия', () => {
  it('гаснет само через отпущенный срок', async () => {
    const { text, flash } = await inComponent()
    flash('Токен обновлён')
    expect(text.value).toBe('Токен обновлён')
    vi.advanceTimersByTime(FLASH_MS - 1)
    expect(text.value, 'погасло раньше срока').toBe('Токен обновлён')
    vi.advanceTimersByTime(1)
    expect(text.value, 'висит после срока — прежний дефект: строка оставалась до перезагрузки').toBe('')
  })

  it('новое сообщение сбрасывает срок прежнего, а не гаснет по его таймеру', async () => {
    const { text, flash } = await inComponent()
    flash('Первое')
    vi.advanceTimersByTime(FLASH_MS - 100)
    flash('Второе')
    vi.advanceTimersByTime(200) // прежний таймер сработал бы здесь
    expect(text.value, 'второе сообщение погасил таймер первого').toBe('Второе')
    vi.advanceTimersByTime(FLASH_MS)
    expect(text.value).toBe('')
  })

  it('clear() убирает сообщение сразу и снимает таймер', async () => {
    // Это и есть защита от «читаю чужой результат как свой»: действие начинается с чистого листа.
    const { text, flash, clear } = await inComponent()
    flash('Токен обновлён')
    clear()
    expect(text.value).toBe('')
    flash('Не удалось обновить')
    // Снятый таймер не должен догнать и погасить НОВОЕ сообщение раньше срока.
    vi.advanceTimersByTime(FLASH_MS - 1)
    expect(text.value, 'новое сообщение погасил таймер, снятый в clear()').toBe('Не удалось обновить')
  })

  it('таймер снимается вместе с компонентом', async () => {
    // Иначе он переживёт экран и через FLASH_MS напишет в ref, которого на странице уже нет.
    const { flash, unmount } = await inComponent()
    flash('Задача снова в очереди')
    unmount()
    expect(vi.getTimerCount(), 'после размонтирования остался живой таймер').toBe(0)
  })
})
