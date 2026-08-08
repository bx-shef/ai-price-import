import {
  ANNOUNCEMENT_IMAGE_TYPES,
  MAX_ANNOUNCEMENT_CTA,
  MAX_ANNOUNCEMENT_DAYS,
  MAX_ANNOUNCEMENT_IMAGE_BYTES,
  MAX_ANNOUNCEMENT_TEXT,
  MAX_ANNOUNCEMENT_TITLE
} from '~/config/announcement'

// Объявление издателя (#469) — чистое ядро: что считается годным объявлением, живо ли оно сейчас и
// под каким ключом браузер помнит, что этот человек его уже видел.
//
// Зачем это есть. Издателю нужно иногда сказать что-то всем клиентам сразу — про акцию, про новую
// возможность, про плановые работы. Канала не было вовсе: чат портала занят рабочими
// уведомлениями об импорте, а письмо адресовать некому — почт мы не храним.
//
// ⚠ Это НЕ уведомление об изменении юридических документов (тот механизм удалён вместе с #418:
// принятие условий собирает Маркет при перевыпуске приложения). Смешивать нельзя ни в коде, ни на
// экране: «мы обязаны вам сообщить» и «у нас скидка» — разные вещи, и общий канал обесценивает
// первое.
//
// ⚠ Отметка «этот сотрудник видел» живёт ТОЛЬКО в браузере (`localStorage`), своего хранилища у
// неё нет — решение владельца. Плата названа честно: три браузера — три показа, очистка данных
// возвращает показ. Для объявления это допустимо; для юридического уведомления было бы нет, и
// именно поэтому у них разная механика.

export interface Announcement {
  /** Идентификатор редакции объявления: он же ключ «видел» в браузере. */
  id: string
  title: string
  text: string
  /** Картинка целиком, `data:`-URL. Пусто — объявление без картинки. */
  image?: string
  /** Ссылка кнопки. Пусто — кнопка только закрывает окно. */
  linkUrl?: string
  /** Подпись кнопки-ссылки. */
  linkLabel?: string
  /** Когда опубликовано (ISO). */
  publishedAt: string
  /** Когда перестаёт показываться (ISO, дата включительно не считается — сравниваем по времени). */
  expiresAt: string
}

/** Ключ, под которым браузер помнит, что этот человек объявление уже закрыл. */
export function announcementSeenKey(id: string): string {
  return `announcement-seen-${id}`
}

/**
 * Разобрать `data:`-URL картинки.
 *
 * ⚠ Проверяем ТИП и РАЗМЕР, а не только префикс `data:image/`. Тип — потому что `image/svg+xml`
 * это документ со скриптами, и он исполнился бы в контексте нашей страницы внутри чужого портала.
 * Размер — потому что картинка едет каждому сотруднику каждого портала при каждом открытии экрана.
 */
