import { resolveFeedbackConfig } from '../utils/feedbackConfig'
import { deleteFeedbackFile, deleteFeedbackIssue, listFeedbackDir, listOldestFeedbackIssues, redactFeedbackIssue } from '../utils/feedbackGithubAdmin'
import { feedbackUploadAllowed } from '../utils/feedbackRepoPrivacy'
import { resolveRetentionMonths, runFeedbackRetention } from '../utils/feedbackRetention'
import { resolveTelegramConfig, sendTelegramAlert } from '../utils/telegramAlert'
import { queueRuntimeConfig } from '../queue/runtime'

// Суточная чистка приёмника отзывов (#417): стереть отзывы старше срока из п. 8.6 Политики.
//
// ⚠ Только на cron-экземпляре. Реплики воркера подняли бы ту же чистку каждая: лишние обращения к
// GitHub под одним токеном издателя (вторичные лимиты считаются по нему) и ложные тревоги —
// вторая реплика получала бы отказ на уже стёртой задаче и рапортовала бы о сбое необратимой
// операции.
//
// ⚠ Канал выключен (нет токена/приёмника) — плагин молчит. Отзывов в этом случае нет вовсе, и
// «чистка не настроена» было бы тревогой о несуществующем.

const DAY_MS = 24 * 60 * 60 * 1000
/** Кап на прогон: см. `planFeedbackRetention` — вторичные лимиты GitHub. */
const MAX_PER_RUN = 50
/**
 * Задержка первого прогона.
 *
 * ⚠ Прогон на старте ОБЯЗАТЕЛЕН, и это правка по итогам разбора. Раньше стоял голый суточный
 * таймер «чтобы не ходить в GitHub на каждый выкат» — но выкаты в этом проекте идут по десятку в
 * день, Watchtower перезапускает контейнер на каждый, и суточный таймер не доживал до срабатывания
 * ни разу. Механизм существовал, не выполнившись ни одного раза, и это было ненаблюдаемо: в
 * журнале пусто, тревог нет, «чистить нечего» и «не запускались» выглядят одинаково.
 *
 * Пауза в несколько минут снимает исходное возражение: пачка перевыкатов подряд не превращается в
 * пачку обращений к GitHub, потому что процесс столько не живёт.
 */
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000

export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  if (!queueRuntimeConfig().cron) return
  const config = resolveFeedbackConfig()
  if (!config) return

  const months = resolveRetentionMonths(process.env.FEEDBACK_RETENTION_MONTHS)
  const fetchImpl = globalThis.fetch as typeof fetch
  const telegram = resolveTelegramConfig()
  // Одно сообщение на поломку, а не на прогон: суточный повтор одного и того же — это канал,
  // который перестают читать. Пустая строка = всё хорошо.
  let announced = ''
  let running = false

  // ⚠ В тревогу идёт только ФАКТ и счётчики. Ни номера задачи, ни тела, ни имени файла, ни слага
  // приёмника: канал тревог заведён для «сервис сломан», а содержимое отзыва — данные клиента.
  const announce = async (key: string, text: string) => {
    if (announced === key) return
    announced = key
    if (!telegram) return
    try {
      await sendTelegramAlert(telegram, `⚠️ Чистка отзывов: ${text}`, fetchImpl)
    } catch { /* тревога о тревоге не нужна */ }
  }
  const recovered = async () => {
    if (!announced) return
    announced = ''
    if (!telegram) return
    try {
      await sendTelegramAlert(telegram, '✅ Чистка отзывов снова работает', fetchImpl)
    } catch { /* см. выше */ }
  }

  const run = async () => {
    // Прогон длиннее суток невозможен по построению (кап 50), но наложение всё равно исключаем:
    // зависший запрос к GitHub иначе дал бы два конкурирующих удаления.
    if (running) return
    running = true
    try {
      // ⚠ Гейт приватности стоит ПЕРЕД разрушительными действиями, а не только перед загрузкой
      // байт (#200). Приёмник задаётся переменной окружения, и опечатка навела бы необратимое
      // удаление на чужой репозиторий. Проверка «не удалось» и «репозиторий публичный» одинаково
      // запрещают — как и при загрузке.
      if (!await feedbackUploadAllowed(config, fetchImpl)) {
        await announce('privacy', 'приёмник не подтверждён приватным — чистка не выполнялась')
        return
      }
      const r = await runFeedbackRetention({
        list: limit => listOldestFeedbackIssues(config, limit, fetchImpl),
        listDir: dir => listFeedbackDir(config, dir, fetchImpl),
        deleteFile: path => deleteFeedbackFile(config, path, fetchImpl),
        deleteIssue: id => deleteFeedbackIssue(config, id, fetchImpl),
        redactIssue: i => redactFeedbackIssue(config, i.number, fetchImpl),
        now: () => Date.now()
      }, months, MAX_PER_RUN)

      if (r.read === null) {
        // Приёмник не прочитан — это НЕ «нечего чистить». Молча не работающий регламент хуже
        // отсутствующего: срок в опубликованном документе продолжает идти, а исполнять его нечем.
        await announce('unreadable', 'приёмник отзывов недоступен — чистка не выполнена')
        return
      }
      // Строка пишется КАЖДЫЙ прогон, в том числе пустой: иначе «работает штатно, чистить нечего»
      // и «плагин вообще не поднялся» в журнале неотличимы, а у этого регламента есть срок.
      console.info(`[feedback-retention] прочитано=${r.read} просрочено=${r.due} стёрто=${r.erased} обезличено=${r.redacted} файлов=${r.files} не удалось=${r.failed}`)

      if (r.failed) {
        await announce('failed', `не удалось стереть отзывов: ${r.failed} из ${r.due}`)
      } else if (r.redacted) {
        // Деградация — не успех: у токена нет прав на удаление задач, и прежний текст остаётся в
        // истории правок. Об этом обязаны сказать, иначе «работает» будет означать полумеру.
        await announce('redacted', `нет прав на удаление задач — ${r.redacted} обезличено вместо удаления (текст остаётся в истории правок)`)
      } else {
        await recovered()
      }
    } catch {
      // ⚠ Текст ошибки в журнал НЕ идёт: у undici в него попадает адрес запроса. Образец — тот же,
      // что в `feedbackGithub.ts`: наружу отдаётся факт, не сообщение.
      console.error('[feedback-retention] сбой прогона')
      await announce('crashed', 'чистка отзывов упала с ошибкой')
    } finally {
      running = false
    }
  }

  console.info(`[feedback-retention] чистка включена: срок ${months} мес., первый прогон через ${Math.round(FIRST_RUN_DELAY_MS / 60000)} мин`)
  setTimeout(() => void run(), FIRST_RUN_DELAY_MS).unref?.()
  setInterval(() => void run(), DAY_MS).unref?.()
})
