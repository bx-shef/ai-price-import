import { feedbackFileDir } from '~/utils/feedback'

// Чистое ядро чистки отзывов (#417). Транспорт — `feedbackGithubAdmin.ts`, расписание — плагин.
//
// П. 8.6 Политики: отзыв (текст, технический контекст и приложенный документ) хранится не более
// 12 месяцев с даты поступления либо до удаления по обращению клиента. Срок в документе без
// механизма — невыполняемое обязательство: закрытая задача с накладной внутри хранится ровно так
// же, как открытая, поэтому «закрыть» — не чистка.
//
// ⚠ Стирание идёт ЦЕЛИКОМ, а не редактированием тела. Правка тела оставляет прежний текст в
// истории правок задачи (GitHub её показывает всем, у кого есть доступ), то есть выглядит как
// удаление, не будучи им. Поэтому задача удаляется вместе с комментариями. Редактирование
// остаётся ТОЛЬКО как деградация, когда удалять нечем (см. `redactIssue`).
//
// ⚠ Пути приложенных файлов берутся ЛИСТИНГОМ каталога, а не разбором тела задачи. Первая
// редакция вытаскивала их регуляркой из тела — и это было неверно сразу тремя способами: в тело
// попадает свободный текст сотрудника, поэтому чужой ссылкой в комментарии можно было добиться
// удаления документа ДРУГОГО портала; длинная ссылка обрезается по капу контекстного поля, и
// обрезанный путь давал 404, который считался успехом (задача стёрта, документ цел); а если
// ссылки в теле не оказалось вовсе, документ становился недостижим навсегда. Каталог знает
// правду о том, что в нём лежит.
//
// ⚠ Остаточный риск назван вслух и НЕ закрывается кодом: приложенные документы попадают в
// приёмник коммитами, поэтому удаление файла убирает его из текущего состояния ветки, но не из
// истории git — содержимое остаётся доступно по хэшу объекта. Настоящее стирание требует
// переписывания истории и делается владельцем руками (см. PROCESS.md §6.12).

/** Задача-отзыв в приёмнике: ровно те поля, что нужны для решения. */
export interface FeedbackIssueRef {
  number: number
  /** GraphQL node id — им удаляется задача (у REST метода удаления нет). */
  nodeId: string
  /** ISO-дата создания (GitHub `created_at`). */
  createdAt: string
  /** Заголовок — по нему сверяется, что задача наша. */
  title: string
  /** Тело задачи — из него берётся идентификатор задания. */
  body: string
  /** Метки задачи — в них лежит псевдоним портала. */
  labels: string[]
}

export interface RetentionPlanItem {
  issue: FeedbackIssueRef
  /** Каталог файлов задачи в приёмнике, `null` — задание не опознано (файлов у задачи нет). */
  dir: string | null
}

/** Граница хранения: всё, что создано СТРОГО раньше, подлежит стиранию. */
export function retentionCutoff(nowMs: number, months: number): Date {
  const d = new Date(nowMs)
  d.setUTCMonth(d.getUTCMonth() - months)
  return d
}

/**
 * Просрочен ли отзыв.
 *
 * Отдельный предикат, а не выражение внутри фильтра, и это по итогам мутационной проверки: снятие
 * `Number.isFinite` не роняло НИ одного теста, потому что `NaN < cutoff` и так `false` — то есть
 * тест «нечитаемая дата не стирается» сторожил свойство сравнений с NaN, а не наш код.
 */
export function isDue(createdAt: string, cutoffMs: number): boolean {
  const t = Date.parse(createdAt)
  // Нечитаемая дата — НЕ стираем. Цена ошибки несимметрична: пропущенный отзыв догонит следующий
  // прогон, а стёртый по мусорной дате не вернётся.
  if (!Number.isFinite(t)) return false
  return t < cutoffMs
}

/**
 * Срок хранения (месяцы) из env. Отсутствует/мусор → 12 (п. 8.6 Политики).
 * Кламп [1, 12] — ВЕРХНЯЯ граница жёсткая: опечатка не вправе продлить хранение сверх обещанного
 * в опубликованном документе, а вот сократить его — можно, это в пользу клиента.
 */
export function resolveRetentionMonths(raw: string | undefined, fallback = 12): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(12, Math.max(1, Math.floor(n)))
}

/** Кусок заголовка наших задач-отзывов (`buildFeedbackIssue`), общий для обеих оценок. */
export const FEEDBACK_TITLE_MARK = 'Отзыв сотрудника'

/** Псевдоним портала из меток задачи, `null` — метки нет. */
export function portalTagOf(i: FeedbackIssueRef): string | null {
  for (const l of i.labels) {
    const m = /^portal:([0-9a-f]{12})$/.exec(l)
    if (m) return m[1]!
  }
  return null
}

/**
 * Наша ли это задача.
 *
 * ⚠ Проверяются ТРИ признака: метка канала, наш заголовок и псевдоним портала. Удаление
 * необратимо, а приёмник задаётся переменной окружения — опечатка в `GITHUB_FEEDBACK_REPO` могла
 * бы навести чистку на публичный репозиторий проекта, где метка `user-feedback` живёт по той же
 * конвенции. Совпадения всех трёх признаков разом там не будет.
 */
export function isOwnFeedbackIssue(i: FeedbackIssueRef): boolean {
  if (!i.labels.includes('user-feedback')) return false
  if (!i.title.includes(FEEDBACK_TITLE_MARK)) return false
  return portalTagOf(i) !== null
}

