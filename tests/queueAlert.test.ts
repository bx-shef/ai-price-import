import { beforeEach, describe, expect, it } from 'vitest'
import {
  ALL_QUEUES,
  FAILURE_ALERT_THRESHOLD,
  FAILURE_WINDOW_MS,
  STALL_AGE_MS,
  evaluateQueueHealth,
  type QueueHealthInput
} from '../server/utils/queueAlert'
import {
  MAX_FAILED_SCAN,
  countRecentFailures,
  isServiceFailure,
  readQueueHealth,
  summarisePending
} from '../server/utils/queueHealthRead'
import { queueAlertState, recordQueueHealth, resetQueueAlertState } from '../server/utils/queueAlertState'

const NOW = 1_000_000_000

const q = (over: Partial<QueueHealthInput> = {}): QueueHealthInput => ({
  queue: 'file-extract',
  oldestPendingAgeMs: null,
  pending: 0,
  recentFailures: 0,
  ...over
})

describe('evaluateQueueHealth', () => {
  it('пустая очередь — тишина', () => {
    expect(evaluateQueueHealth([q()], NOW)).toEqual([])
  })

  // Ради чего это написано: снимок глубины не отличает «навалило работы» от «встало».
  describe('очередь встала', () => {
    it('самая старая задача висит дольше порога — тревога', () => {
      const [a] = evaluateQueueHealth([q({ oldestPendingAgeMs: STALL_AGE_MS + 1, pending: 3 })], NOW)
      expect(a?.kind).toBe('stalled')
      expect(a?.queue).toBe('file-extract')
      expect(a?.text).toContain('3 задач')
      expect(a?.text).toContain(String(Math.round((STALL_AGE_MS + 1) / 60_000)))
    })

    it('ровно на пороге ещё молчим', () => {
      expect(evaluateQueueHealth([q({ oldestPendingAgeMs: STALL_AGE_MS, pending: 3 })], NOW)).toEqual([])
    })

    // Главный урок предыдущей (неверной) версии: порог по РАЗМЕРУ хвоста делал тревогу
    // недостижимой для малых очередей — а именно там молчание опаснее всего.
    it('одна застрявшая задача — тоже тревога: b24-events возит установки поштучно', () => {
      const alerts = evaluateQueueHealth([q({ queue: 'b24-events', oldestPendingAgeMs: STALL_AGE_MS * 2, pending: 1 })], NOW)
      expect(alerts.map(a => a.kind)).toEqual(['stalled'])
    })

    it('тысяча свежих задач — это всплеск нагрузки, а не поломка', () => {
      expect(evaluateQueueHealth([q({ oldestPendingAgeMs: 30_000, pending: 1000 })], NOW)).toEqual([])
    })
  })

  describe('задачи падают', () => {
    // Порог намеренно НИЗКИЙ: в множество упавших BullMQ попадают только задачи, исчерпавшие все
    // попытки, — отвергнутые документы туда не идут вовсе (о них сотруднику пишут напрямую).
    // Прежние 10 за 15 минут были скопированы из логики «один кривой документ — не повод»,
    // но кривых документов в этой выборке нет, и правило оставалось недостижимым.
    it('порог и окно закреплены: 3 за час', () => {
      expect(FAILURE_ALERT_THRESHOLD).toBe(3)
      expect(FAILURE_WINDOW_MS).toBe(3_600_000)
    })

    it('прирост выше порога — тревога с числом', () => {
      const [a] = evaluateQueueHealth([q({ recentFailures: FAILURE_ALERT_THRESHOLD })], NOW)
      expect(a?.kind).toBe('failing')
      expect(a?.text).toContain(String(FAILURE_ALERT_THRESHOLD))
    })

    it('на единицу ниже порога — молчим', () => {
      expect(evaluateQueueHealth([q({ recentFailures: FAILURE_ALERT_THRESHOLD - 1 })], NOW)).toEqual([])
    })

    // Ради этого порог и снижали: при трёх-пяти документах в час прежние «10 за 15 минут»
    // не набирались никогда, даже когда падало всё подряд.
    it('тихий портал: всё падает, но документов мало — тревога всё равно звучит', () => {
      const alerts = evaluateQueueHealth([q({ queue: 'crm-sync', recentFailures: 4 })], NOW)
      expect(alerts.map(a => a.kind)).toEqual(['failing'])
    })

    it('называет свою очередь, а не первую попавшуюся', () => {
      const [a] = evaluateQueueHealth([q({ queue: 'crm-sync', recentFailures: 99 })], NOW)
      expect(a?.queue).toBe('crm-sync')
      expect(a?.text).toContain('crm-sync')
    })
  })

  // Отказ Redis раньше отдавался нулями — то есть тотальная авария рисовалась пустой здоровой
  // очередью. Отдельный вид тревоги: без данных любой другой вердикт был бы выдуман.
  describe('очередь не читается', () => {
    it('сообщаем именно об этом', () => {
      const alerts = evaluateQueueHealth([q({ unreadable: true })], NOW)
      expect(alerts.map(a => a.kind)).toEqual(['unreadable'])
      expect(alerts[0]?.text).toMatch(/не чита/)
    })

    // Живой прогон 2026-08-02: остановили Redis — в чат пришло ЧЕТЫРЕ сообщения подряд, по одному
    // на очередь. Одна авария, четыре сообщения; а на подъёме пришло бы ещё четыре «восстановилось».
    // Это ровно тот шум, против которого написан весь модуль: канал, который повторяется,
    // перестают читать — и он не сработает в тот единственный раз, ради которого заведён.
    it('ВСЕ очереди не читаются → одна тревога, а не по штуке на очередь', () => {
      const alerts = evaluateQueueHealth([
        q({ queue: 'b24-events', unreadable: true }),
        q({ queue: 'file-extract', unreadable: true }),
        q({ queue: 'agent-run', unreadable: true }),
        q({ queue: 'crm-sync', unreadable: true })
      ], NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.queue).toBe(ALL_QUEUES)
      // Текст обязан говорить про очереди во множественном числе и звать чинить Redis: имени
      // конкретной очереди тут нет, и «очередь «*»» читалось бы как поломка самого сообщения.
      expect(alerts[0]?.text).toContain('очереди не читаются')
      expect(alerts[0]?.text).toMatch(/Redis/)
    })

    it('нечитаема ЧАСТЬ очередей → имена называем: причина у них разная', () => {
      // Схлопывать тут нельзя. «Все не читаются» — это про общий Redis; одна выпавшая очередь при
      // живых остальных — про неё саму, и её имя единственное, что помогает.
      const alerts = evaluateQueueHealth([
        q({ queue: 'b24-events', unreadable: true }),
        q({ queue: 'crm-sync' })
      ], NOW)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.queue).toBe('b24-events')
      expect(alerts[0]?.text).toContain('«b24-events»')
    })

    it('очередей нет вовсе → тревог нет (пустой список не «все нечитаемы»)', () => {
      // `[].every(...)` истинно — без явной проверки длины пустой замер объявил бы полную аварию.
      expect(evaluateQueueHealth([], NOW)).toEqual([])
    })

    it('нечитаемая очередь не порождает выдуманных вердиктов о простое и падениях', () => {
      const alerts = evaluateQueueHealth([
        q({ unreadable: true, oldestPendingAgeMs: STALL_AGE_MS * 5, pending: 999, recentFailures: 999 })
      ], NOW)
      expect(alerts.map(a => a.kind)).toEqual(['unreadable'])
    })
  })

  it('очереди судятся независимо друг от друга', () => {
    const alerts = evaluateQueueHealth([
      q({ queue: 'file-extract' }),
      q({ queue: 'crm-sync', oldestPendingAgeMs: STALL_AGE_MS * 2, pending: 5 }),
      q({ queue: 'agent-run', recentFailures: 50 })
    ], NOW)
    expect(alerts.map(a => `${a.queue}:${a.kind}`)).toEqual(['crm-sync:stalled', 'agent-run:failing'])
  })
})

