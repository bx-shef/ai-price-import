import { pluralRu } from './jobStatus'

// Чистая обвязка операторской консоли (#271). Логика мелкая, но именно её отсутствие делало экран
// бесполезным: данные грузились один раз на монтировании, и оператор смотрел на замороженный снимок,
// не понимая, что тот устарел.

/** Как часто консоль подтягивает состояние очередей. Не чаще: три запроса на цикл. */
export const QUEUES_REFRESH_MS = 12_000
/** Через сколько само гаснет сообщение о результате действия. */
export const FLASH_MS = 4_000
/** После какого возраста снимок считаем устаревшим (два пропущенных цикла + запас). */
export const STALE_AFTER_MS = QUEUES_REFRESH_MS * 3

/** Время последнего обновления как «14:03:27». Пусто, если обновления ещё не было. */
export function formatClock(ms: number | null | undefined, locale = 'ru-RU'): string {
  if (!ms || !Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Устарел ли снимок. Нужен именно признак, а не только отметка времени: если автообновление
 * поставили на паузу или запросы молча перестали доходить, цифры на экране продолжают выглядеть
 * свежими — а это ровно тот случай, ради которого консоль и открывают.
 */
export function staleAfter(updatedAt: number | null | undefined, now: number = Date.now(), limit = STALE_AFTER_MS): boolean {
  if (!updatedAt || !Number.isFinite(updatedAt)) return false // обновления ещё не было — это не «устарело»
  return now - updatedAt > limit
}

/**
 * Порталы в списке оператора (#271-J/K). Плоский список без поиска и сортировки перестаёт работать
 * ровно тогда, когда консоль нужнее всего: приложение мультитенантное, и портал со сломанной
 * авторизацией — то, ради чего экран и открывают, — тонет среди здоровых.
 */
export interface OpsPortalRow {
  memberId: string
  domain: string
  health: 'ok' | 'near-expiry' | 'stale'
}

/** Порядок здоровья: сломанные наверх. Число — только для сортировки, наружу не показывается. */
const HEALTH_ORDER: Record<OpsPortalRow['health'], number> = { 'stale': 0, 'near-expiry': 1, 'ok': 2 }

/**
 * Отбор по подстроке. Ищем и по домену, и по `member_id`: у оператора на руках бывает именно id —
 * из логов, из SQL, из обращения клиента, — а домена он может не знать. Пустой запрос ничего не
 * отсеивает (а не отдаёт пусто).
 */
export function filterPortals<T extends OpsPortalRow>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(r => r.domain.toLowerCase().includes(q) || r.memberId.toLowerCase().includes(q))
}

/** Что показывать: всё или только требующее внимания. */
export type PortalHealthFilter = 'all' | 'problem'

/**
 * Отбор по состоянию авторизации. Сортировки «сломанные наверх» мало, когда порталов много: список
 * всё равно нужно проглядывать. Текстовый поиск сюда не годится — состояние не пишется в домене.
 */
export function filterByHealth<T extends OpsPortalRow>(rows: T[], mode: PortalHealthFilter): T[] {
  return mode === 'problem' ? rows.filter(r => r.health !== 'ok') : rows
}

/**
 * Проблемные — наверх, дальше по домену. Сортировка стабильна и не зависит от порядка сервера:
 * список перестраивается каждые 12 секунд, и «прыгающие» строки под курсором ловили бы клик мимо.
 */
export function sortPortalsByHealth<T extends OpsPortalRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.domain.localeCompare(b.domain, 'ru')
  )
}

/** Готовый список для экрана: сперва отбор (текст + состояние), затем порядок. */
export function visiblePortals<T extends OpsPortalRow>(
  rows: T[],
  query: string,
  mode: PortalHealthFilter = 'all'
): T[] {
  return sortPortalsByHealth(filterByHealth(filterPortals(rows, query), mode))
}

/**
 * Накопительный итог для консоли (#271-C). Счётчики очереди — это НЕ «обработано за всё время»:
 * BullMQ хранит последние `removeOnComplete`/`removeOnFail` задач, поэтому «готово: 1000» упирается
 * в потолок хранения. Настоящий итог живёт в наших собственных счётчиках (`metrics_counter`), и
 * подписывать его нужно отдельной строкой, чтобы одно не читалось как другое.
 */
export interface LifetimeTotals { docs: number, created: number, lines: number, errors: number }

const ru = (n: number) => n.toLocaleString('ru-RU')

/**
 * «12 документов · создано в CRM: 11 · 340 позиций · с ошибкой: 1».
 *
 * Пусто, только когда пусто ВСЁ. Гард по одному `docs` прятал бы строку у портала, который успел
 * получить ошибки, но ни одного документа: счётчики растут в разных местах (`errors` — внутри записи
 * в CRM, `docs` — только после её успешного завершения), да и падения на извлечении текста и разборе
 * `docs` не трогают вовсе.
 *
 * «Создано в CRM» подписано словами, а не «11 в CRM»: счётчик считает СУЩНОСТИ, и совпадение с
 * числом документов — частный случай (один документ → одна сделка), а не правило.
 */
export function lifetimeSummary(t: LifetimeTotals | null | undefined): string {
  if (!t || (t.docs <= 0 && t.created <= 0 && t.lines <= 0 && t.errors <= 0)) return ''
  const parts = [
    `${ru(t.docs)} ${pluralRu(t.docs, ['документ', 'документа', 'документов'])}`,
    `создано в CRM: ${ru(t.created)}`,
    `${ru(t.lines)} ${pluralRu(t.lines, ['позиция', 'позиции', 'позиций'])}`
  ]
  if (t.errors > 0) parts.push(`с ошибкой: ${ru(t.errors)}`)
  return parts.join(' · ')
}

/**
 * Реальная пропускная способность на портал — упирается в ограничитель Битрикс24 (около 2 запросов
 * в секунду при ~8 запросах на документ), а не в очередь. Подтверждено `pnpm loadtest:queue`.
 */
export const DOCS_PER_HOUR_PER_PORTAL = 900

/**
 * Во что превращается текущая глубина очереди по времени. Вместо полосы с выдуманной шкалой
 * (множитель без единиц, где 12 задач = 100%) оператор видит то, что можно сопоставить с реальностью.
 * Оценка НИЖНЯЯ: задачи разных порталов идут параллельно, каждый со своим ограничителем.
 */
export function backlogHours(pending: number, perHour: number = DOCS_PER_HOUR_PER_PORTAL): string {
  if (!Number.isFinite(pending) || pending <= 0) return ''
  const minutes = Math.round((pending / perHour) * 60)
  if (minutes < 1) return 'меньше минуты работы'
  if (minutes < 60) return `${minutes} мин работы`
  // Округляем ДО выбора формата, иначе 9.96 ч печаталось бы как «10.0 ч», а 10.0 — как «10 ч»:
  // два разных написания у соседних значений.
  const hours = Math.round((minutes / 60) * 10) / 10
  return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} ч работы`
}
