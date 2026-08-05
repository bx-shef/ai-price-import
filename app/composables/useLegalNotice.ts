import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'

// Отметка о показе уведомления об изменении документов (#418, п. 9.3.4 EULA).
//
// ⚠ Best-effort по построению: сбой записи не должен ни ронять экран, ни прятать баннер. Уведомить
// важнее, чем записать, что уведомили, — и вторая половина доказательства (сообщение в чат) от этой
// записи не зависит вовсе.
//
// ⚠ Вне портала фрейм-токена нет, и отмечать нечего: на лендинге баннер показывается всем подряд,
// он публикация, а не адресное уведомление лицензиата.
export function useLegalNotice() {
  const { init, ensureAuth } = useB24()
  /** Один портал, одна редакция — один запрос за жизнь страницы. */
  const sent = new Set<string>()

  async function markShown(edition: string): Promise<void> {
    if (sent.has(edition)) return
    sent.add(edition)
    try {
      await init()
      const headers = buildFrameHeaders(await ensureAuth())
      if (!headers) return
      await $fetch('/api/legal-notice', { method: 'POST', headers, body: { edition } })
    } catch { /* отметка не записалась — баннер всё равно показан */ }
  }

  return { markShown }
}
