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
/**
 * Сколько страниц берём за проход (50×20 = 1000 порталов на редакцию в сутки).
 *
 * ⚠ Кап нужен, но одной страницы было МАЛО и это ломало обязанность: при 50 порталах в сутки и
 * десятидневном сроке обычной правки потолок ровно 500 — а 501-й портал не получал бы уведомления
 * НИКОГДА, потому что после даты вступления рассылка прекращается. Отбор детерминированный
 * (`ORDER BY member_id`), поэтому обделены были бы всегда одни и те же.
 */
export const MAX_NOTICE_PAGES = 20

export interface LegalNoticeDispatchDeps {
  /** Сегодняшний день `ГГГГ-ММ-ДД` в UTC. */
  today: string
  /** Объявленные редакции (конфиг приложения). */
  editions: PendingLegalEdition[]
  /** Порталы, которым по этой редакции ещё не писали, идущие ПОСЛЕ `after` (курсор по member_id). */
  pendingPortals: (editionKey: string, limit: number, after: string) => Promise<string[]>
  /**
   * Отправить сообщение в чат портала.
   *
   * ⚠ Исходов ТРИ, а не два. `no-channel` (чат уведомлений не выбран) — состояние ПОСТОЯННОЕ, а
   * `failed` (портал не ответил) — временное. Слитые в одно «не доставлено», они делали очередь
   * неотличимой от рабочей ровно тогда, когда она стояла намертво.
   */
  send: (memberId: string, text: string) => Promise<'sent' | 'failed' | 'no-channel'>
  /** Отметить факт отправки. Зовётся ТОЛЬКО по факту доставки. */
  markSent: (memberId: string, editionKey: string) => Promise<void>
  /** Абсолютный адрес страницы документа. */
  docUrl: (path: string) => string
  /** Проверка объявления перед рассылкой. Непустой список — не рассылаем вовсе. */
  problems?: (edition: PendingLegalEdition) => string[]
  log?: (msg: string) => void
}

export interface LegalNoticeDispatchResult {
  sent: number
  failed: number
  /** Порталы, которым доставлять некуда: чат уведомлений не выбран. Не сбой, но и не доставка. */
  undeliverable: number
  /** Объявления, отвергнутые проверкой перед рассылкой. Такое уведомление не отправляется вовсе. */
  rejected: string[]
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
  let undeliverable = 0
  const rejected: string[] = []
  for (const edition of deps.editions) {
    // Рассылаем только пока объявление идёт. После даты вступления писать поздно: уведомлением
    // это уже не будет, а выглядело бы как запоздалое оправдание.
    if (!isAnnouncementVisible(edition, deps.today)) continue
    const key = editionKey(edition)
    // ⚠ Проверка объявления — ЗДЕСЬ, fail-closed, а не только в тесте над реестром. Кривая дата
    // даёт ссылку на несуществующую редакцию (404) и дату вступления, не равную обещанной, — и
    // уходит это сразу в чужие чаты, откуда не отзывается. Лучше не отправить и закричать.
    const problems = deps.problems?.(edition) ?? []
    if (problems.length) {
      rejected.push(`${key}: ${problems.join('; ')}`)
      deps.log?.(`[legal-notice] ${key}: НЕ разослано — ${problems.join('; ')}`)
      continue
    }
    const text = buildLegalNoticeChat(edition, deps.docUrl)
    // Счётчики — ПО РЕДАКЦИИ, а не сквозные: сквозные показали бы во второй строке журнала сумму по
    // обеим, и разбор «почему клиент не получил» шёл бы по неверным числам.
    let editionSent = 0
    let editionFailed = 0
    let editionSkipped = 0
    let after = ''
    for (let page = 0; page < MAX_NOTICE_PAGES; page++) {
      const portals = await deps.pendingPortals(key, MAX_NOTICE_BATCH, after)
      if (!portals.length) break
      after = portals[portals.length - 1]!
      for (const memberId of portals) {
        try {
          const outcome = await deps.send(memberId, text)
          if (outcome === 'sent') {
            await deps.markSent(memberId, key)
            editionSent++
          } else if (outcome === 'no-channel') {
            editionSkipped++
          } else {
            editionFailed++
          }
        } catch {
          // ⚠ Только счётчик: текст ошибки портала вправе процитировать параметры вызова, а в них
          // едет само уведомление. Портал остаётся в очереди и попадёт в следующий проход.
          editionFailed++
        }
      }
      if (portals.length < MAX_NOTICE_BATCH) break
    }
    sent += editionSent
    failed += editionFailed
    undeliverable += editionSkipped
    // Строка пишется на КАЖДОМ проходе с работой — включая «всё плохо». Молчание при нулях читалось
    // бы как «рассылки не было», а это разные вещи.
    deps.log?.(`[legal-notice] ${key}: отправлено ${editionSent}, не доставлено ${editionFailed}, доставлять некуда ${editionSkipped}`)
  }
  return { sent, failed, undeliverable, rejected }
}
