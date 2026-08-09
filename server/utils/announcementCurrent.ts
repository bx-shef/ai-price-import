import { announcementRedis } from './announcementRedis'
import { readAnnouncement } from './announcementStore'
import { connectionOptions } from '../queue/connection'
import type { Announcement } from '~/utils/announcement'

/**
 * Действующее объявление для живого сервиса (#469).
 *
 * ⚠ Один хелпер на оба роута — портальный и служебный: две независимые копии проводки означали бы,
 * что консоль оператора однажды покажет не то, что видят клиенты, а это ровно та ошибка, от которой
 * защищает серверный предпросмотр.
 */
export function currentAnnouncement(): Promise<Announcement | null> {
  return readAnnouncement(
    announcementRedis(connectionOptions()),
    Date.now(),
    m => console.warn(`[announcement] ${m}`)
  )
}
