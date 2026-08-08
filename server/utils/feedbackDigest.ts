import type { FeedbackIssueRef } from './feedbackRetention'

// Еженедельная сводка по неразобранным отзывам (#466).
//
// Зачем это есть. Отзывы копятся в ПРИВАТНОМ репозитории-приёмнике, и узнать, что там что-то
// лежит, можно было единственным способом — зайти и посмотреть. Канал, который требует, чтобы
// кто-то уже смотрел, не уведомляет ни о чём: отзыв, написанный клиентом в понедельник, мог
// пролежать месяц, и никакой признак этого наружу не выходил. Раз в неделю сводка приходит сама.
//
// ⚠ Сотрудникам клиента она НЕ адресована (решение владельца 08.08.2026) — это канал издателя о
// собственной работе, как и тревоги очередей. Но чат у него СВОЙ: тревога значит «сервис сломан,
// разбуди меня», сводка — «на неделе накопилось». Смешав их, мы приучили бы читать по диагонали
// ровно тот канал, который заведён ради ночного звонка.
//
// ⚠ В сводке НЕТ данных клиента: ни имени поставщика, ни имени файла, ни текста комментария, ни
// идентификаторов заданий, ни номеров задач. Только счётчики и возраст. Приёмник приватный именно
// потому, что содержимое отзыва — документ клиента; пересказывать его в мессенджер значит выносить
// то же содержимое за периметр, о котором написано в Политике.

/** Отзыв считается запущенным, если лежит открытым дольше этого срока. */
export const STALE_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

export interface DigestStats {
  /** Открытых (неразобранных) отзывов всего. */
  open: number
  up: number
  down: number
  /** Сколько из них пришли с приложенным документом. */
  withFile: number
  /** Открыты дольше `STALE_DAYS`. */
  stale: number
  /** Возраст самого старого открытого отзыва в сутках; `null` — открытых нет. */
  oldestDays: number | null
  /** Сколько отзывов пришло за последние семь суток. */
  lastWeek: number
}

/** Признак «к отзыву приложен документ» — его печатает `buildFeedbackIssue`. */
const FILE_MARK = '**Исходный файл:**'

/**
 * Свернуть список открытых задач приёмника в счётчики.
 *
 * ⚠ Оценка берётся ИЗ МЕТОК (`feedback:up`/`feedback:down`), а не из заголовка: заголовок несёт
 * цветной кружок, а он одинаково выглядит в шрифте отправителя и в чужом эмодзи-наборе, и разбор
 * заголовка сломался бы от косметической правки текста. Метку ставит тот же билдер.
 * ⚠ Задача без нашей оценки в up/down не попадает вовсе и остаётся только в `open` — выдумывать ей
 * сторону нельзя, иначе сумма счётчиков перестанет сходиться с числом отзывов.
 */
export function summarizeFeedbackIssues(issues: FeedbackIssueRef[], nowMs: number): DigestStats {
  const stats: DigestStats = { open: 0, up: 0, down: 0, withFile: 0, stale: 0, oldestDays: null, lastWeek: 0 }
  for (const issue of issues) {
    const created = Date.parse(issue.createdAt)
    stats.open += 1
    if (issue.labels.includes('feedback:up')) stats.up += 1
    if (issue.labels.includes('feedback:down')) stats.down += 1
    if (issue.body.includes(FILE_MARK)) stats.withFile += 1
    // Непрочитанная дата не должна ни состарить отзыв, ни омолодить: считаем только по разобранной.
    if (!Number.isFinite(created)) continue
    const days = Math.floor((nowMs - created) / DAY_MS)
    if (days >= STALE_DAYS) stats.stale += 1
    if (days < 7) stats.lastWeek += 1
    if (stats.oldestDays === null || days > stats.oldestDays) stats.oldestDays = days
  }
  return stats
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

/**
 * Текст сводки.
 *
 * ⚠ `null` — это НЕ «отзывов нет», и разница написана словами. Приёмник мог не ответить (сеть,
 * права, исчерпанная квота), и в обоих случаях счётчики были бы нулевыми — то есть авария канала
 * выглядела бы спокойной неделей. Ровно от этого сводка и заводится: молчание должно быть
 * различимо от тишины.
 */
export function buildDigestText(stats: DigestStats | null): string {
  if (!stats) {
    return '⚠️ Сводка по отзывам: приёмник не прочитан — счётчики недоступны. Это НЕ значит, что отзывов нет.'
  }
  if (stats.open === 0) {
    return '📋 Сводка по отзывам за неделю: неразобранных нет.'
  }
  const lines = [
    `📋 Сводка по отзывам за неделю: ${stats.open} ${plural(stats.open, 'неразобранный', 'неразобранных', 'неразобранных')}.`,
    `👍 ${stats.up} · 👎 ${stats.down} · с документом ${stats.withFile}`,
    `Пришло за неделю: ${stats.lastWeek}`
  ]
  if (stats.oldestDays !== null) {
    lines.push(`Самый старый ждёт ${stats.oldestDays} ${plural(stats.oldestDays, 'сутки', 'суток', 'суток')}`)
  }
  if (stats.stale > 0) {
    lines.push(`⚠️ Лежат дольше ${STALE_DAYS} суток: ${stats.stale}`)
  }
  return lines.join('\n')
}

/**
 * Календарная неделя (ISO) — ключ отсечки.
 *
 * ⚠ Не «неделя с момента старта»: тогда неделя считалась бы от последнего выката, то есть
 * фактически никогда. Ключ обязан зависеть только от календаря.
 */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // Четверг той же недели однозначно задаёт её год и номер (ISO-8601).
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const fDay = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDay + 3)
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
