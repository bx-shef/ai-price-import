import { describe, expect, it, vi } from 'vitest'
import {
  MAX_FAILED_PER_QUEUE,
  MAX_REASON_LEN,
  isFailedAction,
  isKnownQueue,
  decideFailedAction,
  isSafeJobId,
  readFailedJobs,
  toFailedView
} from '../server/queue/failedJobs'
import { QUEUES } from '../server/queue/topology'
import { portalHash } from '../server/utils/telemetryAttributes'

describe('toFailedView', () => {
  it('переносит причину, время и число попыток', () => {
    expect(toFailedView('crm-sync', { id: 7, failedReason: 'портал отверг', finishedOn: 1000, attemptsMade: 3 }))
      .toEqual({ queue: 'crm-sync', id: '7', reason: 'портал отверг', failedAt: 1000, attempts: 3, portal: 'unknown' })
  })

  it('несёт ОТПЕЧАТОК портала, а не его идентификатор (#498)', () => {
    // Без портала в строке «сорок отказов подряд» нельзя было связать с конкретным клиентом, и
    // ручной разбор упирался в отдельную раскопку по логам. ⚠ Именно отпечаток: экран оператора
    // открывается с обычного рабочего места, складывать туда member_id порталов клиентов незачем.
    const v = toFailedView('crm-sync', { id: '9', data: { memberId: 'member-A' } })!
    expect(v.portal).toBe(portalHash('member-A'))
    expect(v.portal).not.toBe('member-A')
    // Задание без портала в пакете различимо от настоящего — иначе они слились бы в одну строку.
    expect(toFailedView('crm-sync', { id: '9' })!.portal).toBe('unknown')
  })

  it('строка без идентификатора отбрасывается — по ней всё равно нечего нажать', () => {
    expect(toFailedView('crm-sync', { id: null, failedReason: 'x' })).toBeNull()
    expect(toFailedView('crm-sync', {})).toBeNull()
  })

  it('причина схлопывается в строку и обрезается — в списке нужна читаемая строка, не простыня', () => {
    const v = toFailedView('crm-sync', { id: '1', failedReason: `а\n\nб   ${'x'.repeat(500)}` })!
    expect(v.reason).not.toContain('\n')
    expect(v.reason.startsWith('а б')).toBe(true)
    expect(v.reason.length).toBeLessThanOrEqual(MAX_REASON_LEN)
  })

  it('причина не сохранилась → говорим об этом, а не показываем пустоту', () => {
    expect(toFailedView('crm-sync', { id: '1' })!.reason).toBe('Причина не сохранилась')
  })

  it('нет времени завершения → берём время начала обработки, иначе null', () => {
    expect(toFailedView('q', { id: '1', processedOn: 55 })!.failedAt).toBe(55)
    expect(toFailedView('q', { id: '1' })!.failedAt).toBeNull()
  })
})

describe('readFailedJobs', () => {
  it('собирает задачи по всем очередям конвейера', async () => {
    const reader = vi.fn(async (name: string) => [{ id: `${name}-1`, failedReason: 'boom', attemptsMade: 3 }])
    const { jobs } = await readFailedJobs(reader as never)
    expect(jobs).toHaveLength(Object.values(QUEUES).length)
    expect(new Set(jobs.map(j => j.queue))).toEqual(new Set(Object.values(QUEUES)))
  })

  it('отказ очереди СООБЩАЕТСЯ отдельно — «не смогли прочитать» это не «ошибок нет»', async () => {
    const reader = vi.fn(async (name: string) => {
      if (name === 'crm-sync') throw new Error('redis down')
      return [{ id: '1', failedReason: 'boom' }]
    })
    const { jobs, unavailable } = await readFailedJobs(reader as never)
    expect(unavailable).toEqual(['crm-sync'])
    expect(jobs.some(j => j.queue === 'crm-sync')).toBe(false)
    expect(jobs.length).toBe(Object.values(QUEUES).length - 1)
  })

  it('количество на очередь ограничено — консоль показывает свежие, а не архив', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: String(i), failedReason: 'x' }))
    const { jobs } = await readFailedJobs(async () => many)
    expect(jobs.length).toBe(Object.values(QUEUES).length * MAX_FAILED_PER_QUEUE)
  })

  it('нулевой предел не превращается в чтение всего хвоста', async () => {
    // Очередь читается диапазоном [0, limit-1]: при limit=0 это [0,-1] — «всё», то есть вычитывание
    // всех упавших задач ради пустого результата. Читателя вообще не зовём.
    const reader = vi.fn(async () => [{ id: '1' }])
    expect(await readFailedJobs(reader as never, 0)).toEqual({ jobs: [], unavailable: [] })
    expect(await readFailedJobs(reader as never, -5)).toEqual({ jobs: [], unavailable: [] })
    expect(reader).not.toHaveBeenCalled()
  })
})

describe('проверка входа от браузера', () => {
  it('имя очереди принимается только из списка конвейера — иначе можно дотянуться до чужого ключа', () => {
    expect(isKnownQueue('crm-sync')).toBe(true)
    expect(isKnownQueue('bull:whatever')).toBe(false)
    expect(isKnownQueue('')).toBe(false)
    expect(isKnownQueue(null)).toBe(false)
    expect(isKnownQueue(42)).toBe(false)
  })

  it('действие — только «повторить» или «отбросить»', () => {
    expect(isFailedAction('retry')).toBe(true)
    expect(isFailedAction('discard')).toBe(true)
    expect(isFailedAction('obliterate')).toBe(false)
    expect(isFailedAction(undefined)).toBe(false)
  })

  it('идентификатор задачи проверяется так же строго, как имя очереди', () => {
    expect(isSafeJobId('cs|portal1|9f0e-1')).toBe(true)
    // Очередь адресует задачу ключом bull:<очередь>:<id>, поэтому служебные имена — не задачи:
    // «Отбросить» с таким id снёс бы метаданные самой очереди.
    expect(isSafeJobId('meta')).toBe(false)
    expect(isSafeJobId('id')).toBe(false)
    expect(isSafeJobId('events')).toBe(false)
    expect(isSafeJobId('a:b')).toBe(false) // двоеточие ломает адресацию ключа
    expect(isSafeJobId('*')).toBe(false)
    expect(isSafeJobId('')).toBe(false)
    expect(isSafeJobId('x'.repeat(201))).toBe(false)
    expect(isSafeJobId(null)).toBe(false)
  })
})

describe('decideFailedAction — проводка роута действий', () => {
  const ok = { queue: 'crm-sync', id: 'cs|p1|abc', action: 'retry' }

  it('без сессии оператора — 401, что бы ни прислали', () => {
    expect(decideFailedAction(false, ok)).toEqual({ status: 401 })
  })

  it('корректный запрос проходит', () => {
    expect(decideFailedAction(true, ok)).toEqual({ status: 200, queue: 'crm-sync', id: 'cs|p1|abc', action: 'retry' })
  })

  it('чужая очередь, служебный id или незнакомое действие — 400', () => {
    expect(decideFailedAction(true, { ...ok, queue: 'bull:other' }).status).toBe(400)
    expect(decideFailedAction(true, { ...ok, id: 'meta' }).status).toBe(400)
    expect(decideFailedAction(true, { ...ok, action: 'obliterate' }).status).toBe(400)
  })

  it('пустое или битое тело — 400, а не исключение', () => {
    expect(decideFailedAction(true, null).status).toBe(400)
    expect(decideFailedAction(true, 'строка').status).toBe(400)
    expect(decideFailedAction(true, {}).status).toBe(400)
  })
})
