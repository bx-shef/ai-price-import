import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { handleAnnouncementOp } from '../../utils/announcementOpsHandler'
import { announcementRedis } from '../../utils/announcementRedis'
import { clearAnnouncement, writeAnnouncement } from '../../utils/announcementStore'
import { connectionOptions } from '../../queue/connection'

// POST /api/ops/announcement — завести, посмотреть или снять объявление издателя (#469).
// Сессия оператора + CSRF-заголовок, как у остальной служебной зоны.
//
// Действия: `preview` (проверить и посмотреть, ничего не пишет), `publish` (требует `confirm:true`),
// `clear` (снять досрочно). Решение целиком в чистой `handleAnnouncementOp` — роут только связывает
// её с живым хранилищем.
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const body = await readBody(event).catch(() => ({})) as {
    action?: unknown
    confirm?: unknown
    draft?: Record<string, unknown>
  }
  const redis = announcementRedis(connectionOptions())
  const res = await handleAnnouncementOp(body?.action, body?.draft ?? {}, body?.confirm, {
    publish: a => writeAnnouncement(redis, a, Date.now()),
    clear: () => clearAnnouncement(redis),
    now: () => Date.now()
  })
  setResponseStatus(event, res.status)
  return res.body
})
