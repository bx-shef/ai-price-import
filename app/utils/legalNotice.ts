// Уведомление об изменении юридических документов (#418, п. 9.3.2–9.3.6 EULA).
//
// Пункт 9.3.3 обязывает уведомлять ОДНОВРЕМЕННО двумя способами: сообщением в чат портала тому, кто
// установил приложение, и баннером в интерфейсе. Одного баннера мало — это публикация, а не
// уведомление: лицензиат, месяц не заходивший в приложение, о нём не узнает, а срок тем временем
// истечёт. Чат даёт доказуемую отправку, баннер — фактическую видимость; п. 9.3.4 считает моментом
// доставки наиболее раннюю из двух дат.
//
// Здесь — только чистые правила: сроки, окно показа и состав текста. Хранение отметок и отправка в
// чат живут на сервере.

/** Календарная дата `ГГГГ-ММ-ДД`. Время суток в этих правилах не участвует нигде. */
export type IsoDate = string

export interface PendingLegalEdition {
  /** Сегмент документа: `eula`, `privacy`, `site-terms`, `site-privacy`. */
  slug: string
  /** Заголовок документа — им подписан баннер. */
  title: string
  /** Дата новой редакции (`ГГГГ-ММ-ДД`) — она же её постоянный адрес в архиве. */
  date: IsoDate
  /** День публикации: с него баннер виден и не позднее него уходит сообщение в чат. */
  publishedAt: IsoDate
  /**
   * Существенное ли изменение.
   *
   * ⚠ От этого зависит СРОК (п. 9.3.2): 10 дней на обычные правки, 30 на существенные. Флаг
   * определяет дату вступления, а не наоборот — вбитая руками дата разъехалась бы со сроком
   * ровно тогда, когда на неё сошлются.
   */
  material: boolean
  /**
   * Что именно меняется — по существу, две-три строки.
   *
   * ⚠ «Условия обновлены» уведомлением НЕ является и в споре не засчитается: п. 9.3.3 требует
   * сообщить содержание изменений, а не факт правки. Пустой список запрещён — см. `noticeProblems`.
   */
  changes: string[]
  /** Дата предыдущей редакции — вторая ссылка баннера ведёт на её постоянный адрес. */
  previousDate: IsoDate | null
}

/** Сроки уведомления из п. 9.3.2. */
export const NOTICE_DAYS = { material: 30, minor: 10 } as const

/** Сколько дней обязаны предупредить. */
export function noticeDays(material: boolean): number {
  return material ? NOTICE_DAYS.material : NOTICE_DAYS.minor
}

/**
 * Дата вступления = день публикации + срок.
 *
 * ⚠ Считается, а не задаётся: срок привязан к признаку существенности, и любая рукописная дата
 * рано или поздно окажется короче обещанного — а это нарушение того самого пункта, ради которого
 * всё уведомление и существует.
 */
