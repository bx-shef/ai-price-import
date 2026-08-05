import { describe, expect, it } from 'vitest'
import { getLegalNotice, markNoticeChatSent, markNoticeShown, portalsAwaitingNoticeChat } from '../server/utils/legalNoticeStore'

// #418. Фейк ИСПОЛНЯЕТ конфликт-ветку из самого SQL, а не реализует её по памяти автора теста —
// иначе мутация «переписать COALESCE на прямое присваивание» проходила бы зелёной: проверялся бы
// фейк, а не запрос, который уйдёт в Postgres. Тот же приём, что в тесте согласия (#414).
interface Row { member_id: string, edition_key: string, shown_at: Date | null, chat_sent_at: Date | null }

function memoryDb(portals: string[] = []) {
  const rows: Row[] = []
  let clock = 0
  const query = async (sql: string, params: unknown[] = []) => {
    const s = sql.trim()
    if (s.startsWith('SELECT shown_at')) {
      const r = rows.find(x => x.member_id === params[0] && x.edition_key === params[1])
      return { rows: r ? [r] : [] }
    }
    if (s.startsWith('SELECT t.member_id')) {
      const key = String(params[0])
      const after = String(params[1])
      const out = portals
        .filter(p => p > after)
        .filter(p => !rows.find(x => x.member_id === p && x.edition_key === key && x.chat_sent_at))
        .slice(0, Number(params[2]))
      return { rows: out.map(member_id => ({ member_id })) }
    }
    if (s.startsWith('INSERT')) {
      const [id, key] = params as string[]
      const now = new Date(++clock)
      const field = /shown_at\)/.test(sql) ? 'shown_at' : 'chat_sent_at'
      const existing = rows.find(x => x.member_id === id && x.edition_key === key)
      if (!existing) {
        rows.push({ member_id: id!, edition_key: key!, shown_at: null, chat_sent_at: null, [field]: now } as Row)
      } else if (/DO UPDATE/i.test(sql)) {
        // COALESCE(старое, now()) — первое значение выигрывает; прямое присваивание перезаписало бы.
        const keepsFirst = new RegExp(`COALESCE\\(portal_legal_notice\\.${field}`).test(sql)
        if (!keepsFirst || existing[field] == null) existing[field] = now
      }
      return { rows: [] }
    }
    return { rows: [] }
  }
  return { rows, query: query as never }
}

describe('#418: отметки об уведомлении', () => {
  it('уведомления не было — отметки нет', async () => {
    const db = memoryDb()
    expect(await getLegalNotice('m1', 'eula@2026-09-01', db.query)).toBeNull()
  })

  it('запоминается ПЕРВЫЙ показ, повторные его не сдвигают', async () => {
    // ⚠ Доказывать нужно раннюю дату — что уведомили вовремя. Каждый следующий показ (другой
    // сотрудник, другая вкладка, перезагрузка) двигал бы её вперёд, то есть портил бы ровно то,
    // ради чего отметка заведена.
    const db = memoryDb()
    await markNoticeShown('m1', 'eula@2026-09-01', db.query)
    const first = (await getLegalNotice('m1', 'eula@2026-09-01', db.query))!.shownAt
    await markNoticeShown('m1', 'eula@2026-09-01', db.query)
    expect((await getLegalNotice('m1', 'eula@2026-09-01', db.query))!.shownAt).toEqual(first)
  })

  it('две даты живут отдельно: показ не затирает отправку и наоборот', async () => {
    // П. 9.3.4 датирует доставку по наиболее ранней из двух — одно общее поле ответа «когда» не дало бы.
    const db = memoryDb()
    await markNoticeChatSent('m1', 'eula@2026-09-01', db.query)
    await markNoticeShown('m1', 'eula@2026-09-01', db.query)
    const m = (await getLegalNotice('m1', 'eula@2026-09-01', db.query))!
    expect(m.chatSentAt).not.toBeNull()
    expect(m.shownAt).not.toBeNull()
    expect(m.chatSentAt!.getTime()).toBeLessThan(m.shownAt!.getTime())
  })

  it('редакции не смешиваются', async () => {
    const db = memoryDb()
    await markNoticeShown('m1', 'eula@2026-09-01', db.query)
    expect(await getLegalNotice('m1', 'privacy@2026-09-01', db.query)).toBeNull()
  })

  it('в очередь на отправку попадает и портал без единой отметки', async () => {
    // ⚠ Портал, установивший приложение уже ПОСЛЕ публикации, отметок не имеет вовсе. Выборка
    // «где chat_sent_at пуст» по таблице отметок его бы не нашла, и уведомление не ушло бы.
    const db = memoryDb(['m1', 'm2'])
    expect(await portalsAwaitingNoticeChat('eula@2026-09-01', 10, '', db.query)).toEqual(['m1', 'm2'])
    await markNoticeChatSent('m1', 'eula@2026-09-01', db.query)
    expect(await portalsAwaitingNoticeChat('eula@2026-09-01', 10, '', db.query)).toEqual(['m2'])
  })

  it('показ баннера не считается отправкой в чат', async () => {
    // Иначе портал, где кто-то открыл приложение, выпадал бы из рассылки — а п. 9.3.3 требует
    // ОБА способа одновременно, а не любой на выбор.
    const db = memoryDb(['m1'])
    await markNoticeShown('m1', 'eula@2026-09-01', db.query)
    expect(await portalsAwaitingNoticeChat('eula@2026-09-01', 10, '', db.query)).toEqual(['m1'])
  })
})
