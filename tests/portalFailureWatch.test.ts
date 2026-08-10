import { describe, expect, it, vi } from 'vitest'
import {
  MAX_PORTALS_IN_MESSAGE,
  PORTAL_FAILURE_THRESHOLD,
  PORTAL_FAILURE_WINDOW_MS,
  buildPortalFailureMessage,
  portalNoticeKey,
  portalsNeedingAttention,
  summarisePortalFailures
} from '../server/utils/portalFailureWatch'
import { createPortalFailureRunner } from '../server/utils/portalFailureRun'
import { isServiceFailure } from '../server/utils/queueHealthRead'
import { portalHash } from '../server/utils/telemetryAttributes'

/**
 * Наблюдение за порталом, у которого падают ВСЕ импорты (#498).
 *
 * Несущее утверждение всего файла: класс отказов, который тревога отсеивает НАМЕРЕННО, обязан быть
 * подобран здесь. Между двумя механизмами не должно остаться щели — иначе появится вид падения, о
 * котором не сообщает никто, а это ровно тот дефект, ради которого задача и заведена.
 */

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)
const ago = (ms: number) => NOW - ms
const fail = (memberId: string, reason: string, at = ago(60_000)) => ({
  failedReason: reason,
  finishedOn: at,
  data: { memberId }
})

describe('#498: у клиента падают все импорты', () => {
  it('считает ровно то, что отсеивает тревога, — и наоборот', () => {
    // Щель между механизмами не видна ни в одном тесте по отдельности: тревога промолчит «по
    // правилу», наблюдение — «нечего считать», и оба будут по-своему правы.
    const portalSide = ['ACCESS_DENIED', 'Access denied', 'нет прав', 'портал не авторизован']
    const ourSide = ['ECONNRESET', 'unexpected token', 'Redis is down']
    for (const reason of portalSide) {
      expect(isServiceFailure(reason), `«${reason}» обязан считаться отказом ПОРТАЛА`).toBe(false)
      expect(summarisePortalFailures([fail('m1', reason)], NOW), `«${reason}» обязан попасть в наблюдение`).toHaveLength(1)
    }
    for (const reason of ourSide) {
      expect(isServiceFailure(reason), `«${reason}» обязан считаться НАШИМ отказом`).toBe(true)
      expect(summarisePortalFailures([fail('m1', reason)], NOW), `«${reason}» — дело тревоги, не наблюдения`).toHaveLength(0)
    }
  })

  it('группирует по порталу и не отдаёт наружу member_id', () => {
    const rows = [fail('member-A', 'ACCESS_DENIED'), fail('member-B', 'нет прав'), fail('member-A', 'ACCESS_DENIED')]
    const out = summarisePortalFailures(rows, NOW)
    expect(out).toHaveLength(2)
    // Первым — тот, у кого хуже.
    expect(out[0]).toMatchObject({ portal: portalHash('member-A'), failures: 2 })
    // Несущее для приватности: наружу уходит отпечаток, а не идентификатор портала.
    expect(JSON.stringify(out)).not.toContain('member-A')
  })

  it('не считает отказы старше окна и недатированные', () => {
    // Недатированный отказ мог случиться когда угодно; принять его за «сейчас» значит сообщать о
    // давно починенном — и сообщать вечно, потому что дата не появится.
    const rows = [
      fail('m', 'ACCESS_DENIED', ago(PORTAL_FAILURE_WINDOW_MS + 60_000)),
      { failedReason: 'ACCESS_DENIED', finishedOn: null, processedOn: null, data: { memberId: 'm' } },
      { failedReason: 'ACCESS_DENIED', finishedOn: NOW + 60_000, data: { memberId: 'm' } } // из будущего
    ]
    expect(summarisePortalFailures(rows, NOW)).toHaveLength(0)
  })

  it('порог: один отказ — не повод писать, три — повод', () => {
    // ⚠ Числа ЛИТЕРАЛЬНЫЕ, а не выведенные из самой константы. Первая редакция строила данные как
    // `length: PORTAL_FAILURE_THRESHOLD - 1`, и мутация «порог = 1» проходила незамеченной: тест
    // менялся вместе с проверяемым значением. Гард, который подстраивается под код, не гард.
    const rows = (n: number) => Array.from({ length: n }, () => fail('m', 'ACCESS_DENIED'))
    expect(portalsNeedingAttention(summarisePortalFailures(rows(1), NOW)), 'один отказ бывает разовым').toHaveLength(0)
    expect(portalsNeedingAttention(summarisePortalFailures(rows(2), NOW)), 'два — ещё совпадение').toHaveLength(0)
    expect(portalsNeedingAttention(summarisePortalFailures(rows(3), NOW)), 'три РАЗНЫХ документа — уже поломка').toHaveLength(1)
    // Само значение тоже закреплено: его снижение меняет поведение всего механизма.
    expect(PORTAL_FAILURE_THRESHOLD).toBe(3)
  })

  it('в сообщении нет ни домена, ни member_id, ни текста отказа', () => {
    // В ответе портала бывает название товара или имя поставщика ИЗ ДОКУМЕНТА (урок #416).
    const rows = Array.from({ length: 5 }, () => fail('member-A', 'ACCESS_DENIED: сделка «ООО Ромашка» недоступна'))
    const text = buildPortalFailureMessage(portalsNeedingAttention(summarisePortalFailures(rows, NOW)), NOW)
    expect(text).toContain(portalHash('member-A'))
    expect(text).not.toContain('member-A')
    expect(text).not.toContain('Ромашка')
    expect(text).not.toContain('ACCESS_DENIED')
    // Сообщение обязано отвечать на «что делать», а не только «что случилось».
    expect(text).toMatch(/Разбирать/)
  })

  it('длинный список порталов сворачивается, а не печатается целиком', () => {
    const many = Array.from({ length: MAX_PORTALS_IN_MESSAGE + 4 }, (_, i) => ({
      portal: `p${i}`,
      failures: 5,
      firstAtMs: ago(3_600_000),
      lastAtMs: NOW
    }))
    const text = buildPortalFailureMessage(many, NOW)
    expect(text).toContain('и ещё порталов: 4')
  })

  it('ключ отсечки — свой у каждого портала и свой у каждых суток', () => {
    expect(portalNoticeKey('a', NOW)).not.toBe(portalNoticeKey('b', NOW))
    expect(portalNoticeKey('a', NOW)).not.toBe(portalNoticeKey('a', NOW + 24 * 3600_000))
    expect(portalNoticeKey('a', NOW)).toBe(portalNoticeKey('a', NOW + 60_000))
  })
})

