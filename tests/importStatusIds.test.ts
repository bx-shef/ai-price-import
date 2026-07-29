import { describe, expect, it } from 'vitest'
import { MAX_IDS, parseStatusIds, truncationWarning } from '../server/utils/importStatusIds'
import { MAX_ENTRIES } from '../app/utils/importHistory'

const uuid = (n: number) => `599f0239-0d87-412f-8a9a-${String(n).padStart(12, '0')}`

describe('parseStatusIds', () => {
  it('пропускает валидные id и обрезает пробелы', () => {
    expect(parseStatusIds([` ${uuid(1)} `, uuid(2)])).toEqual({ ids: [uuid(1), uuid(2)], requested: 2 })
  })

  it('отбрасывает не-строки и мусор, не роняя запрос', () => {
    const r = parseStatusIds([uuid(1), 42, null, { a: 1 }, '', 'обычный текст', 'a b c'])
    expect(r.ids).toEqual([uuid(1)])
    expect(r.requested).toBe(1) // мусор не попадает и в счётчик
  })

  it('не массив / отсутствует → пусто, без исключения', () => {
    expect(parseStatusIds(undefined)).toEqual({ ids: [], requested: 0 })
    expect(parseStatusIds('строка')).toEqual({ ids: [], requested: 0 })
    expect(parseStatusIds({ ids: [] })).toEqual({ ids: [], requested: 0 })
  })

  it('переполнение капа отдаёт «сколько просили» — раньше лишнее резалось молча (#260)', () => {
    const many = Array.from({ length: MAX_IDS + 7 }, (_, i) => uuid(i))
    const r = parseStatusIds(many)
    expect(r.ids).toHaveLength(MAX_IDS)
    expect(r.requested).toBe(MAX_IDS + 7)
    expect(r.ids[0]).toBe(uuid(0)) // берём первые = самые свежие (история newest-first)
  })

  it('счётчик «просили» считается ПОСЛЕ отсева мусора — иначе клиент показал бы неверное число', () => {
    const r = parseStatusIds([...Array.from({ length: MAX_IDS + 3 }, (_, i) => uuid(i)), 'мусор', 123], MAX_IDS)
    expect(r.requested).toBe(MAX_IDS + 3)
  })
})

describe('согласованность капов', () => {
  it('серверный кап равен браузерному — иначе самые старые строки молча перестанут обновляться', () => {
    // Браузер физически не может прислать больше MAX_ENTRIES id; серверный кап меньше означал бы
    // тихую потерю обновлений, больше — мёртвую ветку. Связь задана в коде, тест её сторожит.
    expect(MAX_IDS).toBe(MAX_ENTRIES)
  })
})

describe('truncationWarning', () => {
  it('ответили не по всем — говорим сколько из скольких', () => {
    const w = truncationWarning(57, 50)
    expect(w).toContain('последних 50')
    expect(w).toContain('из 57')
  })

  it('полный ответ / нет полей в ответе → молчим', () => {
    expect(truncationWarning(50, 50)).toBe('')
    expect(truncationWarning(10, 50)).toBe('')
    expect(truncationWarning(undefined, undefined)).toBe('')
    expect(truncationWarning(57, undefined)).toBe('')
  })
})
