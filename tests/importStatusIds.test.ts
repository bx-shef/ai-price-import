import { describe, expect, it } from 'vitest'
import { MAX_IDS, parseStatusIds, truncationWarning } from '../server/utils/importStatusIds'
import { MAX_UPLOAD_FILES } from '../app/utils/importUpload'

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
  it('серверный кап держит несколько пачек на одной странице', () => {
    // Персистентной истории больше нет (localStorage убран — переработка владельца), парного капа
    // на клиенте не существует. Смысл серверного: страница за сессию может прогнать несколько пачек
    // по MAX_UPLOAD_FILES файлов, и все их строки обязаны продолжать обновляться одним запросом.
    expect(MAX_IDS).toBeGreaterThanOrEqual(3 * MAX_UPLOAD_FILES)
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
