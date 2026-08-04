import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { recordConsent } from '../utils/consentStore'
import { currentEditions } from '../utils/legalEditions'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query, dbEnabled } from '../db/client'

// POST /api/consent — зафиксировать принятие Лицензионного соглашения и Политики (#414).
//
// ⚠ Тело запроса НЕ читается вовсе, и это осознанно. Редакции сервер берёт у себя
// (`currentEditions()`, из тех же файлов, что отдаёт на `/eula` и `/privacy`): запись о согласии —
// доказательство, а доказательство, содержание которого диктует проверяемая сторона, ничего не
// стоит. Клиенту нечего сюда прислать, поэтому и парсить нечего.
//
// ⚠ Идентификатор сотрудника не пишется НИКОГДА — ни в строку, ни в спан. Лицензиат это
// организация (п. 2.7 EULA), и запись «кто именно из сотрудников нажал» расширила бы состав
// персональных данных, ничего не доказывая дополнительно.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.consent.post', method: 'POST', op: 'consent.accept', domain: auth?.domain },
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
      const member = await resolveFrameMember(auth, { query })
      if (!member.ok || !member.memberId) {
        span.outcome = 'auth_failed'
        setResponseStatus(event, member.status ?? 401)
        return { error: 'auth failed' }
      }
      // Принять условия за организацию вправе только администратор портала — тот же гейт, что у
      // записи настроек (#182). Рядовой сотрудник организацию не связывает.
      if (!member.admin) {
        span.outcome = 'forbidden'
        setResponseStatus(event, 403)
        return { error: 'admin only' }
      }
      await recordConsent(member.memberId, currentEditions(), query)
      return { accepted: true }
    }
  )
})
