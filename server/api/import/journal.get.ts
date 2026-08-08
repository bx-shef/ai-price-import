import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'
import { buildJournalQuery, mapJournalRows, JOURNAL_PAGE_SIZE } from '../../utils/importJournal'
import { originatorCode } from '../../utils/originMarker'
import { sdkPortalDeps, makePortalSdkCall } from '../../utils/b24Sdk'

// GET /api/import/journal — журнал импортов сотрудника: дела, которые приложение записало в
// таймлайн CRM (#458). Заменяет собой историю, которой у нас не было нигде: серверного списка
// заданий нет намеренно, а статус задания живёт 48 часов и адресуется только по id.
//
// ⚠ Читаем ТОКЕНОМ ПОРТАЛА, а не фрейм-токеном сотрудника. Причина не в удобстве: фрейм-токен
// несёт права своего пользователя, и у сотрудника без доступа к карточке дело просто не
// вернулось бы — журнал молча оказался бы неполным, причём у разных людей по-разному. Сужение до
// «своих» делает не портал, а НАШ фильтр по `RESPONSIBLE_ID`, и оно явное.
//
// ⚠ `RESPONSIBLE_ID` берётся из ПРОВЕРЕННОГО фрейм-токена (`profile.ID`), а не из запроса: id из
// query подделывается тривиально, и «только свои» стало бы декоративным.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.import-journal.get', method: 'GET', op: 'journal.load', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const member = await resolveFrameMember(auth, { query })
      if (!member.ok || !member.memberId) {
        span.outcome = 'auth_failed'
        setResponseStatus(event, member.status ?? 401)
        return { error: 'authorization failed', reason: member.reason }
      }
      // ⚠ Портал не сообщил, КТО спрашивает → журнала нет. Fail-closed: показать «все дела»
      // вместо «своих» здесь означало бы отдать сотруднику имена чужих документов, и по виду
      // экрана это неотличимо — список просто длиннее.
      if (!member.userId) {
        span.outcome = 'forbidden'
        setResponseStatus(event, 403)
        return { error: 'user id unavailable' }
      }
      const start = Number(getQuery(event).start ?? 0)
      const params = buildJournalQuery(originatorCode(process.env.IMPORT_ORIGINATOR_ID), member.userId, start)
      try {
        const transport = await makePortalSdkCall(member.memberId, sdkPortalDeps({
          query,
          clientId: process.env.B24_CLIENT_ID ?? '',
          clientSecret: process.env.B24_CLIENT_SECRET ?? '',
          encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
          now: () => Date.now()
        }))
        if (!transport) {
          span.outcome = 'conflict'
          setResponseStatus(event, 409)
          return { error: 'portal not authorised (no token)' }
        }
        const res = await transport.call('crm.activity.list', params) as unknown
        const rows = mapJournalRows(Array.isArray(res) ? res : (res as { items?: unknown })?.items)
        // `hasMore` считается по РАЗМЕРУ СТРАНИЦЫ, а не по `total`: список отфильтрован нашим
        // маркером, и total портала описывает не ту выборку, которую видит человек.
        return { rows, hasMore: rows.length >= JOURNAL_PAGE_SIZE, start }
      } catch {
        // ⚠ Отказ чтения — НЕ пустой журнал. «Импортов не было» и «мы не смогли посмотреть» для
        // человека противоположны по смыслу, а выглядят одинаково: пустой список. Это ровно тот
        // дефект, который чинили в #408, поэтому здесь честный код ошибки.
        span.outcome = 'upstream_error'
        setResponseStatus(event, 502)
        return { error: 'journal unavailable' }
      }
    }
  )
})
