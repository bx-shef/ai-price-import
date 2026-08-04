import { describe, expect, it } from 'vitest'
import {
  NOTICE_DAYS,
  buildLegalNotice,
  buildLegalNoticeChat,
  editionKey,
  effectiveDate,
  formatRuDate,
  isAnnouncementVisible,
  noticeDays,
  noticeProblems,
  visibleAnnouncements,
  type PendingLegalEdition
} from '../app/utils/legalNotice'
import { PENDING_LEGAL_EDITIONS } from '../app/config/legalNotice'

const BASE: PendingLegalEdition = {
  slug: 'eula',
  title: 'Лицензионное соглашение',
  date: '2026-09-01',
  publishedAt: '2026-09-01',
  material: true,
  changes: ['Добавлен раздел о переносе на сервер клиента.', 'Срок хранения отзывов сокращён до 12 месяцев.'],
  previousDate: '2026-08-08'
}

describe('#418: сроки уведомления', () => {
  it('существенное изменение — 30 дней, обычное — 10', () => {
    // Срок из п. 9.3.2. Числа держим здесь: разъехавшись с документом, они дали бы уведомление
    // короче обещанного, а это нарушение того самого пункта.
    expect(noticeDays(true)).toBe(NOTICE_DAYS.material)
    expect(noticeDays(false)).toBe(NOTICE_DAYS.minor)
    expect(effectiveDate({ publishedAt: '2026-09-01', material: true })).toBe('2026-10-01')
    expect(effectiveDate({ publishedAt: '2026-09-01', material: false })).toBe('2026-09-11')
  })

  it('переход через границу месяца и года считается верно', () => {
    expect(effectiveDate({ publishedAt: '2026-12-25', material: false })).toBe('2027-01-04')
    expect(effectiveDate({ publishedAt: '2026-02-20', material: false })).toBe('2026-03-02')
  })
})

describe('#418: окно показа баннера', () => {
  it('день публикации включён, день вступления — уже нет', () => {
    // В день вступления новая редакция действует, предупреждать не о чем: баннер обязан исчезнуть
    // сам, без чьего-либо участия.
    expect(isAnnouncementVisible(BASE, '2026-09-01')).toBe(true)
    expect(isAnnouncementVisible(BASE, '2026-09-30')).toBe(true)
    expect(isAnnouncementVisible(BASE, '2026-10-01')).toBe(false)
    expect(isAnnouncementVisible(BASE, '2026-08-31')).toBe(false)
  })

  it('отбираются только идущие сегодня', () => {
    const past = { ...BASE, slug: 'privacy', publishedAt: '2026-01-01', date: '2026-01-01' }
    expect(visibleAnnouncements([BASE, past], '2026-09-05').map(e => e.slug)).toEqual(['eula'])
  })
})

describe('#418: состав уведомления', () => {
  const n = buildLegalNotice(BASE)

  it('названа дата вступления, что меняется и право удалить приложение', () => {
    // Три обязательных элемента п. 9.3.3/9.3.6. Без любого из них уведомление выглядит нормально,
    // но юридически не работает — и это выяснится только в споре.
    expect(n.headline).toContain('01.10.2026')
    expect(n.changes).toEqual(BASE.changes)
    expect(n.optOut).toContain('удалить с портала до 01.10.2026')
  })

  it('обе ссылки ведут в архив: новая редакция и действующая до даты вступления', () => {
    expect(n.newHref).toBe('/eula/archive/2026-09-01')
    expect(n.currentHref).toBe('/eula/archive/2026-08-08')
  })

  it('первой редакции не с чем сравнивать — второй ссылки нет, а не битая', () => {
    expect(buildLegalNotice({ ...BASE, previousDate: null }).currentHref).toBeNull()
  })

  it('сообщение в чат несёт тот же состав, что баннер', () => {
    // ⚠ Два независимых текста разъехались бы, и п. 9.3.4 («доставка по наиболее ранней из двух
    // дат») стал бы неисполним: доставленными оказались бы разные уведомления.
    const chat = buildLegalNoticeChat(BASE, p => `https://example.com${p}`)
    expect(chat).toContain('01.10.2026')
    for (const c of BASE.changes) expect(chat).toContain(c)
    expect(chat).toContain('https://example.com/eula/archive/2026-09-01')
    expect(chat).toContain('https://example.com/eula/archive/2026-08-08')
    expect(chat).toContain('удалить с портала')
  })
})

describe('#418: проверка перед публикацией', () => {
  it('корректное объявление проблем не имеет', () => {
    expect(noticeProblems(BASE)).toEqual([])
  })

  it('«условия обновлены» без содержания — не уведомление', () => {
    expect(noticeProblems({ ...BASE, changes: [] })).toContain('не сказано, что меняется — «условия обновлены» уведомлением не является')
    expect(noticeProblems({ ...BASE, changes: ['правки'] }).length).toBeGreaterThan(0)
  })

  it('кривые даты видны до публикации, а не после', () => {
    expect(noticeProblems({ ...BASE, publishedAt: '01.09.2026' }).length).toBeGreaterThan(0)
  })
})

describe('#418: реестр объявлений', () => {
  it('каждая запись проходит проверку', () => {
    // Пустой список — рабочее состояние: механизм обязан существовать ДО первого изменения
    // документов. Как только запись появится, она обязана быть годной.
    for (const e of PENDING_LEGAL_EDITIONS) {
      expect(noticeProblems(e), `${editionKey(e)}: ${noticeProblems(e).join('; ')}`).toEqual([])
    }
  })

  it('дата печатается по-русски', () => {
    expect(formatRuDate('2026-10-01')).toBe('01.10.2026')
    expect(formatRuDate('мусор')).toBe('мусор')
  })
})
