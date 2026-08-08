import type { FeedbackIssueRef } from './feedbackRetention'
import { isOwnFeedbackIssue } from './feedbackRetention'
import { buildDigestText, isoWeekKey, summarizeFeedbackIssues } from './feedbackDigest'

// Прогон еженедельной сводки (#466) — ЧИСТОЕ ядро с внедрёнными зависимостями.
//
// Почему это не тело плагина. Разбор тестировщика: пока решение жило в плагине, его не проверял
// НИ ОДИН тест, и мутация `summarizeFeedbackIssues(read?.issues ?? [], now)` (вместо отдельной
// ветки `null`) проходила весь прогон целиком — то есть несущее различие «приёмник не прочитан»
// против «отзывов нет» держалось на комментарии. Отсечка недели держалась там же: `return true`
// вместо проверки давало 168 сообщений в неделю при зелёном CI.

/** Сколько попыток на одну календарную неделю допускается после неудачной доставки. */
export const MAX_ATTEMPTS_PER_WEEK = 3

export interface DigestRunDeps {
  /** Открытые отзывы приёмника; `null` — не прочитали. */
  listIssues: () => Promise<{ issues: FeedbackIssueRef[], truncated: boolean } | null>
  /** Доставка. `false` — не доставлено (429, сеть, 5xx). Не бросает. */
  send: (text: string) => Promise<boolean>
  /**
   * Счётчик попыток недели, общий для всех экземпляров; `null` — счётчика нет (без Redis).
   * Возвращает номер попытки: 1 у первой.
   */
  claimAttempt: (key: string) => Promise<number | null>
  /** Куда идти разбирать — печатается в сообщении. */
  issuesUrl?: string
  now: () => number
  log?: (message: string) => void
}

export interface DigestRunResult {
  sent: boolean
  /** Почему не отправляли. */
  skipped?: 'already-sent' | 'attempts-exhausted' | 'in-flight'
  delivered?: boolean
  text?: string
}

/**
 * Собрать прогон.
 *
 * ⚠ Порядок «попытка → чтение → отправка → пометка об успехе» выбран не произвольно. Первая
 * редакция расходовала неделю ДО доставки, и тогда один отказ Телеграма (429 не бросает, а
 * возвращает результат) хоронил сводку на семь суток — ровно тот дефект, который в этом проекте
 * уже исправляли дважды (`queueAlertDeliver`, чистка отзывов) и записывали поимённо. Здесь он
 * закрыт бюджетом попыток: недоставленная сводка повторится на следующем тике, но не больше
 * `MAX_ATTEMPTS_PER_WEEK` раз — бесконечный повтор в мессенджер хуже пропуска.
 *
 * ⚠ Без общего счётчика (нет Redis) отсечка держится ПАМЯТЬЮ ПРОЦЕССА. Голое «шлём, раз счётчика
 * нет» здесь неверно и стоит дорого: тик часовой, то есть 24 сводки в сутки и 24 полных обхода
 * приёмника под токеном издателя — тем же, которым живут приём отзывов и чистка со сроком по
 * Политике. У суточной чистки та же конструкция безобидна, у часового тика — нет.
 */
export function createDigestRunner(deps: DigestRunDeps) {
  /** Неделя, за которую сводка этим процессом уже доставлена. */
  let sentWeek = ''
  /** Неделя, на которой доставка сорвалась: только она даёт право на повтор. */
  let failedWeek = ''
  let running = false

  return async function runDigest(): Promise<DigestRunResult> {
    if (running) return { sent: false, skipped: 'in-flight' }
    running = true
    try {
      const week = isoWeekKey(new Date(deps.now()))
      if (sentWeek === week) return { sent: false, skipped: 'already-sent' }
      const attempt = await deps.claimAttempt(`feedback-digest:${week}`)
      if (attempt !== null) {
        // Не первая попытка — значит либо сосед уже отправил, либо мы сами не смогли. Повтор
        // разрешён ТОЛЬКО во втором случае: иначе две реплики по очереди слали бы одно и то же.
        if (attempt > 1 && failedWeek !== week) return { sent: false, skipped: 'already-sent' }
        if (attempt > MAX_ATTEMPTS_PER_WEEK) return { sent: false, skipped: 'attempts-exhausted' }
      }

      const read = await deps.listIssues()
      // ⚠ `null` доезжает до текста ОТДЕЛЬНЫМ исходом и нулями не подменяется: нечитаемый приёмник
      // и пустой приёмник дали бы одинаковую сводку, и авария канала выглядела бы спокойной
      // неделей. Ровно от этого сводка и заводится.
      const stats = read ? summarizeFeedbackIssues(read.issues.filter(isOwnFeedbackIssue), deps.now()) : null
      const text = buildDigestText(stats, { weekKey: week, issuesUrl: deps.issuesUrl, truncated: read?.truncated })

      const delivered = await deps.send(text)
      if (delivered) {
        sentWeek = week
        failedWeek = ''
      } else {
        failedWeek = week
        deps.log?.('сводка не доставлена — повторим на следующем тике')
      }
      return { sent: true, delivered, text }
    } finally {
      running = false
    }
  }
}
