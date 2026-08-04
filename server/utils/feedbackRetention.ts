// Чистое ядро чистки отзывов (#417). Транспорт — `feedbackGithubAdmin.ts`, расписание — плагин.
//
// П. 8.6 Политики: отзыв (текст, технический контекст и приложенный документ) хранится не более
// 12 месяцев с даты поступления либо до удаления по обращению клиента. Срок в документе без
// механизма — невыполняемое обязательство: закрытая задача с накладной внутри хранится ровно так
// же, как открытая, поэтому «закрыть» — не чистка.
//
// ⚠ Стирание идёт ЦЕЛИКОМ, а не редактированием тела. Правка тела оставляет прежний текст в
// истории правок задачи (GitHub её показывает всем, у кого есть доступ), то есть выглядит как
// удаление, не будучи им. Поэтому задача удаляется вместе с комментариями — это единственная
// операция GitHub с нужным смыслом.
//
// ⚠ Остаточный риск назван вслух и НЕ закрывается кодом: приложенные документы попадают в
// приёмник коммитами (`files/<jobId>/<имя>`), поэтому удаление файла убирает его из текущего
// состояния ветки, но не из истории git — содержимое остаётся доступно по хэшу объекта. Настоящее
// стирание требует переписывания истории и делается владельцем руками (см. PROCESS.md).

/** Задача-отзыв в приёмнике: ровно те поля, что нужны для решения. */
export interface FeedbackIssueRef {
  number: number
  /** GraphQL node id — им удаляется задача (у REST метода удаления нет). */
  nodeId: string
  /** ISO-дата создания (GitHub `created_at`). */
  createdAt: string
  /** Тело задачи — из него достаются пути приложенных файлов. */
  body: string
}

export interface RetentionPlanItem {
  issue: FeedbackIssueRef
  /** Пути файлов в приёмнике, которые надо удалить вместе с задачей. */
  files: string[]
}

/** Граница хранения: всё, что создано СТРОГО раньше, подлежит стиранию. */
export function retentionCutoff(nowMs: number, months: number): Date {
  const d = new Date(nowMs)
  d.setUTCMonth(d.getUTCMonth() - months)
  return d
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

/**
 * Пути приложенных файлов из тела задачи.
 *
 * В теле стоит ссылка на блоб приёмника (строка «Исходный файл»), а путь внутри неё — после
 * `/blob/<ветка>/`. Берём только пути под `files/`: это наш собственный префикс
 * (`feedbackFilePath`), и он же не даёт удалить из приёмника что-нибудь постороннее, если в
 * комментарии окажется чужая ссылка.
 *
 * ⚠ Разбор идёт по ССЫЛКЕ, а не по имени задачи: имя файла в теле выведено отдельной строкой и
 * могло быть переписано человеком, а ссылка ведёт ровно туда, куда файл положили.
 */
export function attachedFilePaths(body: string): string[] {
  const out = new Set<string>()
  for (const m of String(body ?? '').matchAll(/\/blob\/[^/\s]+\/(files\/[A-Za-z0-9._/-]+)/g)) {
    const p = m[1]!
    // Ни `..`, ни хвостовой слэш: путь уходит в адрес запроса на удаление.
    if (!p.includes('..') && !p.endsWith('/')) out.add(p)
  }
  return [...out]
}

/**
 * План чистки: какие задачи стереть и какие файлы удалить вместе с ними.
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
    .filter((i) => {
      const t = Date.parse(i.createdAt)
      // Нечитаемая дата — НЕ стираем. Цена ошибки несимметрична: пропущенный на неделю отзыв
      // исправится следующим прогоном, а стёртый по мусорной дате не вернётся.
      return Number.isFinite(t) && t < cutoff
    })
    // Старые вперёд: если прогон обрежется капом, обязаны уйти самые просроченные.
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, Math.max(1, maxPerRun))
    .map(issue => ({ issue, files: attachedFilePaths(issue.body) }))
}

export interface RetentionDeps {
  /** Самые старые задачи приёмника (или `null` — не прочитали). */
  list: (limit: number) => Promise<FeedbackIssueRef[] | null>
  deleteIssue: (nodeId: string) => Promise<boolean>
  deleteFile: (path: string) => Promise<boolean>
  now: () => number
}

export interface RetentionRun {
  /** Прочитано задач (null у `read` — приёмник недоступен). */
  read: number | null
  /** Просрочено по плану. */
  due: number
  /** Стёрто задач. */
  erased: number
  /** Удалено файлов. */
  files: number
  /** Не удалось стереть — повод для тревоги, а не для тишины. */
  failed: number
}

/**
 * Прогон чистки: прочитать самые старые задачи, отобрать просроченные, удалить их файлы и сами
 * задачи.
 *
 * ⚠ Порядок «сначала файлы, потом задача» обязателен: пути файлов записаны В ТЕЛЕ задачи, и
 * стерев её первой, мы потеряли бы единственную ссылку на приложенный документ — он остался бы в
 * приёмнике навсегда, причём уже без всякого следа, по которому его можно найти. Файл не удалился —
 * задачу тоже не трогаем по той же причине.
 */
export async function runFeedbackRetention(deps: RetentionDeps, months = 12, maxPerRun = 50): Promise<RetentionRun> {
  const issues = await deps.list(Math.min(100, Math.max(1, maxPerRun)))
  if (!issues) return { read: null, due: 0, erased: 0, files: 0, failed: 0 }
  const plan = planFeedbackRetention(issues, deps.now(), months, maxPerRun)
  let erased = 0
  let files = 0
  let failed = 0
  for (const item of plan) {
    let filesOk = true
    for (const path of item.files) {
      if (await deps.deleteFile(path)) files++
      else filesOk = false
    }
    if (!filesOk) {
      failed++
      continue
    }
    if (await deps.deleteIssue(item.issue.nodeId)) erased++
    else failed++
  }
  return { read: issues.length, due: plan.length, erased, files, failed }
}