describe('#498: прогон наблюдения', () => {
  const deps = (over: Partial<Parameters<typeof createPortalFailureRunner>[0]> = {}) => {
    const sent: string[] = []
    const claimed = new Map<string, number>()
    const base = {
      listFailed: async () => Array.from({ length: 4 }, () => fail('member-A', 'ACCESS_DENIED')),
      send: async (t: string) => {
        sent.push(t)
        return true
      },
      claimNotice: async (k: string) => {
        const n = (claimed.get(k) ?? 0) + 1
        claimed.set(k, n)
        return n
      },
      now: () => NOW,
      ...over
    }
    return { deps: base, sent }
  }

  it('сообщает один раз в сутки на портал', async () => {
    const { deps: d, sent } = deps()
    const run = createPortalFailureRunner(d)
    expect((await run()).sent).toBe(true)
    const second = await run()
    expect(second.sent, 'повтор в те же сутки — молчим').toBe(false)
    expect(second.skipped).toBe('already-sent')
    expect(sent).toHaveLength(1)
  })

  it('нечитаемая очередь — это НЕ «отказов нет»', async () => {
    // Принять нечитаемость за тишину значит закрыть глаза ровно во время аварии.
    const { deps: d, sent } = deps({ listFailed: async () => null })
    const r = await createPortalFailureRunner(d)()
    expect(r.skipped).toBe('unreadable')
    expect(sent).toHaveLength(0)
  })

  it('без отсечки (нет Redis) сообщение всё равно уходит', async () => {
    // Пропустить настоящую поломку хуже, чем повторить сообщение после перезапуска.
    const { deps: d, sent } = deps({ claimNotice: async () => null })
    expect((await createPortalFailureRunner(d)()).sent).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('недоставленное сообщение не выдаёт себя за отправленное', async () => {
    const { deps: d } = deps({ send: async () => false })
    const log = vi.fn()
    const r = await createPortalFailureRunner({ ...d, log })()
    expect(r.sent).toBe(false)
    expect(r.skipped).toBe('send-failed')
    expect(log, 'отказ доставки обязан быть виден в журнале').toHaveBeenCalled()
  })

  it('второй сломавшийся портал не молчит из-за первого', async () => {
    // Отсечка попортальная, а не на сообщение целиком.
    const rowsA = Array.from({ length: 4 }, () => fail('member-A', 'ACCESS_DENIED'))
    const rowsB = Array.from({ length: 4 }, () => fail('member-B', 'нет прав'))
    let rows = rowsA
    const { deps: d, sent } = deps({ listFailed: async () => rows })
    const run = createPortalFailureRunner(d)
    await run()
    rows = [...rowsA, ...rowsB]
    const second = await run()
    expect(second.sent, 'о втором портале обязаны сообщить в тот же день').toBe(true)
    expect(second.announced).toEqual([portalHash('member-B')])
    expect(sent[1]).not.toContain(portalHash('member-A'))
  })

  it('тишина, когда падений нет', async () => {
    const { deps: d, sent } = deps({ listFailed: async () => [] })
    expect((await createPortalFailureRunner(d)()).skipped).toBe('nothing')
    expect(sent).toHaveLength(0)
  })
})
