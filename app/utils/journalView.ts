// Журнал импортов на экране: чистые правила подкачки и подписей (#458).
//
// Вынесено из компонента потому, что здесь живут ровно те решения, которые в разметке не увидишь
// глазами: когда подгружать следующую страницу, что считать концом списка и как не задвоить
// строки. Все три ломаются молча — список выглядит рабочим и в подкачке, и в дублировании.

/** Строка журнала, как она приходит с сервера. */
export interface JournalRow {
  activityId: number
  jobId: string
  title: string
  clean: boolean
  createdAt: string
  /** Владелец дела: компания при найденном контрагенте, иначе созданная сущность. */
  ownerTypeId: number
  ownerId: number
}

/**
 * Путь карточки-владельца дела для ссылки «Открыть».
 *
 * ⚠ Тип 4 — КОМПАНИЯ, и у неё свой путь. Без этой ветки успешный импорт с распознанным
 * поставщиком (то есть самый частый случай) вёл бы на `/crm/type/4/details/…` — страницу,
 * которой не существует. Ссылка выглядела бы рабочей и открывала пустоту.
 * ⚠ Неизвестный/нулевой владелец даёт пустую строку: лучше не показать кнопку, чем показать
 * кнопку в никуда.
 */
export function ownerOpenPath(ownerTypeId: number, ownerId: number): string {
  if (!Number.isInteger(ownerId) || ownerId <= 0) return ''
  if (ownerTypeId === 1) return `/crm/lead/details/${ownerId}/`
  if (ownerTypeId === 2) return `/crm/deal/details/${ownerId}/`
  if (ownerTypeId === 3) return `/crm/contact/details/${ownerId}/`
  if (ownerTypeId === 4) return `/crm/company/details/${ownerId}/`
  if (ownerTypeId === 7) return `/crm/quote/show/${ownerId}/`
  if (!Number.isInteger(ownerTypeId) || ownerTypeId <= 0) return ''
  return `/crm/type/${ownerTypeId}/details/${ownerId}/`
}

/**
 * Дописать страницу к уже показанному списку.
 *
 * ⚠ Дедуп по `activityId` ОБЯЗАТЕЛЕН, и это не перестраховка. Пагинация портала — по смещению
 * (`start`), а список отсортирован по убыванию id: пока человек читает, приходит новый импорт,
 * всё съезжает на позицию вниз, и следующая страница возвращает строку, которая уже показана.
 * Без дедупа человек видит один и тот же документ дважды и считает, что импорт задвоился.
 * ⚠ Порядок сохраняется: новые строки дописываются В КОНЕЦ, а не сортируются заново — иначе при
 * подгрузке список бы прыгал под пальцем.
 */
export function appendPage(shown: JournalRow[], page: JournalRow[]): JournalRow[] {
  const seen = new Set(shown.map(r => r.activityId))
  const fresh = page.filter(r => !seen.has(r.activityId))
  return fresh.length ? [...shown, ...fresh] : shown
}

/**
 * Пора ли грузить следующую страницу.
 *
 * ⚠ Проверяется И `hasMore`, И «сейчас не грузим». Без второго условия наблюдатель прокрутки
 * выстреливает несколько раз подряд, пока идёт первый запрос, и портал получает три-четыре
 * одинаковых вызова на одно движение пальца — на мобильном это заметно сразу, лимитом Б24.
 * ⚠ Отказ (`failed`) тоже останавливает автоподкачку: иначе экран уходил бы в бесконечный цикл
 * запросов к недоступному порталу, и человек не увидел бы даже сообщения об ошибке.
 */
export function shouldLoadMore(state: { hasMore: boolean, loading: boolean, failed: boolean }): boolean {
  return state.hasMore && !state.loading && !state.failed
}

/** Смещение следующей страницы: считаем от ПОКАЗАННОГО, а не от номера страницы. */
export function nextStart(shown: JournalRow[]): number {
  return shown.length
}

/**
 * Подпись даты для строки списка.
 *
 * ⚠ Портал отдаёт время со смещением (`2026-08-08T10:00:00+03:00`) — это время ПОРТАЛА, и
 * пересчитывать его в часовой пояс браузера нельзя: сотрудник в другом городе увидел бы у своего
 * же импорта не то время, которое стоит в карточке CRM рядом.
 * ⚠ Нераспознанная дата отдаётся пустой строкой, а не «Invalid Date»: пустое место читается как
 * «времени нет», а текст ошибки в списке — как поломка.
 */
export function formatJournalDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso ?? ''))
  if (!m) return ''
  const [, y, mo, d, h, min] = m
  return `${d}.${mo}.${y} ${h}:${min}`
}

/** Подпись исхода — словами, а не только цветом (цвет один не читается программой чтения). */
export function journalOutcomeLabel(clean: boolean): string {
  return clean ? 'Без замечаний' : 'С замечаниями'
}
