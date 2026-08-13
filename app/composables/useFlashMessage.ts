import { onBeforeUnmount, ref } from 'vue'
import { FLASH_MS } from '~/utils/opsMonitor'

/**
 * Self-clearing result message for an operator action.
 *
 * ЗАЧЕМ ОТДЕЛЬНО (#271-G, вынесено в #523). Строка результата раньше висела на экране до перезагрузки
 * и выглядела относящейся к любой строке списка: оператор переавторизовал один портал, шёл к
 * следующему и читал «Токен обновлён» уже про него. Гасим сама собой.
 *
 * ⚠ Таймер снимается при размонтировании: иначе он переживёт компонент и через `FLASH_MS` напишет в
 * ref, которого на экране уже нет. Прежде это чинилось общей на всю страницу картой таймеров —
 * рабочий приём, но он требовал не забыть чистку в `onBeforeUnmount` руками у каждого нового
 * сообщения. Здесь чистка едет вместе с сообщением.
 */
export function useFlashMessage(ms: number = FLASH_MS) {
  const text = ref('')
  let timer: ReturnType<typeof setTimeout> | null = null

  function flash(next: string): void {
    text.value = next
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      text.value = ''
    }, ms)
  }

  /**
   * Убрать сообщение прямо сейчас.
   *
   * ⚠ Нужно НЕ для красоты: оператор жмёт «Переавторизовать» на втором портале, пока на экране ещё
   * висит «Токен обновлён» от первого, — и до ответа сервера читает чужой результат как свой.
   * Действие начинается с чистого листа, а не с прошлого исхода.
   */
  function clear(): void {
    if (timer) clearTimeout(timer)
    timer = null
    text.value = ''
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  return { text, flash, clear }
}