export function parseImageDataUrl(value: unknown): { ok: true, bytes: number } | { ok: false, reason: string } {
  if (typeof value !== 'string' || !value) return { ok: false, reason: 'картинка не указана' }
  const m = /^data:([a-z0-9/+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value.trim())
  if (!m) return { ok: false, reason: 'картинка должна быть data:-адресом в base64' }
  const type = (m[1] ?? '').toLowerCase()
  const data = m[2] ?? ''
  if (!(ANNOUNCEMENT_IMAGE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: `тип ${type} не разрешён: только ${ANNOUNCEMENT_IMAGE_TYPES.join(', ')}` }
  }
  // Длина base64 → размер исходных байт: каждые 4 знака дают 3 байта, минус «=» в хвосте.
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const bytes = Math.floor(data.length / 4) * 3 - padding
  if (bytes > MAX_ANNOUNCEMENT_IMAGE_BYTES) {
    return { ok: false, reason: `картинка больше ${Math.round(MAX_ANNOUNCEMENT_IMAGE_BYTES / 1024)} КБ` }
  }
  return { ok: true, bytes }
}

/** Адрес кнопки: только внешний `https`. */
export function isSafeAnnouncementLink(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    // ⚠ Разбираем `new URL`, а не проверяем префиксом: префиксная проверка пропускает `javascript:`
    // после пробела, подмену через userinfo (`https://ok@evil`) и перевод строки. Тот же урок, что
    // с базой краулерных файлов.
    const u = new URL(value.trim())
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Черновик из консоли оператора — всё поля строками, как их ввёл человек. */
export interface AnnouncementDraft {
  title?: unknown
  text?: unknown
  image?: unknown
  linkUrl?: unknown
  linkLabel?: unknown
  /** Сколько дней показывать. */
  days?: unknown
}

/**
 * Что не так с черновиком. Пустой список — можно публиковать.
 *
 * ⚠ Проверка живёт здесь, а не в форме: форму видит один человек, а роут вызывают из чего угодно,
 * и «интерфейс не даст ввести» защищает ровно до первого запроса руками.
 */
export function announcementProblems(draft: AnnouncementDraft): string[] {
  const problems: string[] = []
  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  const text = typeof draft.text === 'string' ? draft.text.trim() : ''
  if (!title) problems.push('заголовок пустой')
  else if (title.length > MAX_ANNOUNCEMENT_TITLE) problems.push(`заголовок длиннее ${MAX_ANNOUNCEMENT_TITLE} знаков`)
  if (!text) problems.push('текст пустой')
  else if (text.length > MAX_ANNOUNCEMENT_TEXT) problems.push(`текст длиннее ${MAX_ANNOUNCEMENT_TEXT} знаков`)

  if (draft.image !== undefined && draft.image !== '' && draft.image !== null) {
    const img = parseImageDataUrl(draft.image)
    if (!img.ok) problems.push(img.reason)
  }

  const hasUrl = draft.linkUrl !== undefined && draft.linkUrl !== '' && draft.linkUrl !== null
  const label = typeof draft.linkLabel === 'string' ? draft.linkLabel.trim() : ''
  if (hasUrl) {
    if (!isSafeAnnouncementLink(draft.linkUrl)) problems.push('ссылка должна начинаться с https://')
    // ⚠ Ссылка без подписи дала бы кнопку с пустым текстом — нажать её можно, понять нельзя.
    if (!label) problems.push('у ссылки нет подписи кнопки')
  }
  if (label.length > MAX_ANNOUNCEMENT_CTA) problems.push(`подпись кнопки длиннее ${MAX_ANNOUNCEMENT_CTA} знаков`)
  // Подпись без ссылки — не ошибка: кнопка просто закроет окно, и назвать её своими словами можно.

  const days = Number(draft.days)
  if (!Number.isFinite(days) || days < 1) problems.push('срок показа меньше суток')
  else if (days > MAX_ANNOUNCEMENT_DAYS) problems.push(`срок показа больше ${MAX_ANNOUNCEMENT_DAYS} дней`)
  return problems
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Собрать объявление из черновика.
 *
 * ⚠ Идентификатор считается ОТ ВРЕМЕНИ ПУБЛИКАЦИИ, а не от содержимого: у объявления с тем же
 * текстом, отправленного второй раз, обязан быть новый ключ — иначе те, кто закрыл первое,
 * не увидят второго, и повторная рассылка молча уйдёт в пустоту.
 */
export function buildAnnouncement(draft: AnnouncementDraft, nowMs: number): Announcement {
  const days = Math.max(1, Math.min(MAX_ANNOUNCEMENT_DAYS, Math.floor(Number(draft.days))))
  const label = typeof draft.linkLabel === 'string' ? draft.linkLabel.trim() : ''
  const url = isSafeAnnouncementLink(draft.linkUrl) ? String(draft.linkUrl).trim() : ''
  const image = typeof draft.image === 'string' && parseImageDataUrl(draft.image).ok ? draft.image.trim() : ''
  return {
    id: `a${nowMs.toString(36)}`,
    title: String(draft.title).trim(),
    text: String(draft.text).trim(),
    ...(image ? { image } : {}),
    ...(url ? { linkUrl: url } : {}),
    ...(label ? { linkLabel: label } : {}),
    publishedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + days * DAY_MS).toISOString()
  }
}

/**
 * Показывать ли объявление сейчас.
 *
 * ⚠ Срок проверяется и на сервере, и в браузере. На сервере — чтобы истёкшее не уезжало вовсе;
 * в браузере — потому что вкладку не перезагружают сутками, и оставленная открытой страница
 * показала бы окно уже после конца акции.
 * ⚠ Непрочитанная дата считается ИСТЁКШЕЙ, а не вечной: испорченное значение не должно давать
 * объявление, которое невозможно снять.
 */
export function isAnnouncementLive(a: Announcement | null, nowMs: number): boolean {
  if (!a) return false
  const ends = Date.parse(a.expiresAt)
  if (!Number.isFinite(ends)) return false
  return ends > nowMs
}

/** Сколько секунд объявлению осталось жить — срок хранения в Redis. */
export function announcementTtlSec(a: Announcement, nowMs: number): number {
  const ends = Date.parse(a.expiresAt)
  if (!Number.isFinite(ends)) return 0
  return Math.max(0, Math.ceil((ends - nowMs) / 1000))
}
