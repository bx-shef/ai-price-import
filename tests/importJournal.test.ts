import { describe, it, expect } from 'vitest'
import { JOURNAL_PAGE_SIZE, buildJournalQuery, mapJournalRows } from '../server/utils/importJournal'

describe('#458: журнал импортов — выборка', () => {
  it('всегда сужен до сотрудника и до НАШИХ дел', () => {
    const q = buildJournalQuery('SH_APP_IMPORT_PRICE_AI', 17)
    expect(q.filter).toEqual({ ORIGINATOR_ID: 'SH_APP_IMPORT_PRICE_AI', RESPONSIBLE_ID: '17' })
  })

  it('сотрудник неизвестен → выборка ЗАВЕДОМО ПУСТА, а не «весь портал»', () => {
    // Ошибка в эту сторону показала бы человеку чужие документы, и заметить её по виду экрана
    // нельзя — список просто длиннее. Поэтому fail-closed, и это проверяется на всех видах мусора.
    for (const bad of [undefined, null, '', 'abc', 0, -1, 2.5, NaN]) {
      expect(buildJournalQuery('X', bad).filter.RESPONSIBLE_ID, String(bad)).toBe('0')
    }
  })

  it('сортировка по ID, а не по времени создания', () => {
    // Пачка документов создаёт дела в одну секунду, и метка времени порядка не задаёт вовсе.
    expect(buildJournalQuery('X', 1).order).toEqual({ ID: 'DESC' })
  })

  it('поля запрашиваются явно — тело документа в список не тянем', () => {
    const q = buildJournalQuery('X', 1)
    expect(q.select).not.toContain('*')
    expect(q.select).not.toContain('DESCRIPTION')
    expect(q.select).toContain('ORIGIN_ID')
  })

  it('битый или отрицательный start не уводит выборку', () => {
    for (const bad of [-5, 1.5, NaN]) expect(buildJournalQuery('X', 1, bad).start).toBe(0)
    expect(buildJournalQuery('X', 1, 40).start).toBe(40)
  })
})

describe('#458: журнал импортов — разбор ответа', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    ID: '55', SUBJECT: 'Импорт: ООО Ромашка', COMPLETED: 'Y', CREATED: '2026-08-08T10:00:00+03:00',
    ORIGIN_ID: 'job-1', OWNER_TYPE_ID: '2', OWNER_ID: '341', ...over
  })

  it('строки портала (всё строками) превращаются в числа и флаги', () => {
    expect(mapJournalRows([row()])).toEqual([{
      activityId: 55, jobId: 'job-1', title: 'Импорт: ООО Ромашка', clean: true,
      createdAt: '2026-08-08T10:00:00+03:00', ownerTypeId: 2, ownerId: 341
    }])
  })

  it('COMPLETED сравнивается со строкой «Y», а не с булевым', () => {
    // Портал отдаёт 'Y'/'N'. Сравнение с `true` молча пометило бы КАЖДЫЙ чистый импорт как
    // «с замечаниями», и журнал был бы сплошь тревожным при исправном коде.
    expect(mapJournalRows([row({ COMPLETED: 'Y' })])[0]!.clean).toBe(true)
    expect(mapJournalRows([row({ COMPLETED: 'N' })])[0]!.clean).toBe(false)
  })

  it('дело без ORIGIN_ID отбрасывается — оно не наше', () => {
    // Связать его с заданием нечем: ни отзыв, ни повтор по такой строке не работают, а выглядела
    // бы она рабочей.
    expect(mapJournalRows([row({ ORIGIN_ID: '' }), row({ ORIGIN_ID: undefined }), row()])).toHaveLength(1)
  })

  it('не-массив читается как пустой список, а не роняет разбор', () => {
    for (const bad of [null, undefined, {}, 'нет', 0]) expect(mapJournalRows(bad)).toEqual([])
  })

  it('размер страницы задан числом и используется как признак «есть ещё»', () => {
    expect(JOURNAL_PAGE_SIZE).toBeGreaterThan(0)
  })
})
