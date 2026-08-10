import { isServiceFailure } from './queueHealthRead'
import { portalHash } from './telemetryAttributes'

/**
 * Наблюдение за порталом, у которого падают ВСЕ импорты (#498).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ МЕХАНИЗМ, А НЕ РАСШИРЕНИЕ ТРЕВОГИ. После #492 отказ портала (`ACCESS_DENIED`,
 * протухший токен, удалённый тип записи) роняет задание честно — и это правильно. Но узнать о таком
 * падении было НЕЧЕМ, причём по построению:
 *
 *   • `failing` отсеивает ровно эти причины НАМЕРЕННО (`isServiceFailure`) — иначе один криво
 *     настроенный клиент будил бы нас ежечасно про то, что чиним не мы. Правило верное, и трогать
 *     его нельзя;
 *   • `stalled` не сработает: задание не висит, а быстро проваливается и уходит из очереди;
 *   • `unreadable` — только про недоступный Redis.
 *
 * Итог: у клиента с отозванным правом падают ВСЕ документы, а владелец не узнаёт об этом никогда.
 * Ровно тот класс невидимой аварии, ради которого писался #492, только слоем выше.
 *
 * ⚠ ЭТО НЕ ТРЕВОГА. Тревога значит «сервис сломан, разбуди меня»; здесь сервис исправен, а у
 * конкретного клиента отозвано право или протух токен. Поэтому канал — сводка (как #466), а не
 * телеграм-тревоги: канал, который будит по чужой настройке, перестают читать, и он не срабатывает
 * в тот единственный раз, ради которого заведён.
 *
 * ⚠ ДАННЫХ КЛИЕНТА В СООБЩЕНИИ НЕТ ПО ПОСТРОЕНИЮ: наружу уходит только необратимый `portal.hash`
 * (тот же, что в телеметрии) и числа. Ни домена, ни member_id, ни причины дословно — в тексте
 * отказа портала может оказаться название товара или имя поставщика ИЗ ДОКУМЕНТА (урок #416).
 */

/** Сырая упавшая задача: причина, время и пакет — из него берём портал. */
export interface RawPortalFailure {
  failedReason?: string | null
  finishedOn?: number | null
  processedOn?: number | null
  data?: { memberId?: unknown } | null
}

/** Сводка по одному порталу за окно наблюдения. */
export interface PortalFailureSummary {
  /** Необратимый отпечаток портала. Домена и member_id здесь нет и быть не должно. */
  portal: string
  /** Сколько раз портал отказал за окно. */
  failures: number
  /** Когда отказал в первый и последний раз (мс). */
  firstAtMs: number
  lastAtMs: number
}

/**
 * Окно наблюдения — сутки.
 *
 * Не час: отказ портала ДЕТЕРМИНИРОВАН и не проходит сам, а сутки дают увидеть картину целиком
 * («упало 40 документов»), а не всплеск. Не неделя: обещать «мы заметим за неделю» бессмысленно —
 * клиент за это время уже уйдёт.
 */
export const PORTAL_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Сколько отказов подряд считать поломкой у клиента.
 *
 * ⚠ Не единица. Один отказ бывает разовым (человек удалил направление ровно между выбором и
 * записью), и сообщать о нём значит писать по каждому такому случаю. Три — это уже не совпадение:
 * попытки одного задания сюда не попадают (BullMQ пишет в `failed` итог, а не каждую попытку),
 * значит три отказа — это три РАЗНЫХ документа.
 */
export const PORTAL_FAILURE_THRESHOLD = 3

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Сгруппировать отказы ПОРТАЛЬНОЙ природы по порталам.
 *
 * ⚠ Берём ровно дополнение к `isServiceFailure`: то, что тревога отсеивает, здесь и есть предмет
 * наблюдения. Списка причин своего тут НЕТ намеренно — две копии разошлись бы, и между ними
 * образовалась бы щель: класс отказов, который не считает ни один механизм.
 *
 * ⚠ Задача без разбираемого времени НЕ считается: недатированный отказ мог случиться когда угодно,
 * а принять его за «сейчас» значит сообщать о давно починенном.
 */
