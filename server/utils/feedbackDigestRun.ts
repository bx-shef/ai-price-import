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
 * ⚠ Порядок «попытка → чтение → отправка → закрытие недели» выбран не произвольно. Первая
 * редакция расходовала неделю ДО доставки, и тогда один отказ Телеграма (429 не бросает, а
 * возвращает результат) хоронил сводку на семь суток — ровно тот дефект, который в этом проекте
 * уже исправляли дважды (`queueAlertDeliver`, чистка отзывов) и записывали поимённо. Здесь неделя
 * закрывается ТОЛЬКО успехом, а неудача стоит одной попытки из `MAX_ATTEMPTS_PER_WEEK`:
 * бесконечный повтор в мессенджер хуже пропуска, но и молчание из-за одного 429 недопустимо.
 */
export function createDigestRunner(deps: DigestRunDeps) {
  /** Неделя, за которую сводка этим процессом уже доставлена. */
  let sentWeek = ''
  /** Попытки этой недели, когда общего счётчика нет (без Redis). */
  let localWeek = ''
  let localAttempts = 0
  let running = false

  return async function runDigest(): Promise<DigestRunResult> {
    if (running) return { sent: false, skipped: 'in-flight' }
    running = true
    try {
      const week = isoWeekKey(new Date(deps.now()))
      if (sentWeek === week) return { sent: false, skipped: 'already-sent' }
      const key = `feedback-digest:${week}`
      const shared = await deps.claimAttempt(key)
      // ⚠ Без общего счётчика попытки считаются В ПАМЯТИ, а не пропускаются. Разбор нашёл здесь
      // дыру: память хранила только УСПЕХ, поэтому при вечно неуспешной доставке (бота выкинули
      // из чата — это отказ навсегда, а `send` не бросает, а возвращает `false`) каждый час шёл
      // полный постраничный обход приёмника под токеном издателя. Бюджет обязан действовать в
      // обеих ветках, иначе он защищает только там, где и так есть Redis.
      if (localWeek !== week) {
        localWeek = week
        localAttempts = 0
      }
      const attempt = shared ?? ++localAttempts
      if (attempt > MAX_ATTEMPTS_PER_WEEK) return { sent: false, skipped: 'attempts-exhausted' }

      const read = await deps.listIssues()
      // ⚠ `null` доезжает до текста ОТДЕЛЬНЫМ исходом и нулями не подменяется: нечитаемый приёмник
      // и пустой приёмник дали бы одинаковую сводку, и авария канала выглядела бы спокойной
      // неделей. Ровно от этого сводка и заводится.
      const stats = read ? summarizeFeedbackIssues(read.issues.filter(isOwnFeedbackIssue), deps.now()) : null
      const text = buildDigestText(stats, { weekKey: week, issuesUrl: deps.issuesUrl, truncated: read?.truncated })

      const delivered = await deps.send(text)
      if (delivered) {
        sentWeek = week
        // ⚠ Успех ЗАКРЫВАЕТ неделю durable-способом — выбирает остаток бюджета. Прежняя редакция
        // считала «попытка не первая» признаком «сосед уже отправил», и это ломалось ровно на
        // перезапуске: контейнер перекатывается по десятку раз в день, признак «это МЫ не смогли»
        // жил в памяти, и недоставленная сводка после выката объявлялась чужой — то есть не
        // приходила ВООБЩЕ до конца недели. Плата за разворот названа: в редком случае гонки двух
        // экземпляров сводка придёт дважды, но не больше `MAX_ATTEMPTS_PER_WEEK` раз, а дубль
        // безобиднее молчания.
        for (let i = 0; i < MAX_ATTEMPTS_PER_WEEK; i++) {
          const n = await deps.claimAttempt(key)
          if (n === null || n > MAX_ATTEMPTS_PER_WEEK) break
        }
        localAttempts = MAX_ATTEMPTS_PER_WEEK
      } else {
        deps.log?.('сводка не доставлена — повторим на следующем тике')
      }
      return { sent: true, delivered, text }
    } finally {
      running = false
    }
  }
}
