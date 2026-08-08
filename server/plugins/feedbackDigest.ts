import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { listOpenFeedbackIssues } from '../utils/feedbackGithubAdmin'
import { feedbackIssuesUrl } from '../utils/feedbackDigest'
import { DIGEST_COUNTER_TTL_SEC, createDigestRunner } from '../utils/feedbackDigestRun'
import { resolveTelegramConfig, sendTelegramAlert } from '../utils/telegramAlert'
import { queueRuntimeConfig } from '../queue/runtime'
import { connectionOptions } from '../queue/connection'
import { windowCounterStore } from '../utils/windowCounterRedis'

// Еженедельная сводка по неразобранным отзывам (#466). Разбор сам по себе делает человек (или
// агент разбора) — здесь только напоминание о том, что разбирать есть что.
//
// ⚠ Только на cron-экземпляре: реплики воркера прислали бы по копии сводки каждая.
// ⚠ Свой чат, а не чат тревог (решение владельца): «сервис сломан» и «накопились отзывы» — разные
// поводы разбудить, и в одном чате второе приучает не читать первое.

const HOUR_MS = 60 * 60 * 1000
/**
 * Как часто проверяем, не пора ли. Сам ПРОГОН отсечён календарной неделей в Redis — тик лишь
 * даёт поводу наступить. Часовой тик выбран потому, что контейнер перекатывается по десятку раз
 * в день: недельный `setInterval` не дожил бы до срабатывания ни разу (тот же дефект, что чинили
 * в чистке отзывов, — механизм существует и не выполняется, и это ненаблюдаемо).
 */
const TICK_MS = HOUR_MS
/** Первый тик — не мгновенно: пачка перевыкатов подряд не должна давать пачку обращений. */
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000

export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  if (!queueRuntimeConfig().cron) return
  const config = resolveFeedbackConfig()
  if (!config) return
  // Свой чат. Fail-closed: наполовину настроенный канал молча терял бы каждую сводку, а заметить
  // это можно было бы только по её отсутствию — то есть по тому же молчанию, которое сводка и
  // должна была бы объяснить.
  const telegram = resolveTelegramConfig(process.env, {
    token: 'TELEGRAM_DIGEST_BOT_TOKEN',
    chatId: 'TELEGRAM_DIGEST_CHAT_ID'
  })
  if (!telegram) {
    console.info('[feedback-digest] канал сводки не настроен — сводка не шлётся')
    return
  }

  const counter = windowCounterStore(connectionOptions())
  if (!counter) {
    // ⚠ Без Redis отсечка держится только памятью процесса: при часовом тике и перекатах
    // контейнера по десятку раз в день это заметно чаще недельного намерения. Говорим вслух —
    // молчаливая деградация здесь читалась бы как исправная работа.
    console.warn('[feedback-digest] нет Redis: отсечка недели только в памяти процесса — после перезапуска сводка придёт снова')
  }
  const fetchImpl = globalThis.fetch as typeof fetch

  const runDigest = createDigestRunner({
    listIssues: () => listOpenFeedbackIssues(config, fetchImpl),
    send: async (text) => {
      const r = await sendTelegramAlert(telegram, text, fetchImpl)
      if (!r.ok) console.warn(`[feedback-digest] сводка не доставлена: status=${r.status}`)
      return r.ok
    },
    claimAttempt: key => counter ? counter.incrWithTtl(key, DIGEST_COUNTER_TTL_SEC).catch(() => null) : Promise.resolve(null),
    issuesUrl: feedbackIssuesUrl(config.repo),
    now: () => Date.now(),
    log: m => console.warn(`[feedback-digest] ${m}`)
  })

  const run = async () => {
    try {
      const r = await runDigest()
      // Строка пишется на КАЖДОМ исходе: иначе «неделя уже отправлена», «Redis не отвечает» и
      // «GitHub молчит» выглядят одинаково пустым журналом, а различать их — весь смысл канала.
      console.info(`[feedback-digest] ${r.sent ? `отправлено=${r.delivered}` : `пропуск: ${r.skipped}`}`)
    } catch {
      // Текст ошибки в журнал не идёт: у undici туда попадает адрес запроса с токеном.
      console.error('[feedback-digest] сбой прогона')
    }
  }

  console.info('[feedback-digest] еженедельная сводка включена')
  setTimeout(() => void run(), FIRST_RUN_DELAY_MS).unref?.()
  setInterval(() => void run(), TICK_MS).unref?.()
})
