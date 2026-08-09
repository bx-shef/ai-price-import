import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'
import type { Announcement } from '~/utils/announcement'
import { announcementSeenKey, isAnnouncementLive } from '~/utils/announcement'

// Клиент объявления издателя (#469).
//
// Показ решается ЗДЕСЬ, а не на сервере, и это осознанно: единственное состояние — «этот человек
// уже закрывал это объявление», и оно живёт в браузере (решение владельца, своего хранилища не
// заводим). Сервер отдаёт содержимое и следит за сроком; браузер помнит, что видел.
//
// ⚠ Срок проверяется ПОВТОРНО в браузере: вкладку с рабочим экраном не перезагружают сутками, и
// страница, открытая до конца акции, показала бы окно уже после её окончания.

export function useAnnouncement() {
  const { init, ensureAuth } = useB24()
  const announcement = ref<Announcement | null>(null)
  const open = ref(false)
  let checked = false

  /** Прочитать отметку «видел». Приватный режим браузера бросает на доступе к хранилищу. */
  function alreadySeen(id: string): boolean {
    try {
      return localStorage.getItem(announcementSeenKey(id)) === '1'
    } catch {
      // ⚠ Хранилище недоступно ⇒ считаем, что НЕ видел: показать второй раз безобиднее, чем
      // проглотить объявление у человека, который его не видел ни разу.
      return false
    }
  }

  function remember(id: string): void {
    try {
      localStorage.setItem(announcementSeenKey(id), '1')
    } catch { /* приватный режим: покажем ещё раз — это не ошибка, а известная плата */ }
  }

  /** Спросить сервер и решить, показывать ли. Вне портала инертно. */
  async function check(): Promise<void> {
    if (checked) return
    checked = true
    await init()
    const headers = buildFrameHeaders(await ensureAuth())
    if (!headers) return
    try {
      const r = await $fetch<{ announcement?: Announcement | null }>('/api/announcement', { headers })
      const a = r?.announcement ?? null
      if (!a || !isAnnouncementLive(a, Date.now()) || alreadySeen(a.id)) return
      announcement.value = a
      open.value = true
    } catch {
      // Любая неудача — молчим: объявление это украшение, а не часть работы.
    }
  }

  /**
   * Закрыть.
   *
   * ⚠ Отметка ставится ЛЮБЫМ закрытием — крестиком, кнопкой, нажатием вне окна, — потому что
   * владелец решил так прямо: не прочитал значит больше не увидит. Ставить её только по кнопке
   * означало бы, что закрывший окно случайно получит его снова завтра и послезавтра.
   */
  function dismiss(): void {
    const id = announcement.value?.id
    if (id) remember(id)
    open.value = false
  }

  return { announcement, open, check, dismiss }
}
