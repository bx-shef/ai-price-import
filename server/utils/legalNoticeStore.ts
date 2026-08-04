import type { QueryFn } from './tokenStore'

// Отметки об уведомлении об изменении документов (#418, п. 9.3.4 EULA). Над инъектируемым `QueryFn`
// — тестируется без базы, как остальные сторы.
//
// ⚠ Уровень ПОРТАЛА, не сотрудника, и столбца под сотрудника здесь нет. Лицензиат — организация
// (п. 2.7 EULA); запись «кто увидел баннер» расширила бы состав персональных данных, ничего не
// доказывая: доставка адресована лицензиату, а не конкретному человеку. Та же логика, что у экрана
// согласия.
//
// ⚠ Две даты хранятся ОТДЕЛЬНО, потому что п. 9.3.4 определяет момент доставки по наиболее ранней
// из них. Одно поле «уведомлён» ответа на вопрос «когда» не дало бы.

export interface LegalNoticeMark {
  /** Когда баннер впервые показали в этом портале. `null` — ещё не показывали. */
  shownAt: Date | null
  /** Когда ушло сообщение в чат портала. `null` — ещё не отправляли. */
  chatSentAt: Date | null
}

const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(String(v)))

/** Отметки портала по конкретной редакции. `null` — уведомления ещё не было вовсе. */
export async function getLegalNotice(memberId: string, editionKey: string, query: QueryFn): Promise<LegalNoticeMark | null> {
  const { rows } = await query(
    'SELECT shown_at, chat_sent_at FROM portal_legal_notice WHERE member_id=$1 AND edition_key=$2',
    [memberId, editionKey]
  )
  const r = rows[0]
  if (!r) return null
  return { shownAt: toDate(r.shown_at), chatSentAt: toDate(r.chat_sent_at) }
}

/**
 * Отметить ПЕРВЫЙ показ баннера.
 *
 * ⚠ Именно первый: `DO NOTHING` по уже заполненному полю. Каждый следующий показ (другой сотрудник,
 * другая вкладка, перезагрузка) сдвигал бы дату вперёд, а доказывать нужно раннюю — что уведомили
 * вовремя, а не что показывали и позже.
 */
export async function markNoticeShown(memberId: string, editionKey: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_legal_notice (member_id, edition_key, shown_at)
     VALUES ($1, $2, now())
     ON CONFLICT (member_id, edition_key) DO UPDATE SET shown_at = COALESCE(portal_legal_notice.shown_at, now())`,
    [memberId, editionKey]
  )
}

/**
 * Отметить отправку сообщения в чат.
 *
 * ⚠ Тоже только первую — и это же поле служит защитой от повтора: п. 9.3.3 требует уведомить, а не
 * писать в чужой чат на каждом тике крона.
 */
export async function markNoticeChatSent(memberId: string, editionKey: string, query: QueryFn): Promise<void> {
  await query(
    `INSERT INTO portal_legal_notice (member_id, edition_key, chat_sent_at)
     VALUES ($1, $2, now())
     ON CONFLICT (member_id, edition_key) DO UPDATE SET chat_sent_at = COALESCE(portal_legal_notice.chat_sent_at, now())`,
    [memberId, editionKey]
  )
}

/**
 * Порталы, которым сообщение по этой редакции ещё не уходило.
 *
 * ⚠ Отбор идёт от таблицы порталов, а не от отметок: портал, установивший приложение уже ПОСЛЕ
 * публикации, отметки не имеет вовсе, и выборка «где chat_sent_at пуст» его бы не нашла.
 */
export async function portalsAwaitingNoticeChat(editionKey: string, limit: number, query: QueryFn): Promise<string[]> {
  const { rows } = await query(
    `SELECT t.member_id FROM portal_tokens t
      LEFT JOIN portal_legal_notice n ON n.member_id = t.member_id AND n.edition_key = $1
      WHERE n.chat_sent_at IS NULL
      ORDER BY t.member_id
      LIMIT $2`,
    [editionKey, limit]
  )
  return rows.map(r => String(r.member_id))
}
