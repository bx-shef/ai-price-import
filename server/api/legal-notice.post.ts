import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { markNoticeShown } from '../utils/legalNoticeStore'
import { announcedEditionKeys } from '../utils/legalNoticeEditions'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query, dbEnabled } from '../db/client'

// POST /api/legal-notice — отметить ПЕРВЫЙ показ баннера об изменении документов (#418, п. 9.3.4).
//
// ⚠ Ключ редакции из тела запроса принимается только если он есть в СЕРВЕРНОМ списке объявленных
// редакций. Иначе браузер мог бы записать порталу отметку о доставке уведомления, которого не было,
// — то есть подделать доказательство против самого лицензиата.
//
// ⚠ Идентификатор сотрудника не пишется никогда: отметка на уровне портала, как согласие (#414).
// Кто именно из сотрудников увидел баннер, ничего не доказывает — доставка адресована лицензиату.
//
// ⚠ Гейта администратора здесь НЕТ намеренно, в отличие от согласия: увидеть уведомление может
// любой сотрудник, и именно факт показа мы и фиксируем. Требовать прав администратора значило бы
// не засчитывать доставку, которая состоялась.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.legal-notice.post', method: 'POST', op: 'legal.notice.shown', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'no frame auth' }
      }
      if (!dbEnabled()) {
        span.outcome = 'no_db'
        setResponseStatus(event, 503)
        return { error: 'no store' }
      }
      const body = await readBody<{ edition?: unknown }>(event).catch(() => ({}))
      const edition = String((body as { edition?: unknown })?.edition ?? '')
      if (!announcedEditionKeys().includes(edition)) {
        span.outcome = 'bad_request'
        setResponseStatus(event, 400)
        return { error: 'unknown edition' }
      }
      const member = await resolveFrameMember(auth, { query })
      if (!member.ok || !member.memberId) {
        span.outcome = 'auth_failed'
        setResponseStatus(event, member.status ?? 401)
        return { error: 'auth failed' }
      }
      await markNoticeShown(member.memberId, edition, query)
      return { ok: true }
    }
  )
})
