import { QUEUES, type QueueName } from './topology'
import { portalHash } from '../utils/telemetryAttributes'

// Список упавших задач для операторской консоли (#271-B). Раньше на экране было только число
// «ошибки: N», провалиться в которое было нельзя: ни причины, ни времени, ни возможности повторить.
// А это первое, ради чего консоль вообще открывают.
//
// Чистое ядро с DI над читателем — живой оборачивает BullMQ `getFailed`.

/** Одна упавшая задача так, как её видит оператор. */
export interface FailedJobView {
  queue: string
  /** Идентификатор задачи в очереди — по нему же идут «повторить»/«отбросить». */
  id: string
  /** Причина отказа, как её сохранила очередь. */
  reason: string
  /** Когда упала (мс), если очередь это сохранила. */
  failedAt: number | null
  /** Сколько попыток было сделано. */
  attempts: number
  /**
   * Необратимый отпечаток портала, чьё это задание (#498).
   *
   * ⚠ Именно ОТПЕЧАТОК, а не домен и не member_id: экран оператора открывается с обычного рабочего
   * места, и складывать туда идентификаторы порталов клиентов незачем — для «сорок отказов у одного
   * и того же» достаточно различимости. `unknown` — задание без портала в пакете.
   */
  portal: string
}

/** Сырая строка BullMQ, из которой мы берём только нужное. */
export interface RawFailedJob {
  id?: string | number | null
  failedReason?: string | null
  finishedOn?: number | null
  processedOn?: number | null
  attemptsMade?: number | null
  /** Пакет задачи. Нужен ровно ради `memberId` — по нему считается отпечаток портала. */
  data?: { memberId?: unknown } | null
}

/** Прочитать упавшие задачи одной очереди (или пусто, если очередь недоступна). */
export type FailedReader = (name: QueueName, limit: number) => Promise<RawFailedJob[]>

/** Сколько строк максимум отдаём на очередь. Консоль — не архив: смотреть нужно свежие. */
export const MAX_FAILED_PER_QUEUE = 25

/**
 * Причину режем: в неё попадает ответ портала, а иногда и текст из документа. На экране оператора
 * это допустимо, но простыня в списке нечитаема, да и раздувать ответ незачем.
 */
export const MAX_REASON_LEN = 300

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Привести сырую строку очереди к виду для экрана. `null` — строка без идентификатора, её пропускаем. */
export function toFailedView(queue: string, raw: RawFailedJob): FailedJobView | null {
  const id = raw?.id == null ? '' : String(raw.id)
  if (!id) return null
  const reason = (raw.failedReason ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LEN)
  return {
    queue,
    id,
    reason: reason || 'Причина не сохранилась',
    failedAt: num(raw.finishedOn) ?? num(raw.processedOn),
    attempts: num(raw.attemptsMade) ?? 0,
    portal: portalHash(typeof raw?.data?.memberId === 'string' ? raw.data.memberId : '')
  }
}

/**
 * Собрать упавшие задачи по всем очередям конвейера. Порядок очередей стабильный, внутри — как
 * отдаёт очередь (свежие первыми). Отказ одной очереди не роняет весь список: оператор должен
 * увидеть то, что доступно, а не пустой экран.
 */
export async function readFailedJobs(
  reader: FailedReader,
  limit = MAX_FAILED_PER_QUEUE
): Promise<{ jobs: FailedJobView[], unavailable: string[] }> {
  // Нижняя граница обязательна: очередь читается диапазоном [0, limit-1], и limit=0 превратился бы
  // в [0,-1] — «весь хвост», то есть вычитывание всех упавших задач ради пустого результата.
  if (!Number.isFinite(limit) || limit <= 0) return { jobs: [], unavailable: [] }
  const jobs: FailedJobView[] = []
  const unavailable: string[] = []
  for (const name of Object.values(QUEUES) as QueueName[]) {
    let rows: RawFailedJob[]
    try {
      rows = await reader(name, limit)
    } catch {
      // Отказ чтения — НЕ то же самое, что «ошибок нет»: иначе экран уверенно объяснил бы пустоту
      // сроком хранения, хотя на деле недоступен Redis. Сообщаем отдельно.
      unavailable.push(name)
      continue
    }
    for (const raw of Array.isArray(rows) ? rows.slice(0, limit) : []) {
      const view = toFailedView(name, raw)
      if (view) jobs.push(view)
    }
  }
  return { jobs, unavailable }
}

/** Действия оператора над упавшей задачей. */
export type FailedAction = 'retry' | 'discard'

/** Валидное ли имя очереди. Имя приходит из браузера — по нему нельзя дотянуться до чужого ключа. */
export function isKnownQueue(name: unknown): name is QueueName {
  return typeof name === 'string' && (Object.values(QUEUES) as string[]).includes(name)
}

/** Валидное ли действие. */
export function isFailedAction(v: unknown): v is FailedAction {
  return v === 'retry' || v === 'discard'
}

/**
 * Форма идентификатора задачи. Проверять обязательно: очередь адресует задачу ключом
 * `bull:<очередь>:<id>`, поэтому `id` вроде `meta` или `id` указывает не на задачу, а на служебный
 * ключ самой очереди — и «Отбросить» снёс бы её метаданные. Имя очереди мы сверяем со списком ровно
 * от этого класса ошибок; идентификатор без такой же проверки оставлял дыру открытой.
 *
 * Наши идентификаторы строит `makeJobId` (`<стадия>|<портал>|<uuid>`), поэтому набор символов узкий.
 */
const JOB_ID_SHAPE = /^[A-Za-z0-9_.|-]{1,200}$/
/** Служебные ключи очереди, которые никогда не являются задачей. */
const RESERVED_IDS = new Set(['meta', 'id', 'events', 'stalled-check', 'limiter', 'delay', 'pc'])

export function isSafeJobId(v: unknown): v is string {
  return typeof v === 'string' && JOB_ID_SHAPE.test(v) && !RESERVED_IDS.has(v)
}

/** Что роут должен сделать с запросом действия — решение без ввода-вывода. */
export type FailedActionDecision
  = | { status: 401 }
    | { status: 400 }
    | { status: 200, queue: QueueName, id: string, action: FailedAction }

/**
 * Решение по запросу «повторить/отбросить». Вынесено из роута, чтобы проверялась ПРОВОДКА, а не
 * только валидаторы по отдельности: снятие любой из проверок в роуте иначе не роняло ни одного теста.
 */
export function decideFailedAction(authorized: boolean, body: unknown): FailedActionDecision {
  if (!authorized) return { status: 401 }
  const b = (body ?? {}) as { queue?: unknown, id?: unknown, action?: unknown }
  if (!isKnownQueue(b.queue) || !isFailedAction(b.action) || !isSafeJobId(b.id)) return { status: 400 }
  return { status: 200, queue: b.queue, id: b.id, action: b.action }
}
