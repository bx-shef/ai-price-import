import { describe, it, expect } from 'vitest'
import { appendPage, formatJournalDate, journalOutcomeLabel, nextStart, shouldLoadMore, type JournalRow } from '../app/utils/journalView'

const row = (id: number): JournalRow => ({
  activityId: id, jobId: `job-${id}`, title: `Импорт ${id}`, clean: true,
  createdAt: '2026-08-08T10:00:00+03:00', entityTypeId: 2, entityId: 100 + id
})

describe('#458: подкачка журнала', () => {
  it('страница дописывается В КОНЕЦ, порядок не пересобирается', () => {
    // Пересортировка при подгрузке заставила бы список прыгать под пальцем.
    expect(appendPage([row(9), row(8)], [row(7), row(6)]).map(r => r.activityId)).toEqual([9, 8, 7, 6])
  })

  it('повтор строки НЕ задваивается', () => {
    // Пагинация по смещению + сортировка по убыванию: пока человек читает, приходит новый импорт,
    // всё съезжает вниз, и следующая страница возвращает уже показанную строку. Без дедупа
    // человек видит документ дважды и решает, что импорт задвоился.
    const shown = [row(9), row(8)]
    expect(appendPage(shown, [row(8), row(7)]).map(r => r.activityId)).toEqual([9, 8, 7])
  })

  it('страница целиком из дублей не меняет список (и не создаёт новый массив зря)', () => {
    const shown = [row(9)]
    expect(appendPage(shown, [row(9)])).toBe(shown)
  })

  it('смещение следующей страницы считается от ПОКАЗАННОГО', () => {
    // Не от номера страницы: после дедупа показано меньше, чем запрошено, и счёт «страница×размер»
    // начал бы пропускать строки.
    expect(nextStart([])).toBe(0)
    expect(nextStart([row(1), row(2), row(3)])).toBe(3)
  })
})

describe('#458: когда подкачивать', () => {
  it('не грузим, пока идёт запрос', () => {
    // Наблюдатель прокрутки выстреливает несколько раз подряд на одно движение пальца — без этого
    // портал получил бы три-четыре одинаковых вызова и упёрся бы в лимит.
    expect(shouldLoadMore({ hasMore: true, loading: true, failed: false })).toBe(false)
  })

  it('после отказа автоподкачка ОСТАНАВЛИВАЕТСЯ', () => {
    // Иначе экран уходит в бесконечный цикл запросов к недоступному порталу, и человек не видит
    // даже сообщения об ошибке.
    expect(shouldLoadMore({ hasMore: true, loading: false, failed: true })).toBe(false)
  })

  it('конец списка останавливает подкачку', () => {
    expect(shouldLoadMore({ hasMore: false, loading: false, failed: false })).toBe(false)
  })

  it('всё в порядке — грузим', () => {
    expect(shouldLoadMore({ hasMore: true, loading: false, failed: false })).toBe(true)
  })
})

describe('#458: подписи строки', () => {
  it('время показывается КАК У ПОРТАЛА, без пересчёта в пояс браузера', () => {
    // Иначе сотрудник в другом городе увидел бы у своего импорта не то время, что стоит рядом в
    // карточке CRM.
    expect(formatJournalDate('2026-08-08T10:00:00+03:00')).toBe('08.08.2026 10:00')
  })

  it('нераспознанная дата — пусто, а не «Invalid Date»', () => {
    for (const bad of ['', 'вчера', '2026-08-08', null as unknown as string]) {
      expect(formatJournalDate(bad)).toBe('')
    }
  })

  it('исход подписан словами, а не только цветом', () => {
    // Цвет один не читается программой чтения и не различается при дальтонизме.
    expect(journalOutcomeLabel(true)).toBe('Без замечаний')
    expect(journalOutcomeLabel(false)).toBe('С замечаниями')
  })
})
