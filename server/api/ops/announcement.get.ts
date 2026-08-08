import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { announcementRedis } from '../../utils/announcementRedis'
import { readAnnouncement } from '../../utils/announcementStore'
import { connectionOptions } from '../../queue/connection'

// GET /api/ops/announcement → { announcement } — что сейчас показывается клиентам (#469).
// Сессия оператора. Нужен, чтобы владелец видел действующее объявление и мог снять его досрочно,
// не гадая по памяти.
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const announcement = await readAnnouncement(
    announcementRedis(connectionOptions()),
    Date.now(),
    m => console.warn(`[announcement] ${m}`)
  )
  return { announcement }
})
