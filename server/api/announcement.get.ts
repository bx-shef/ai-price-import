import { extractFrameAuth } from '../utils/frameAuth'
import { resolveFrameMember } from '../utils/resolveFrameMember'
import { announcementRedis } from '../utils/announcementRedis'
import { readAnnouncement } from '../utils/announcementStore'
import { connectionOptions } from '../queue/connection'
import { withFrameRouteSpan } from '../utils/frameRouteSpan'
import { query } from '../db/client'

// GET /api/announcement → { announcement } — действующее объявление издателя (#469) или `null`.
//
// Объявление ОДНО на весь сервис и одинаково для всех порталов (решение владельца: выборочной
// рассылки не делаем). Показывает его рабочий экран — модальным окном на компьютере и шторкой на
// телефоне, по одному разу на сотрудника; отметка «видел» живёт в браузере, на сервере её нет.
//
// ⚠ Гейт фрейм-токена стоит, хотя содержимое не секретное: роут отдаёт картинку в base64, и
// открытый наружу он стал бы бесплатной раздачей трафика с адреса издателя. Проверка та же, что у
// соседей, — заодно исход попадает в телеметрию единым способом.
// ⚠ НЕ admin-only: объявление адресовано всем сотрудникам (решение владельца).
export default defineEventHandler(async (event) => {
  const auth = extractFrameAuth(getHeaders(event) as Record<string, string | undefined>)
  return withFrameRouteSpan(
    { name: 'http.announcement.get', method: 'GET', op: 'announcement.load', domain: auth?.domain },
    async (span) => {
      if (!auth) {
        span.outcome = 'no_auth'
        setResponseStatus(event, 401)
        return { error: 'frame auth required' }
      }
      const resolved = await resolveFrameMember(auth, { query })
      if (!resolved.ok || !resolved.memberId) {
        span.outcome = 'auth_failed'
        setResponseStatus(event, resolved.status ?? 401)
        return { error: 'frame verification failed' }
      }
      // ⚠ Недоступное хранилище — это «объявления нет», а не 502: объявление украшение, и ронять
      // из-за него рабочий экран нельзя. Причина уходит в журнал одной строкой из ядра.
      const announcement = await readAnnouncement(
        announcementRedis(connectionOptions()),
        Date.now(),
        m => console.warn(`[announcement] ${m}`)
      )
      return { announcement }
    }
  )
})
