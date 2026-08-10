import {
  buildPortalFailureMessage,
  portalNoticeKey,
  portalsNeedingAttention,
  summarisePortalFailures,
  type PortalFailureSummary,
  type RawPortalFailure
} from './portalFailureWatch'

/**
 * Прогон наблюдения за порталами с падающими импортами (#498) — ЧИСТОЕ ядро с внедрёнными
 * зависимостями.
 *
 * Почему не тело плагина: разбор #466 показал ровно на этом месте, что решение, живущее в плагине,
 * не проверяет НИ ОДИН тест, и мутация «слать всегда» проходит весь прогон при зелёном CI. Здесь
 * цена такой мутации выше: сообщение уйдёт на каждый тик, то есть каждые пять минут.
 */

/** Отсечка живёт чуть дольше суток: ключ обязан пережить свой день целиком, но не следующий. */
export const PORTAL_NOTICE_TTL_SEC = 30 * 3600

export interface PortalFailureRunDeps {
  /**
   * Упавшие задачи записи в CRM, свежие первыми; `null` — очередь не прочитана.
   *
   * ⚠ Различие «не прочитали» и «отказов нет» несущее: на нечитаемой очереди молчать правильно
   * (об этом уже кричит `unreadable`), а вот принять нечитаемость за тишину значит закрыть глаза
   * ровно во время аварии.
   */
  listFailed: () => Promise<RawPortalFailure[] | null>
  /** Доставка. `false` — не доставлено (429, сеть, 5xx). Не бросает. */
  send: (text: string) => Promise<boolean>
  /**
   * Отсечка «один портал в сутки», общая для всех экземпляров; `null` — счётчика нет (без Redis).
   * Возвращает номер попытки: 1 у первой.
   */
  claimNotice: (key: string) => Promise<number | null>
  /** Куда идти разбирать — печатается в сообщении. */
  queuesUrl?: string
  now: () => number
  log?: (message: string) => void
}

export interface PortalFailureRunResult {
  /** Ушло ли сообщение. */
  sent: boolean
  /** Порталы, о которых сообщили (отпечатки, не домены). */
  announced: string[]
  /** Почему не отправляли. */
  skipped?: 'unreadable' | 'nothing' | 'already-sent' | 'send-failed'
}

export function createPortalFailureRunner(deps: PortalFailureRunDeps) {
  return async function run(): Promise<PortalFailureRunResult> {
    const now = deps.now()
    const rows = await deps.listFailed()
    if (rows === null) {
      deps.log?.('очередь не прочитана — наблюдение пропущено')
      return { sent: false, announced: [], skipped: 'unreadable' }
    }

    const troubled = portalsNeedingAttention(summarisePortalFailures(rows, now))
    if (!troubled.length) return { sent: false, announced: [], skipped: 'nothing' }

    // ⚠ Отсечка ПОПОРТАЛЬНАЯ, а не на сообщение целиком. Общий ключ на сутки означал бы, что
    // второй сломавшийся клиент промолчит до завтра только потому, что первый уже отметился.
    const fresh: PortalFailureSummary[] = []
    for (const p of troubled) {
      const attempt = await deps.claimNotice(portalNoticeKey(p.portal, now))
      // `null` — счётчика нет (нет Redis). Тогда сообщаем: пропустить настоящую поломку хуже, чем
      // повторить сообщение после перезапуска. Об отсутствии отсечки предупреждает вызывающий.
      if (attempt === null || attempt === 1) fresh.push(p)
    }
    if (!fresh.length) return { sent: false, announced: [], skipped: 'already-sent' }

    const delivered = await deps.send(buildPortalFailureMessage(fresh, now, deps.queuesUrl))
    if (!delivered) {
      // ⚠ Отметку НЕ снимаем: повторить в этот же день всё равно не дадим, а перевыдача попытки
      // означала бы поток сообщений при недоступном Телеграме. Пропущенное сообщение видно в
      // журнале строкой ниже, и то же состояние придёт завтра, если поломка не ушла.
      deps.log?.('сообщение о порталах не доставлено')
      return { sent: false, announced: [], skipped: 'send-failed' }
    }
    return { sent: true, announced: fresh.map(p => p.portal) }
  }
}
