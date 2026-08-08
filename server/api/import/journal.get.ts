import { extractFrameAuth } from '../../utils/frameAuth'
import { resolveFrameMember } from '../../utils/resolveFrameMember'
import { withFrameRouteSpan } from '../../utils/frameRouteSpan'
import { query } from '../../db/client'
import { journalRequest } from '../../utils/journalHandler'
import { originatorCode } from '../../utils/originMarker'
import { sdkPortalDeps, makePortalSdkCall } from '../../utils/b24Sdk'

// GET /api/import/journal — журнал импортов сотрудника: дела, которые приложение записало в
// таймлайн CRM (#458). Заменяет собой историю, которой у нас не было нигде: серверного списка
// заданий нет намеренно, а статус задания живёт 48 часов и адресуется только по id.
//
// ⚠ Роут ТОНКИЙ: всё решение живёт в чистой `journalRequest` с внедрёнными зависимостями. У него
// пять исходов, четыре из которых — отказы, и внутри `defineEventHandler` они недостижимы тестом.
// Именно там стоит защита приватности: пропавшая проверка сотрудника превращает «мои импорты» в
// «импорты всего портала», и по виду экрана это неотличимо — список просто длиннее.
//
// ⚠ Читаем ТОКЕНОМ ПОРТАЛА, а не фрейм-токеном сотрудника. Причина не в удобстве: фрейм-токен
// несёт права своего пользователя, и у сотрудника без доступа к карточке дело просто не
// вернулось бы — журнал молча оказался бы неполным, причём у разных людей по-разному. Сужение до
// «своих» делает не портал, а НАШ фильтр по `RESPONSIBLE_ID`, и оно явное.
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
      const res = await journalRequest(getQuery(event).start, {
        authorize: () => resolveFrameMember(auth, { query }),
        resolveCall: async (memberId) => {
          const transport = await makePortalSdkCall(memberId, sdkPortalDeps({
            query,
            clientId: process.env.B24_CLIENT_ID ?? '',
            clientSecret: process.env.B24_CLIENT_SECRET ?? '',
            encKey: process.env.B24_TOKEN_ENC_KEY ?? '',
            now: () => Date.now()
          }))
          return transport ? (method, params) => transport.call(method, params) : null
        },
        originatorCode: originatorCode(process.env.IMPORT_ORIGINATOR_ID)
      })
      span.outcome = res.outcome
      if (res.status !== 200) setResponseStatus(event, res.status)
      return res.body
    }
  )
})