/** Идентификатор задания из тела задачи (строка «Задача (jobId)»), `null` — нет. */
export function jobIdOf(body: string): string | null {
  const m = /Задача \(jobId\):\*\*\s*`([^`]+)`/.exec(String(body ?? ''))
  if (!m) return null
  // Санитайзер тот же, что при записи (`feedbackFileDir`): из тела приходит текст, а не путь.
  const id = m[1]!.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)
  return id || null
}

/** Каталог файлов задачи, `null` — задание не опознано (значит, и файлов у неё не было). */
export function issueFileDir(i: FeedbackIssueRef): string | null {
  const tag = portalTagOf(i)
  const job = jobIdOf(i.body)
  if (!tag || !job) return null
  return feedbackFileDir(tag, job)
}

/**
 * План чистки: какие задачи стереть и из какого каталога удалить их файлы.
 *
 * ⚠ Кап на прогон обязателен. Приёмник мультитенантный, а вторичные лимиты GitHub считаются по
 * токену издателя (≈500 операций с содержимым в час): разовая чистка накопившегося за год без
 * капа упёрлась бы в них и оборвалась на середине — половина стёрта, половина нет, и по какому
 * месту оборвалось, из журнала не видно. С капом чистка идёт хвостом вперёд и доходит за
 * несколько суточных прогонов.
 */
export function planFeedbackRetention(issues: FeedbackIssueRef[], nowMs: number, months = 12, maxPerRun = 50): RetentionPlanItem[] {
  const cutoff = retentionCutoff(nowMs, months).getTime()
  return issues
    .filter(i => isOwnFeedbackIssue(i) && isDue(i.createdAt, cutoff))
    // Старые вперёд: если прогон обрежется капом, обязаны уйти самые просроченные.
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(1, maxPerRun))
    .map(issue => ({ issue, dir: issueFileDir(issue) }))
}

export interface RetentionDeps {
  /** Самые старые задачи приёмника (или `null` — не прочитали). */
  list: (limit: number) => Promise<FeedbackIssueRef[] | null>
  /** Файлы каталога (или `null` — не прочитали; пустой массив — каталога/файлов нет). */
  listDir: (dir: string) => Promise<string[] | null>
  deleteFile: (path: string) => Promise<boolean>
  deleteIssue: (nodeId: string) => Promise<boolean>
  /**
   * Деградация: обезличить и закрыть задачу, сняв метку канала.
   *
   * ⚠ Нужна потому, что удаление задачи в GitHub требует АДМИНСКИХ прав на репозиторий, а каналу
   * отзывов хватало «создать задачу + положить файл». Без деградации первый же прогон на токене с
   * обычными правами удалял бы документы, оставлял задачи и на следующие сутки читал бы ровно те
   * же пятьдесят самых старых: чистка не сдвинулась бы НИКОГДА, вечно рапортуя об отказах.
   * ⚠ Это ХУЖЕ удаления — прежний текст остаётся в истории правок задачи. Поэтому только запасной
   * путь, и о нём отдельно сообщается оператору.
   */
  redactIssue: (i: FeedbackIssueRef) => Promise<boolean>
  now: () => number
}

export interface RetentionRun {
  /** Прочитано задач (`null` — приёмник недоступен). */
  read: number | null
  /** Просрочено по плану. */
  due: number
  /** Стёрто задач целиком. */
  erased: number
  /** Обезличено вместо удаления (нет прав) — деградация, а не успех. */
  redacted: number
  /** Удалено файлов. */
  files: number
  /** Не удалось — повод для тревоги, а не для тишины. */
  failed: number
}

/**
 * Прогон чистки: прочитать самые старые задачи, отобрать просроченные, удалить их файлы и сами
 * задачи.
 *
 * ⚠ Порядок «сначала файлы, потом задача» обязателен: каталог файлов вычисляется из МЕТКИ и ТЕЛА
 * задачи, и стерев её первой, мы потеряли бы единственный способ найти приложенный документ — он
 * остался бы в приёмнике навсегда и уже без следа. Каталог не прочитан или файл не удалился —
 * задачу тоже не трогаем.
 */
export async function runFeedbackRetention(deps: RetentionDeps, months = 12, maxPerRun = 50): Promise<RetentionRun> {
  const issues = await deps.list(Math.min(100, Math.max(1, maxPerRun)))
  if (!issues) return { read: null, due: 0, erased: 0, redacted: 0, files: 0, failed: 0 }
  const plan = planFeedbackRetention(issues, deps.now(), months, maxPerRun)
  const run: RetentionRun = { read: issues.length, due: plan.length, erased: 0, redacted: 0, files: 0, failed: 0 }
  for (const item of plan) {
    if (item.dir) {
      const paths = await deps.listDir(item.dir)
      if (!paths) {
        // Не прочитали каталог — не знаем, лежит ли там документ. Задачу не трогаем.
        run.failed++
        continue
      }
      let filesOk = true
      for (const path of paths) {
        if (await deps.deleteFile(path)) run.files++
        else filesOk = false
      }
      if (!filesOk) {
        run.failed++
        continue
      }
    }
    if (await deps.deleteIssue(item.issue.nodeId)) run.erased++
    else if (await deps.redactIssue(item.issue)) run.redacted++
    else run.failed++
  }
  return run
}
