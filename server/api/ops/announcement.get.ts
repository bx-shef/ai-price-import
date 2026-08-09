import { OP_COOKIE, operatorAllowed } from '../../utils/operatorSession'
import { currentAnnouncement } from '../../utils/announcementCurrent'

// GET /api/ops/announcement → { announcement } — что сейчас показывается клиентам (#469).
// Сессия оператора. Нужен, чтобы владелец видел действующее объявление и мог снять его досрочно,
// не гадая по памяти.
export default defineEventHandler(async (event) => {
  if (!operatorAllowed(getCookie(event, OP_COOKIE), process.env, Date.now())) {
    setResponseStatus(event, 401)
    return { error: 'unauthorized' }
  }
  const announcement = await currentAnnouncement()
  return { announcement }
})
