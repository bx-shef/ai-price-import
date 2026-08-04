import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { deleteFeedbackFile, deleteFeedbackIssue, listOldestFeedbackIssues } from '../utils/feedbackGithubAdmin'
import { resolveRetentionMonths, runFeedbackRetention } from '../utils/feedbackRetention'
import { resolveTelegramConfig, sendTelegramAlert } from '../utils/telegramAlert'
import { queueRuntimeConfig } from '../queue/runtime'

// Суточная чистка приёмника отзывов (#417): стереть отзывы старше срока из п. 8.6 Политики.
//
// ⚠ Только на cron-инстансе. Реплики воркера подняли бы ту же чистку каждая: лишние обращения к
// GitHub под одним токеном издателя (вторичные лимиты считаются по нему) и гонка на удалении —
// вторая реплика получала бы отказы на уже стёртых задачах и рапортовала бы о сбое.
//
// ⚠ Канал выключен (нет токена/приёмника) — плагин молчит. Отзывов в этом случае нет вовсе, и
// «чистка не настроена» было бы тревогой о несуществующем.

const DAY_MS = 24 * 60 * 60 * 1000
/** Кап на прогон: см. `planFeedbackRetention` — вторичные лимиты GitHub. */
const MAX_PER_RUN = 50

export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  if (!queueRuntimeConfig().cron) return
  const config = resolveFeedbackConfig()
  if (!config) return

  const months = resolveRetentionMonths(process.env.FEEDBACK_RETENTION_MONTHS)
  const fetchImpl = globalThis.fetch as typeof fetch
  const telegram = resolveTelegramConfig()

  const run = async () => {
    try {
      const r = await runFeedbackRetention({
        list: limit => listOldestFeedbackIssues(config, limit, fetchImpl),
        deleteIssue: id => deleteFeedbackIssue(config, id, fetchImpl),
        deleteFile: path => deleteFeedbackFile(config, path, fetchImpl),
        now: () => Date.now()
      }, months, MAX_PER_RUN)

      if (r.read === null) {
        // Приёмник не прочитан — это НЕ «нечего чистить». Молча не работающий регламент хуже
        // отсутствующего: срок в опубликованном документе продолжает идти, а исполнять его нечем.
        await warn('приёмник отзывов недоступен — чистка не выполнена')
        return
      }
      if (r.erased || r.files || r.failed) {
        console.info(`[feedback-retention] стёрто=${r.erased} файлов=${r.files} не удалось=${r.failed} просрочено=${r.due}`)
      }
      if (r.failed) await warn(`не удалось стереть отзывов: ${r.failed} (просрочено ${r.due})`)
    } catch (e) {
      console.error('[feedback-retention] сбой:', e instanceof Error ? e.message : e)
      await warn('чистка отзывов упала с ошибкой')
    }
  }

  // ⚠ В тревогу идёт только ФАКТ и счётчики. Ни номера задачи, ни тела, ни имени файла: канал
  // тревог заведён для «сервис сломан», а содержимое отзыва — данные клиента.
  const warn = async (text: string) => {
    if (!telegram) return
    try {
      await sendTelegramAlert(telegram, `⚠️ Чистка отзывов: ${text}`, fetchImpl)
    } catch { /* тревога о тревоге не нужна */ }
  }

  // Не на старте: развёртывание перезапускает процесс, и чистка ходила бы в GitHub на каждый
  // выкат. Просрочка на сутки ничего не решает — срок годовой.
  setInterval(() => void run(), DAY_MS).unref?.()
})
