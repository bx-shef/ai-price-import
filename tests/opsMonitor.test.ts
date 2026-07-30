import { describe, expect, it } from 'vitest'
import { QUEUES_REFRESH_MS, STALE_AFTER_MS, backlogHours, formatClock, lifetimeSummary, staleAfter, visiblePortals } from '../app/utils/opsMonitor'

describe('formatClock', () => {
  it('показывает время последнего обновления с секундами', () => {
    expect(formatClock(Date.UTC(2026, 6, 29, 11, 3, 27), 'ru-RU')).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('обновления ещё не было → пусто, а не «Invalid Date»', () => {
    expect(formatClock(null)).toBe('')
    expect(formatClock(undefined)).toBe('')
    expect(formatClock(Number.NaN)).toBe('')
  })
})

describe('staleAfter (#271-A)', () => {
  const now = 1_700_000_000_000

  it('свежий снимок устаревшим не считается', () => {
    expect(staleAfter(now - QUEUES_REFRESH_MS, now)).toBe(false)
  })

  it('пропущено несколько циклов обновления → снимок устарел', () => {
    // Ради этого признака всё и делается: на паузе или при молча отвалившихся запросах цифры на
    // экране продолжают выглядеть свежими, а оператор открывает консоль именно за актуальностью.
    expect(staleAfter(now - STALE_AFTER_MS - 1, now)).toBe(true)
  })

  it('граница не считается устареванием', () => {
    expect(staleAfter(now - STALE_AFTER_MS, now)).toBe(false)
  })

  it('обновления ещё не было → это НЕ «устарело» (иначе предупреждение висело бы с открытия)', () => {
    expect(staleAfter(null, now)).toBe(false)
    expect(staleAfter(undefined, now)).toBe(false)
  })

  it('порог заметно больше периода обновления — один пропущенный цикл не тревожит зря', () => {
    expect(STALE_AFTER_MS).toBeGreaterThan(QUEUES_REFRESH_MS * 2)
  })
})

describe('backlogHours (#271-D)', () => {
  it('глубину очереди переводит в понятное время работы', () => {
    // Вместо полосы с выдуманной шкалой (12 задач = 100%) — величина, которую можно сопоставить
    // с реальностью: пропускная способность упирается в ограничитель портала, не в очередь.
    expect(backlogHours(15)).toBe('1 мин работы')
    expect(backlogHours(450)).toBe('30 мин работы')
    expect(backlogHours(900)).toBe('1.0 ч работы')
    expect(backlogHours(4500)).toBe('5.0 ч работы')
  })

  it('очень крупный бэклог округляется до целых часов', () => {
    expect(backlogHours(18_000)).toBe('20 ч работы')
  })

  it('пустая и бессмысленная очередь ничего не рассказывает', () => {
    expect(backlogHours(0)).toBe('')
    expect(backlogHours(-5)).toBe('')
    expect(backlogHours(Number.NaN)).toBe('')
  })

  it('меньше минуты не округляется до нуля', () => {
    expect(backlogHours(1)).toBe('меньше минуты работы')
  })

  it('на границе часа и десяти часов формат один, без «10.0 ч» рядом с «10 ч»', () => {
    expect(backlogHours(900)).toBe('1.0 ч работы') // ровно час
    expect(backlogHours(8964)).toBe('10 ч работы') // 9.96 ч — округляется ДО выбора формата
    expect(backlogHours(9000)).toBe('10 ч работы')
  })
})

// #271-J/K: поиск и порядок в списке порталов.
describe('visiblePortals', () => {
  const rows = [
    { memberId: 'm-ok', domain: 'beta.bitrix24.by', health: 'ok' as const },
    { memberId: 'm-dead', domain: 'zeta.bitrix24.ru', health: 'stale' as const },
    { memberId: 'm-soon', domain: 'alpha.bitrix24.kz', health: 'near-expiry' as const }
  ]

  it('сломанные наверх, дальше по домену', () => {
    expect(visiblePortals(rows, '').map(r => r.memberId)).toEqual(['m-dead', 'm-soon', 'm-ok'])
  })

  it('порядок внутри одного здоровья — по домену', () => {
    const same = [
      { memberId: '2', domain: 'b.bitrix24.by', health: 'ok' as const },
      { memberId: '1', domain: 'a.bitrix24.by', health: 'ok' as const }
    ]
    expect(visiblePortals(same, '').map(r => r.memberId)).toEqual(['1', '2'])
  })

  it('исходный массив не мутируется — список перестраивается каждые 12 секунд', () => {
    const copy = [...rows]
    visiblePortals(rows, '')
    expect(rows).toEqual(copy)
  })

  it('ищет по домену и по member_id, без учёта регистра', () => {
    expect(visiblePortals(rows, 'ZETA').map(r => r.memberId)).toEqual(['m-dead'])
    expect(visiblePortals(rows, 'm-soon').map(r => r.memberId)).toEqual(['m-soon'])
  })

  it('пустой запрос ничего не отсеивает, непопадание даёт пусто', () => {
    expect(visiblePortals(rows, '   ')).toHaveLength(3)
    expect(visiblePortals(rows, 'нет такого')).toHaveLength(0)
  })
})

// #271-C: накопительный итог подписывается отдельно от счётчиков очереди.
describe('lifetimeSummary', () => {
  it('перечисляет документы, записи и позиции', () => {
    expect(lifetimeSummary({ docs: 12, created: 11, lines: 340, errors: 0 }))
      .toBe('12 документов · 11 в CRM · 340 позиций')
  })

  it('ошибки добавляются только когда они есть', () => {
    expect(lifetimeSummary({ docs: 12, created: 11, lines: 340, errors: 1 })).toContain('1 с ошибкой')
  })

  it('пусто, пока ничего не обработано (нечего показывать)', () => {
    expect(lifetimeSummary({ docs: 0, created: 0, lines: 0, errors: 0 })).toBe('')
    expect(lifetimeSummary(null)).toBe('')
  })
})
