// ⚠ Импорт ОТНОСИТЕЛЬНЫЙ, не по алиасу `~/`: этот модуль читает `nuxt.config.ts` (список маршрутов
// пререндера), а конфиг грузится jiti — алиасы Nuxt там ещё не существуют, и сборка падает
// `Cannot find module '~/config/legalArchive'`.
import { LEGAL_ARCHIVE, type LegalArchiveDoc, type LegalEditionEntry } from '../config/legalArchive'

// Чистые хелперы архива редакций (#415): адреса, признак действующей, список для пререндера.
// Данные — в `app/config/legalArchive.ts`, здесь только вычисления над ними.

/** Постоянный адрес текста редакции. Однажды опубликованный, он не меняется никогда. */
export function editionPath(slug: string, date: string): string {
  return `/${slug}/archive/${date}`
}

/** Адрес архива документа. */
export function archivePath(slug: string): string {
  return `/${slug}/archive`
}

/** Документ по сегменту адреса, `null` — такого нет. */
export function findArchiveDoc(slug: string): LegalArchiveDoc | null {
  return LEGAL_ARCHIVE.find(d => d.slug === slug) ?? null
}

/** Редакция по дате, `null` — такой нет. */
export function findEdition(slug: string, date: string): LegalEditionEntry | null {
  return findArchiveDoc(slug)?.editions.find(e => e.date === date) ?? null
}

/**
 * Действующая редакция — та, у которой нет даты замены.
 *
 * ⚠ Признак «действующая» берётся из ДАННЫХ (`supersededAt === null`), а не «первая в списке» и не
 * сравнением дат с сегодняшним днём. Первая в списке — это порядок вывода, он не обязан совпадать
 * со смыслом; сравнение с «сегодня» сделало бы страницу зависящей от часов сервера и от того,
 * успел ли кто-то переключить редакцию, — а действующей она становится не в полночь, а когда
 * издатель опубликовал замену.
 */
export function isCurrentEdition(e: LegalEditionEntry): boolean {
  return e.supersededAt === null
}

/** Дата замены для показа: у действующей — прочерк. */
export function supersededLabel(e: LegalEditionEntry): string {
  return e.supersededAt ?? '—'
}

/** Все адреса архива — для пререндера и sitemap. Один источник, чтобы списки не разъехались. */
export function allArchiveRoutes(): string[] {
  const routes: string[] = []
  for (const doc of LEGAL_ARCHIVE) {
    routes.push(archivePath(doc.slug))
    for (const e of doc.editions) routes.push(editionPath(doc.slug, e.date))
  }
  return routes
}
