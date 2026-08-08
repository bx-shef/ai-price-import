import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { listOpenFeedbackIssues } from '../utils/feedbackGithubAdmin'
import { buildDigestText, isoWeekKey, summarizeFeedbackIssues } from '../utils/feedbackDigest'
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
  const fetchImpl = globalThis.fetch as typeof fetch
  let running = false

  const claimWeek = async (key: string): Promise<boolean> => {
    if (!counter) return true
    const n = await counter.incrWithTtl(key, 8 * 24 * 3600).catch(() => null)
    // Redis не ответил — шлём: пропущенная сводка хуже лишней.
    return n === null || n <= 1
  }

  const run = async () => {
    if (running) return
    running = true
    try {
      if (!await claimWeek(`feedback-digest:${isoWeekKey(new Date())}`)) return
      const read = await listOpenFeedbackIssues(config, fetchImpl)
      // ⚠ `null` доезжает до текста КАК ОТДЕЛЬНЫЙ ИСХОД, а не подменяется нулями: нечитаемый
      // приёмник и пустой приёмник дали бы одинаковую сводку, и авария канала выглядела бы
      // спокойной неделей.
      const stats = read ? summarizeFeedbackIssues(read.issues, Date.now()) : null
      let text = buildDigestText(stats)
      if (read?.truncated) text += '\n⚠️ Список обрезан — отзывов больше, чем показано.'
      console.info(`[feedback-digest] открытых=${stats?.open ?? 'нет данных'}`)
      const r = await sendTelegramAlert(telegram, text, fetchImpl)
      if (!r.ok) console.warn(`[feedback-digest] сводка не доставлена: status=${r.status}`)
    } catch {
      // Текст ошибки в журнал не идёт: у undici туда попадает адрес запроса с токеном.
      console.error('[feedback-digest] сбой прогона')
    } finally {
      running = false
    }
  }

  console.info('[feedback-digest] еженедельная сводка включена')
  setTimeout(() => void run(), FIRST_RUN_DELAY_MS).unref?.()
  setInterval(() => void run(), TICK_MS).unref?.()
})
