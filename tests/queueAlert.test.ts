import { beforeEach, describe, expect, it } from 'vitest'
import {
  FAILURE_ALERT_THRESHOLD,
  FAILURE_WINDOW_MS,
  STALL_AGE_MS,
  evaluateQueueHealth,
  type QueueHealthInput
} from '../server/utils/queueAlert'
import {
  MAX_FAILED_SCAN,
  countRecentFailures,
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
    it('прирост выше порога — тревога с числом', () => {
      const [a] = evaluateQueueHealth([q({ recentFailures: FAILURE_ALERT_THRESHOLD })], NOW)
      expect(a?.kind).toBe('failing')
      expect(a?.text).toContain(String(FAILURE_ALERT_THRESHOLD))
    })

    it('на единицу ниже порога — молчим', () => {
      expect(evaluateQueueHealth([q({ recentFailures: FAILURE_ALERT_THRESHOLD - 1 })], NOW)).toEqual([])
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
      expect(alerts[0]?.text).toContain('не читается')
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