describe('summarisePending', () => {
  it('пусто — возраста нет', () => {
    expect(summarisePending([], NOW)).toEqual({ pending: 0, oldestPendingAgeMs: null })
  })

  it('берётся САМАЯ старая, а не первая в списке', () => {
    const r = summarisePending([{ timestamp: NOW - 1000 }, { timestamp: NOW - 60_000 }, { timestamp: NOW - 5000 }], NOW)
    expect(r).toEqual({ pending: 3, oldestPendingAgeMs: 60_000 })
  })

  it('задача из будущего (часы разъехались) не даёт отрицательного возраста', () => {
    expect(summarisePending([{ timestamp: NOW + 60_000 }], NOW).oldestPendingAgeMs).toBe(0)
  })

  it('задачи без метки времени считаются, но не стареют', () => {
    const r = summarisePending([{ timestamp: null }, {}], NOW)
    expect(r).toEqual({ pending: 2, oldestPendingAgeMs: null })
  })
})

describe('countRecentFailures', () => {
  it('считает только попавшие в окно', () => {
    const jobs = [
      { finishedOn: NOW - 1000 },
      { finishedOn: NOW - FAILURE_WINDOW_MS + 1 },
      { finishedOn: NOW - FAILURE_WINDOW_MS - 1 } // за окном
    ]
    expect(countRecentFailures(jobs, NOW)).toBe(2)
  })

  it('без метки времени не считаем: «когда-то» — это не «сейчас»', () => {
    expect(countRecentFailures([{ finishedOn: null }, {}], NOW)).toBe(0)
  })

  it('запасная метка processedOn, когда finishedOn нет', () => {
    expect(countRecentFailures([{ processedOn: NOW - 1000 }], NOW)).toBe(1)
  })

  it('метка из будущего не засчитывается', () => {
    expect(countRecentFailures([{ finishedOn: NOW + 10_000 }], NOW)).toBe(0)
  })
})

