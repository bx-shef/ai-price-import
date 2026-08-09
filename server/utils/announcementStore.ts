import type { Announcement } from '~/utils/announcement'
import { announcementTtlSec, isAnnouncementLive } from '~/utils/announcement'

// Хранилище объявления издателя (#469) — ОДНО активное на весь сервис.
//
// ⚠ Своей таблицы нет и не будет (решение владельца): объявление живёт в Redis, там же, где очереди
// и счётчики. Плата названа вслух: без Redis объявление не сохраняется вовсе, а очистка Redis его
// теряет. Для новости про акцию это допустимо — в отличие от юридического уведомления, у которого
// как раз поэтому была своя таблица (механизм удалён вместе с #418 по другой причине).
//
// ⚠ Объявление ОДНО: новое замещает прежнее. Очередь объявлений была бы лишней сложностью — у
// издателя один продукт и один повод за раз, а два окна подряд человек закрывает не читая оба.

/** Ключ в Redis. Один на сервис — объявление не пер-портальное. */
export const ANNOUNCEMENT_KEY = 'announcement:current'

/** Минимальный контракт хранилища: только то, что нужно объявлению. */
export interface AnnouncementRedis {
  get: (key: string) => Promise<string | null>
  /** `ttlSec` ≤ 0 — не пишем вовсе (истёкшее объявление хранить незачем). */
  set: (key: string, value: string, ttlSec: number) => Promise<void>
  del: (key: string) => Promise<void>
}

/**
 * Прочитать действующее объявление.
 *
 * ⚠ Срок проверяется ЗДЕСЬ, а не только сроком жизни ключа: истечение ключа Redis происходит с
 * задержкой (пассивное удаление), и минуту-другую после конца акции ключ ещё читается. Показать
 * истёкшую акцию хуже, чем не показать действующую.
 * ⚠ Любая неудача — `null`, а не исключение: объявление это украшение, и оно не имеет права уронить
 * рабочий экран. Но `null` от «нет объявления» и `null` от «Redis молчит» для ВЫЗЫВАЮЩЕГО одинаковы
 * намеренно: сотруднику показывать в обоих случаях нечего, а различать их — забота журнала.
 */
export async function readAnnouncement(
  redis: AnnouncementRedis | null,
  nowMs: number,
  log?: (m: string) => void
): Promise<Announcement | null> {
  if (!redis) return null
  let raw: string | null
  try {
    raw = await redis.get(ANNOUNCEMENT_KEY)
  } catch {
    log?.('объявление не прочитано: хранилище недоступно')
    return null
  }
  if (!raw) return null
  let parsed: Announcement
  try {
    parsed = JSON.parse(raw) as Announcement
  } catch {
    log?.('объявление не разобрано — снимаем')
    return null
  }
  return isAnnouncementLive(parsed, nowMs) ? parsed : null
}

/**
 * Записать объявление. `false` — не сохранилось (нет хранилища или срок уже истёк).
 *
 * ⚠ Возврат честный, а не «ок» на всякий случай: отправка объявления это действие без отката, и
 * оператор обязан узнать, что оно НЕ ушло, в тот же момент — иначе он будет ждать реакции клиентов
 * от рассылки, которой не было.
 */
export async function writeAnnouncement(
  redis: AnnouncementRedis | null,
  a: Announcement,
  nowMs: number
): Promise<boolean> {
  if (!redis) return false
  const ttl = announcementTtlSec(a, nowMs)
  if (ttl <= 0) return false
  try {
    await redis.set(ANNOUNCEMENT_KEY, JSON.stringify(a), ttl)
    return true
  } catch {
    return false
  }
}

/** Снять объявление досрочно. `false` — не сняли (о чём оператору тоже говорим прямо). */
export async function clearAnnouncement(redis: AnnouncementRedis | null): Promise<boolean> {
  if (!redis) return false
  try {
    await redis.del(ANNOUNCEMENT_KEY)
    return true
  } catch {
    return false
  }
}