export function effectiveDate(edition: Pick<PendingLegalEdition, 'publishedAt' | 'material'>): IsoDate {
  const d = new Date(`${edition.publishedAt}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return edition.publishedAt
  d.setUTCDate(d.getUTCDate() + noticeDays(edition.material))
  return d.toISOString().slice(0, 10)
}

/**
 * Виден ли баннер сегодня.
 *
 * Окно — «с даты публикации ДО даты вступления»: в день вступления новая редакция уже действует,
 * и предупреждать не о чем. Границы: день публикации включён, день вступления — нет.
 */
export function isAnnouncementVisible(edition: PendingLegalEdition, today: IsoDate): boolean {
  return today >= edition.publishedAt && today < effectiveDate(edition)
}

/** Все объявления, которые сегодня показываем. */
export function visibleAnnouncements(editions: PendingLegalEdition[], today: IsoDate): PendingLegalEdition[] {
  return editions.filter(e => isAnnouncementVisible(e, today))
}

/** Устойчивый ключ редакции для отметок об уведомлении и для «скрыть до завтра». */
export function editionKey(edition: Pick<PendingLegalEdition, 'slug' | 'date'>): string {
  return `${edition.slug}@${edition.date}`
}

/** `ГГГГ-ММ-ДД` → `ДД.ММ.ГГГГ`: в документах и текстах дата печатается так. */
export function formatRuDate(iso: IsoDate): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso
}

/** Постоянный адрес редакции в архиве. */
export function editionArchivePath(slug: string, date: IsoDate): string {
  return `/${slug}/archive/${date}`
}

export interface LegalNoticeText {
  headline: string
  changes: string[]
  /** Ссылка на новую редакцию (сам документ — до вступления там ещё прежний текст, поэтому архив). */
  newHref: string
  /** Ссылка на редакцию, действующую до даты вступления. */
  currentHref: string | null
  currentLabel: string
  /** Право удалить приложение без последствий (п. 9.3.6). */
  optOut: string
}

/**
 * Состав уведомления — ОДИН на баннер и на сообщение в чат.
 *
 * ⚠ Два независимых текста разъехались бы, и тогда п. 9.3.4 («момент доставки — наиболее ранняя из
 * двух дат») стал бы неисполним: доставленными оказались бы разные уведомления.
 */
export function buildLegalNotice(edition: PendingLegalEdition): LegalNoticeText {
  const eff = formatRuDate(effectiveDate(edition))
  return {
    headline: `С ${eff} вступает в силу новая редакция документа «${edition.title}».`,
    changes: edition.changes,
    newHref: editionArchivePath(edition.slug, edition.date),
    currentHref: edition.previousDate ? editionArchivePath(edition.slug, edition.previousDate) : null,
    // ⚠ «Действующая до …» рядом с «Новая редакция» повисало грамматически и читалось как
    // продолжение первой ссылки: действующая — что?
    currentLabel: `Прежняя редакция (действует до ${eff})`,
    // ⚠ Формулировка прямая и без условий: п. 9.3.6 даёт это право безоговорочно, а мягкое
    // «вы можете рассмотреть возможность» читалось бы как приглашение к переговорам.
    optOut: `Если условия вам не подходят, приложение можно удалить с портала до ${eff} — без последствий.`
  }
}

/** Предел длины поля объявления в сообщении чата. */
export const MAX_NOTICE_FIELD = 400

/**
 * Обезвредить BB-разметку и обрезать поле объявления.
 *
 * ⚠ Текст объявления пишет ЧЕЛОВЕК (это и есть штатный порядок публикации редакции), а чат Битрикса
 * разбирает BB-коды. Квадратная скобка в описании изменения — `[см. п. 9.3]`, `[b]`, `[URL]` — съедается
 * парсером, и в чат клиента приходит битым ровно то сообщение, которое обязано быть безупречным.
 *
 * ⚠ Полный `chatSafeText` применять НЕЛЬЗЯ: он превращает двоеточие в полноширинное и тем ломает
 * `https://`, а ссылки на архив редакций здесь несущие — без них уведомление неполно.
 */
export function noticeChatField(raw: string): string {
  return String(raw ?? '').replace(/\[/g, '［').replace(/\]/g, '］').slice(0, MAX_NOTICE_FIELD)
}

/** Текст сообщения в чат: тот же состав, одним сообщением. */
export function buildLegalNoticeChat(edition: PendingLegalEdition, docUrl: (path: string) => string): string {
  const n = buildLegalNotice({ ...edition, title: noticeChatField(edition.title), changes: edition.changes.map(noticeChatField) })
  const lines = [n.headline, '', 'Что меняется:']
  for (const c of n.changes) lines.push(`— ${c}`)
  lines.push('', `Новая редакция: ${docUrl(n.newHref)}`)
  if (n.currentHref) lines.push(`${n.currentLabel}: ${docUrl(n.currentHref)}`)
  lines.push('', n.optOut)
  return lines.join('\n')
}

/**
 * Проверка объявления ПЕРЕД публикацией.
 *
 * ⚠ Существует потому, что цена ошибки несимметрична: уведомление с пустым «что меняется» или без
 * ссылки на прежнюю редакцию юридически не работает, но выглядит совершенно нормально — и это
 * выяснится только в споре. Пустой список изменений здесь запрещён прямо.
 */
export function noticeProblems(edition: PendingLegalEdition): string[] {
  const bad: string[] = []
  if (!isRealDate(edition.publishedAt)) bad.push('дата публикации не существует или не в формате ГГГГ-ММ-ДД')
  if (!isRealDate(edition.date)) bad.push('дата редакции не существует или не в формате ГГГГ-ММ-ДД')
  // ⚠ Дата предыдущей редакции — это ВТОРАЯ ссылка уведомления, и она обязана вести на живой
  // постоянный адрес. Опечатка здесь даёт 404 в сообщении, уже разосланном по чужим чатам, откуда
  // его не отозвать. Сверку с реестром архива делает отдельный тест — здесь хотя бы формат.
  if (edition.previousDate !== null && !isRealDate(edition.previousDate)) bad.push('дата предыдущей редакции не существует или не в формате ГГГГ-ММ-ДД')
  if (edition.changes.length === 0) bad.push('не сказано, что меняется — «условия обновлены» уведомлением не является')
  if (edition.changes.some(c => c.trim().length < 10)) bad.push('слишком короткое описание изменения')
  if (!edition.title.trim()) bad.push('нет названия документа')
  if (!edition.slug.trim()) bad.push('не указан документ')
  return bad
}

/**
 * Существует ли такая дата в календаре.
 *
 * ⚠ Регулярки МАЛО, и это не педантизм: `2026-02-31` ей соответствует, а `new Date` разбирает её
 * лениво и молча даёт 3 марта. Проверка формата пропускала опечатку, окно показа съезжало на три
 * дня, дата вступления в уведомлении переставала совпадать с обещанным сроком, а ссылка вела на
 * адрес редакции, которой не существует.
 */
function isRealDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}