export function summarisePortalFailures(
  rows: RawPortalFailure[],
  nowMs: number,
  windowMs = PORTAL_FAILURE_WINDOW_MS
): PortalFailureSummary[] {
  const byPortal = new Map<string, PortalFailureSummary>()
  for (const row of rows ?? []) {
    if (isServiceFailure(row?.failedReason)) continue
    const at = num(row?.finishedOn) ?? num(row?.processedOn)
    if (at === null) continue
    if (!(nowMs - at <= windowMs && at <= nowMs)) continue
    const member = typeof row?.data?.memberId === 'string' ? row.data.memberId : ''
    // ⚠ Портал без member_id всё равно считается, под общим ключом `unknown`: молча выбросить такую
    // строку значит занизить счёт ровно там, где что-то уже пошло не так с самим пакетом задачи.
    const portal = portalHash(member)
    const prev = byPortal.get(portal)
    if (!prev) {
      byPortal.set(portal, { portal, failures: 1, firstAtMs: at, lastAtMs: at })
      continue
    }
    prev.failures += 1
    prev.firstAtMs = Math.min(prev.firstAtMs, at)
    prev.lastAtMs = Math.max(prev.lastAtMs, at)
  }
  // Сортировка по числу отказов: первым — тот, у кого хуже всего.
  return [...byPortal.values()].sort((a, b) => b.failures - a.failures || a.portal.localeCompare(b.portal))
}

/** Кого пора показать человеку. */
export function portalsNeedingAttention(
  summaries: PortalFailureSummary[],
  threshold = PORTAL_FAILURE_THRESHOLD
): PortalFailureSummary[] {
  return summaries.filter(s => s.failures >= threshold)
}

/**
 * Ключ отсечки — один портал в сутки.
 *
 * ⚠ Считается от КАЛЕНДАРНЫХ суток UTC, а не «24 часа с прошлого сообщения»: второе даёт
 * расползание времени доставки и превращает суточную сводку в «когда придётся».
 */
export function portalNoticeKey(portal: string, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10)
  return `portal-fail:${day}:${portal}`
}

/** Сколько порталов перечисляем в одном сообщении. Дальше — число «и ещё N». */
export const MAX_PORTALS_IN_MESSAGE = 10

const hours = (ms: number) => Math.max(1, Math.round(ms / 3_600_000))

/**
 * Текст сообщения.
 *
 * ⚠ Сообщение обязано отвечать на «что делать», а не только «что случилось»: владелец видит
 * отпечаток портала, а сопоставить его с клиентом можно только через журнал сервиса — поэтому
 * прямо сказано, где смотреть. Причину дословно НЕ печатаем: в ответе портала бывает текст из
 * документа клиента.
 */
export function buildPortalFailureMessage(portals: PortalFailureSummary[], nowMs: number, queuesUrl?: string): string {
  const shown = portals.slice(0, MAX_PORTALS_IN_MESSAGE)
  const lines = shown.map((p) => {
    const span = hours(p.lastAtMs - p.firstAtMs)
    return `• ${p.portal} — отказов: ${p.failures}, за последние ${span} ч`
  })
  const rest = portals.length - shown.length
  if (rest > 0) lines.push(`• и ещё порталов: ${rest}`)
  return [
    'У портала клиента падают все импорты',
    '',
    'Портал отвечает отказом на запись: чаще всего это отозванное право, протухшая авторизация или',
    'удалённый тип записи. Сервис при этом исправен — чинится это на стороне клиента.',
    '',
    ...lines,
    '',
    queuesUrl ? `Разбирать: ${queuesUrl}` : 'Разбирать: страница очередей в консоли оператора.'
  ].join('\n')
}
