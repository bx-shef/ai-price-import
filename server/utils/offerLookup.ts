import type { RestCall } from './b24Rest'
import type { ArticleFieldConfig } from '~/types/mapping'
import { articleMatches, parseSupplierArticles } from '~/utils/supplierArticles'

// Trade-offer (SKU / «торговое предложение») lookup for crm-sync. Offers live in a SEPARATE iblock
// linked to the product iblock: `catalog.catalog.list` returns one catalog per iblock, and the one whose
// `productIblockId` is set IS the offers catalog (its `iblockId` is the offers iblock; the base-product
// catalog has `productIblockId: null`). A document's printed article often IS the offer's XML_ID (the
// base product carries a DIFFERENT XML_ID), so crm-sync searches offers FIRST and prefers them over the
// base product — owner ask «приоритет отдавать товару SKU». ACTIVE-only.
//
// LIVE-VERIFIED on bel.bitrix24.by: offers iblock 27 (productIblockId 25); `catalog.product.offer.list`
// REQUIRES `iblockId` in BOTH filter AND select; filtering by `xmlId`+`active:'Y'` returns the
// offer; a wrong xmlId → []; and a deal productRow accepts an OFFER id as `productId` (the row shows the
// offer's name). All FAIL-SOFT: a portal without an offers catalog (or without the catalog subscription)
// yields null and the caller falls back to the base-product lookup — the pre-offer behaviour.

/** Smallest positive `id` among offer rows, or null. */
function minOfferId(offers: unknown): number | null {
  if (!Array.isArray(offers) || !offers.length) return null
  const ids = offers.map(o => Number((o as Record<string, unknown>)?.id)).filter(n => Number.isInteger(n) && n > 0)
  return ids.length ? Math.min(...ids) : null
}

/** Resolve the portal's offers iblock id, or null when it has no SKU catalog. `catalog.catalog.list`
 *  returns `{ catalogs: [...] }` (or a bare array on some portals).
 *  ⚠ SINGLE-CATALOG assumption: returns the FIRST catalog whose `productIblockId` is set. A portal with
 *  MULTIPLE product catalogs (each with its own offers iblock) would bind offer lookup to whichever
 *  appears first — offers for items in a different catalog wouldn't be found (they'd fail-soft to the
 *  base-product lookup, not error). Acceptable for the common single-catalog CRM setup; revisit
 *  (resolve per-product iblock) if multi-catalog portals become a target. */
export async function resolveOffersIblockId(call: RestCall): Promise<number | null> {
  const res = await call('catalog.catalog.list', {}) as Record<string, unknown> | undefined
  const catalogs = (Array.isArray(res) ? res : (res?.catalogs as unknown[])) ?? []
  for (const raw of catalogs as Array<Record<string, unknown>>) {
    const productIblockId = Number(raw?.productIblockId)
    const iblockId = Number(raw?.iblockId ?? raw?.id)
    // The offers catalog is the one that POINTS at a product iblock.
    if (Number.isInteger(productIblockId) && productIblockId > 0 && Number.isInteger(iblockId) && iblockId > 0) return iblockId
  }
  return null
}

/** Find an ACTIVE offer id by external code (xmlId), or null. `iblockId` is required by the method in
 *  both filter and select. */
export async function findOfferByXmlId(xmlId: string, iblockId: number, call: RestCall): Promise<number | null> {
  const q = (xmlId ?? '').trim()
  if (!q || !iblockId) return null
  const res = await call('catalog.product.offer.list', {
    select: ['id', 'iblockId'],
    filter: { iblockId, xmlId: q, active: 'Y' }
  }) as { offers?: unknown } | undefined
  return minOfferId(res?.offers)
}

/**
 * Найти торговое предложение по СВОЙСТВУ, хранящему артикул поставщика.
 *
 * ⚠ Сверка точного совпадения на клиенте здесь ОБЯЗАТЕЛЬНА, и не только против подстрочных ложных
 * попаданий. Живая находка 2026-08-05: портал **молча игнорирует** фильтр по свойству, которого в
 * инфоблоке нет, и возвращает ВСЕ предложения. Без сверки первое из них уехало бы в запись клиента
 * как подобранный товар — то есть чужая позиция, и заметить это было бы нечем. У базового товара
 * такая сверка есть с самого начала и спасает его ровно от этого же.
 *
 * ⚠ Значение свойства предложения приходит объектом `{ value, valueId }` (проверено вживую), а не
 * строкой, — в отличие от `crm.product.list`, где приходит и то и другое.
 */
export async function findOfferByProperty(article: string, cfg: ArticleFieldConfig, iblockId: number, call: RestCall): Promise<number | null> {
  const q = (article ?? '').trim()
  const propId = numericPropertyId(cfg.field)
  if (!q || !propId || !iblockId) return null
  const key = `property${propId}`
  const res = await call('catalog.product.offer.list', {
    select: ['id', 'iblockId', key],
    filter: { iblockId, [`%${key}`]: q, active: 'Y' }
  }) as { offers?: Array<Record<string, unknown>> } | undefined
  const rows = res?.offers
  if (!Array.isArray(rows) || !rows.length) return null
  const matched: number[] = []
  for (const r of rows) {
    const id = Number(r.id)
    if (!Number.isFinite(id) || id <= 0) continue
    if (articleMatches(q, parseSupplierArticles(offerPropValue(r[key]), cfg))) matched.push(id)
  }
  return matched.length ? Math.min(...matched) : null
}

/** `PROPERTY_130` / `130` → `130`. Символьный код отвергается: фильтр строится по числовому id. */
function numericPropertyId(field: string): number | null {
  const f = (field ?? '').trim().replace(/^PROPERTY_/i, '')
  return /^\d+$/.test(f) ? Number(f) : null
}

/** Значение свойства предложения: `{ value }` либо строка (портал отдаёт первое). */
function offerPropValue(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const v = (raw as { value: unknown }).value
    return typeof v === 'string' ? v : String(v ?? '')
  }
  return ''
}

/** Resolve a document line to an offer id by article-as-xmlId. Null when no offers iblock or nothing
 *  matched.
 *  ⚠ НАЗВАНИЯ ТОВАРА ЗДЕСЬ НЕТ И В СИГНАТУРЕ. Первая редакция оставляла его неиспользуемым
 *  параметром «чтобы легче было вернуть» — но возвращать нечего: по названию не ищем никогда, и
 *  параметр, который функция не читает, это ложь сигнатуры и приглашение снова начать читать. */
export async function findOfferForItem(article: string | undefined, iblockId: number | null, call: RestCall): Promise<number | null> {
  if (!iblockId) return null
  const byArticle = article ? await findOfferByXmlId(article, iblockId, call) : null
  if (byArticle) return byArticle
  // ⚠ По имени НЕ ищем — см. `productLookup.findProduct`: имя не идентификатор ни у товара, ни у
  // торгового предложения, а ошибочно подобранное ТП пишет в карточку клиента чужую позицию.
  return null
}
