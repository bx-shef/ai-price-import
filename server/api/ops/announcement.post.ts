import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { handleAnnouncementOp } from '../../utils/announcementOpsHandler'
import { announcementRedis } from '../../utils/announcementRedis'
import { clearAnnouncement, writeAnnouncement } from '../../utils/announcementStore'
import { connectionOptions } from '../../queue/connection'
import { MAX_ANNOUNCEMENT_BODY_BYTES } from '~/config/announcement'

// POST /api/ops/announcement — завести, посмотреть или снять объявление издателя (#469).
// Гейт — сессия оператора, как у остальных `/api/ops/*`. Отдельного CSRF-заголовка в этом проекте
// нет ни у одного служебного роута: кука `SameSite=Lax` не уходит с кросс-сайтового POST, и второй
// слой добавлять надо всем сразу или никому. ⚠ В соседнем репозитории такой заголовок есть — не
// переносить сюда описание оттуда, не перенеся саму проверку.
//
// Действия: `preview` (проверить и посмотреть, ничего не пишет), `publish` (требует `confirm:true`),
// `clear` (снять досрочно). Решение целиком в чистой `handleAnnouncementOp` — роут только связывает
// её с живым хранилищем.
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  // ⚠ Кап тела ДО чтения: картинка едет в JSON, и без этого `readBody` разобрал бы сколь угодно
  // большой документ в память процесса. Роут под сессией оператора, то есть сторона доверенная, —
  // но «доверенная сторона» это про намерение, а не про случайно выбранный файл на 200 МБ.
  const declared = Number(getHeader(event, 'content-length') || 0)
  if (Number.isFinite(declared) && declared > MAX_ANNOUNCEMENT_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { error: `тело больше ${Math.round(MAX_ANNOUNCEMENT_BODY_BYTES / 1024)} КБ — уменьшите картинку` }
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
