import { buildLegalNoticeChat, editionKey, isAnnouncementVisible, type PendingLegalEdition } from '../../app/utils/legalNotice'

// Рассылка уведомления об изменении документов в чаты порталов (#418, п. 9.3.3 EULA).
//
// ⚠ Это ВТОРАЯ половина уведомления, и без неё первая юридически неполна: баннер видит тот, кто
// зашёл, а лицензиат, месяц не открывавший приложение, узнал бы об изменении уже после того, как
// тридцатидневный срок истёк. Пункт 9.3.4 датирует доставку по наиболее ранней из двух дат, поэтому
// отправка фиксируется отдельно от показа.
//
// Чистое ядро с внедрёнными эффектами: без базы, без REST, без часов.

/** Сколько порталов обрабатываем за один проход. Ограничивает всплеск REST-вызовов. */
export const MAX_NOTICE_BATCH = 50

export interface LegalNoticeDispatchDeps {
  /** Сегодняшний день `ГГГГ-ММ-ДД` в UTC. */
  today: string
  /** Объявленные редакции (конфиг приложения). */
  editions: PendingLegalEdition[]
  /** Порталы, которым по этой редакции ещё не писали. */
  pendingPortals: (editionKey: string, limit: number) => Promise<string[]>
  /** Отправить сообщение в чат портала. `false` — не доставлено. */
  send: (memberId: string, text: string) => Promise<boolean>
  /** Отметить факт отправки. Зовётся ТОЛЬКО по факту доставки. */
  markSent: (memberId: string, editionKey: string) => Promise<void>
  /** Абсолютный адрес страницы документа. */
  docUrl: (path: string) => string
  log?: (msg: string) => void
}

export interface LegalNoticeDispatchResult {
  sent: number
  failed: number
}

/**
 * Разослать уведомления по всем идущим сегодня объявлениям.
 *
 * ⚠ `markSent` вызывается ПО ФАКТУ доставки, а не до отправки. Обратный порядок хоронил бы
 * уведомление навсегда при первом же сбое портала: следующий проход счёл бы его отправленным, и
 * лицензиат не узнал бы об изменении вовсе — при том что в журнале стояла бы отметка о доставке.
 *
 * ⚠ Отказ одного портала не останавливает остальных: недоступный портал (мёртвый токен, чат удалён)
 * — обычное состояние в мультитенанте, и один такой не вправе задержать рассылку всем прочим.
 */
export async function dispatchLegalNotices(deps: LegalNoticeDispatchDeps): Promise<LegalNoticeDispatchResult> {
  let sent = 0
  let failed = 0
  for (const edition of deps.editions) {
    // Рассылаем только пока объявление идёт. После даты вступления писать поздно: уведомлением
    // это уже не будет, а выглядело бы как запоздалое оправдание.
    if (!isAnnouncementVisible(edition, deps.today)) continue
    const key = editionKey(edition)
    const text = buildLegalNoticeChat(edition, deps.docUrl)
    const portals = await deps.pendingPortals(key, MAX_NOTICE_BATCH)
    for (const memberId of portals) {
      try {
        const ok = await deps.send(memberId, text)
        if (!ok) {
          failed++
          continue
        }
        await deps.markSent(memberId, key)
        sent++
      } catch {
        // ⚠ Только счётчик: текст ошибки портала вправе процитировать параметры вызова, а в них
        // едет само уведомление. Портал остаётся в очереди и попадёт в следующий проход.
        failed++
      }
    }
    if (portals.length) deps.log?.(`[legal-notice] ${key}: отправлено ${sent}, не доставлено ${failed}`)
  }
  return { sent, failed }
}
