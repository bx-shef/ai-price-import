import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { getConsent } from '../utils/consentStore'
import { currentEditions } from '../utils/legalEditions'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query, dbEnabled } from '../db/client'

// GET /api/consent — приняты ли документы этим порталом (#414).
//
// Отдаёт заодно действующие редакции: экран согласия обязан показать те даты, которые сервер
// запишет, — иначе человек видит одно, а в записи оказывается другое.
//
// ⚠ `admin` нужен экрану, чтобы не показывать неработающую кнопку: принять условия вправе только
// администратор (по п. 2.7 EULA устанавливающее лицо действует от имени организации, и рядовой
// сотрудник связать её не может). Настоящая проверка — на POST; здесь это подсказка интерфейсу.
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.consent.get', method: 'GET', op: 'consent.load', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'no frame auth' }
      }
      if (!dbEnabled()) {
        // Без базы согласие негде прочитать и негде записать. Отвечаем честным «недоступно», а не
        // `accepted:false` — иначе экран предложил бы нажать галочку, которую некуда сохранить.
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
      const consent = await getConsent(member.memberId, query)
      return {
        accepted: Boolean(consent),
        admin: member.admin === true,
        editions: currentEditions()
      }
    }
  )
})