// Отказ, за который отвечает клиент, — не наша тревога. Он детерминированный: удалённый смарт-процесс
// или отозванные права дают один и тот же отказ на каждом документе этого портала. Считая их, мы
// привязали бы тревогу к числу неверно настроенных клиентов — один такой портал будил бы нас
// ежечасно и бесконечно из-за того, что чинить должен не дежурный. Сотрудник об этом узнаёт сам.
describe('isServiceFailure', () => {
  it('отказ портала по правам и типу сущности — не наша тревога', () => {
    for (const r of [
      'ACCESS_DENIED',
      'Access denied',
      'нет прав на этот раздел',
      'Сущность CRM не поддерживается',
      'Смарт-процесс не найден',
      'портал не авторизован (нет токена)'
    ]) expect(isServiceFailure(r), r).toBe(false)
  })

  it('всё остальное считаем нашим — незнакомая поломка важнее лишней тревоги', () => {
    for (const r of [
      'connect ECONNREFUSED 127.0.0.1:6379',
      'job stalled more than allowable limit',
      'QUERY_LIMIT_EXCEEDED',
      'socket hang up',
      ''
    ]) expect(isServiceFailure(r), r).toBe(true)
  })

  it('отсутствующая причина не прячет отказ', () => {
    expect(isServiceFailure(undefined)).toBe(true)
    expect(isServiceFailure(null)).toBe(true)
  })
})

describe('countRecentFailures: чей отказ', () => {
  it('отказы одного криво настроенного портала не набирают порог', () => {
    const jobs = Array.from({ length: 20 }, () => ({
      finishedOn: NOW - 60_000,
      failedReason: 'Ошибка Битрикс24: ACCESS_DENIED'
    }))
    expect(countRecentFailures(jobs, NOW)).toBe(0)
  })

  it('наши отказы среди чужих считаются', () => {
    const jobs = [
      { finishedOn: NOW - 60_000, failedReason: 'ACCESS_DENIED' },
      { finishedOn: NOW - 60_000, failedReason: 'connect ECONNREFUSED' },
      { finishedOn: NOW - 60_000, failedReason: 'Смарт-процесс не найден' },
      { finishedOn: NOW - 60_000, failedReason: 'socket hang up' }
    ]
    expect(countRecentFailures(jobs, NOW)).toBe(2)
  })
})

// Отказ, за который отвечает клиент, — не наша тревога. Он детерминирован (повторится на всех трёх
// попытках и на каждом документе этого портала), и если его считать, то один портал с неверной
// настройкой будет будить нас ежечасно и бесконечно о том, что чинить не нам. Сам клиент уже
// извещён — ему пишут в чат.
describe('isServiceFailure', () => {
  it('отказы портала не считаются нашей поломкой', () => {
    for (const r of [
      'ACCESS_DENIED',
      'Ошибка: access denied',
      'нет прав на создание сущности',
      'Сущность CRM не поддерживается',
      'Entity type not supported',
      'Смарт-процесс не найден',
      'портал не авторизован (нет токена)'
    ]) {
      expect(isServiceFailure(r), r).toBe(false)
    }
  })

  it('всё остальное считается нашим — незнакомая поломка скорее наша', () => {
    for (const r of [
      'connect ECONNREFUSED 127.0.0.1:6379',
      'job stalled more than allowable limit',
      'timeout of 30000ms exceeded',
      'QUERY_LIMIT_EXCEEDED',
      ''
    ]) {
      expect(isServiceFailure(r), r).toBe(true)
    }
  })

  it('пустая причина не проваливается молча', () => {
    expect(isServiceFailure(null)).toBe(true)
    expect(isServiceFailure(undefined)).toBe(true)
  })

  it('один криво настроенный портал не поднимает тревогу', () => {
    const jobs = Array.from({ length: 50 }, () => ({
      finishedOn: NOW - 60_000,
      failedReason: 'ACCESS_DENIED: нет прав'
    }))
    expect(countRecentFailures(jobs, NOW)).toBe(0)
  })

  it('но наши отказы среди чужих всё равно видны', () => {
    const jobs = [
      ...Array.from({ length: 50 }, () => ({ finishedOn: NOW - 60_000, failedReason: 'ACCESS_DENIED' })),
      ...Array.from({ length: 3 }, () => ({ finishedOn: NOW - 60_000, failedReason: 'ECONNREFUSED' }))
    ]
    expect(countRecentFailures(jobs, NOW)).toBe(3)
  })
})

describe('readQueueHealth', () => {
  const okReader = {
    pending: async () => [{ timestamp: NOW - 90_000 }],
    failed: async () => [{ finishedOn: NOW - 1000 }]
  }

  it('читает все очереди конвейера', async () => {
    const rows = await readQueueHealth(okReader, NOW)
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every(r => r.pending === 1 && r.recentFailures === 1)).toBe(true)
    expect(rows.some(r => r.unreadable)).toBe(false)
  })

  it('недоступная очередь помечается нечитаемой, а не пустой и здоровой', async () => {
    const rows = await readQueueHealth({
      pending: async () => { throw new Error('ECONNREFUSED') },
      failed: async () => []
    }, NOW)
    expect(rows.every(r => r.unreadable === true)).toBe(true)
    expect(evaluateQueueHealth(rows, NOW).every(a => a.kind === 'unreadable')).toBe(true)
  })

  it('отказ одной очереди не скрывает состояние остальных', async () => {
    const rows = await readQueueHealth({
      pending: async name => (name === 'crm-sync' ? Promise.reject(new Error('down')) : [{ timestamp: NOW - 90_000 }]),
      failed: async () => []
    }, NOW)
    expect(rows.filter(r => r.unreadable).map(r => r.queue)).toEqual(['crm-sync'])
    expect(rows.filter(r => !r.unreadable).length).toBeGreaterThan(0)
  })

  it('чтение упавших ограничено — консоль не архив', () => {
    expect(MAX_FAILED_SCAN).toBeGreaterThan(FAILURE_ALERT_THRESHOLD)
  })

  // Кап безопасен только потому, что BullMQ отдаёт упавшие СВЕЖИМИ ВПЕРЁД: он срезает старый
  // хвост, который и так вне окна. Здесь закрепляем, что мы считаем именно свежие: если бы
  // читались старые, при крупной аварии счёт падал бы до нуля ровно тогда, когда он нужен.
  it('при переполнении капа считаются свежие отказы, а не древние', async () => {
    const old = Array.from({ length: 300 }, () => ({ finishedOn: NOW - 10 * 60 * 60 * 1000 }))
    const fresh = Array.from({ length: 5 }, () => ({ finishedOn: NOW - 60_000 }))
    const rows = await readQueueHealth({
      pending: async () => [],
      // Как BullMQ: свежие первыми, обрезано капом.
      failed: async () => [...fresh, ...old].slice(0, MAX_FAILED_SCAN)
    }, NOW)
    expect(rows[0]?.recentFailures).toBe(5)
    expect(evaluateQueueHealth(rows, NOW).some(a => a.kind === 'failing')).toBe(true)
  })
})

describe('queueAlertState', () => {
  beforeEach(() => resetQueueAlertState())

  it('до первой проверки время не заполнено — «тревог нет» ещё ничего не значит', () => {
    expect(queueAlertState()).toEqual({ alerts: [], checkedAtMs: null })
  })

  it('запоминает вердикт и время', () => {
    const alerts = evaluateQueueHealth([q({ oldestPendingAgeMs: STALL_AGE_MS * 2, pending: 2 })], NOW)
    recordQueueHealth(alerts, NOW)
    const state = queueAlertState()
    expect(state.checkedAtMs).toBe(NOW)
    expect(state.alerts.map(a => a.kind)).toEqual(['stalled'])
  })

  it('когда очередь разгреблась — тревога снимается', () => {
    recordQueueHealth(evaluateQueueHealth([q({ oldestPendingAgeMs: STALL_AGE_MS * 2, pending: 2 })], NOW), NOW)
    expect(queueAlertState().alerts).not.toEqual([])
    recordQueueHealth(evaluateQueueHealth([q()], NOW + 1000), NOW + 1000)
    expect(queueAlertState()).toEqual({ alerts: [], checkedAtMs: NOW + 1000 })
  })

  it('вызывающий не может испортить сохранённый вердикт, изменив полученный список', () => {
    recordQueueHealth([{ kind: 'stalled', queue: 'crm-sync', text: 'x' }], NOW)
    queueAlertState().alerts.push({ kind: 'failing', queue: 'подделка', text: 'y' })
    expect(queueAlertState().alerts.map(a => a.queue)).toEqual(['crm-sync'])
  })
})
