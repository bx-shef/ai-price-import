import type { RestCall } from './b24Rest'
import type { ArticleFieldConfig } from '~/types/mapping'
import { findCatalogByProperty, findCatalogByXmlId, OFFER_SOURCE, resolveIblocks } from './catalogLookup'

// Trade-offer (SKU / «торговое предложение») lookup for crm-sync. Offers live in a SEPARATE iblock
// linked to the product iblock: `catalog.catalog.list` returns one catalog per iblock, and the one
// whose `productIblockId` is set IS the offers catalog. A document's printed article often IS the
// offer's xmlId (the base product carries a DIFFERENT one), so crm-sync searches offers FIRST —
// owner ask «приоритет отдавать товару SKU». ACTIVE-only.
//
// LIVE-VERIFIED on the test portal: offers iblock 27 (productIblockId 25); `catalog.product.offer.list`
// REQUIRES `iblockId` in BOTH filter AND select; filtering by `xmlId`+`active:'Y'` returns the offer;
// a wrong xmlId → []; and a deal productRow accepts an OFFER id as `productId` (the row shows the
// offer's name). All FAIL-SOFT: a portal without an offers catalog (or without the catalog
// subscription) yields null and the caller falls back to the base-product lookup.
//
// ⚠ Механика (сужение фильтром + сверка точного совпадения на клиенте + отбраковка неоднозначного
// внешнего кода) живёт в `catalogLookup.ts`, ОБЩАЯ с базовым товаром. Две копии одного правила
// разъезжаются: живая находка про молча игнорируемый фильтр по чужому свойству была записана
// только в одной из них.

/** Первый инфоблок предложений портала, либо null. ⚠ Именно ПЕРВЫЙ — это узкий помощник для мест,
 *  которым нужен один id; сам подбор перебирает ВСЕ каталоги (`productLookup.findProduct`). */
export async function resolveOffersIblockId(call: RestCall): Promise<number | null> {
  return (await resolveIblocks(call)).offer[0] ?? null
}

/** Find an ACTIVE offer id by external code (xmlId), or null. */
export async function findOfferByXmlId(xmlId: string, iblockId: number, call: RestCall): Promise<number | null> {
  return await findCatalogByXmlId(OFFER_SOURCE, xmlId, iblockId, call)
}

/** Найти торговое предложение по СВОЙСТВУ, хранящему артикул поставщика. */
export async function findOfferByProperty(article: string, cfg: ArticleFieldConfig, iblockId: number, call: RestCall): Promise<number | null> {
  return await findCatalogByProperty(OFFER_SOURCE, article, cfg, iblockId, call)
}

/** Resolve a document line to an offer id by article-as-xmlId. Null when no offers iblock or nothing
 *  matched.
 *  ⚠ НАЗВАНИЯ ТОВАРА ЗДЕСЬ НЕТ И В СИГНАТУРЕ. Первая редакция оставляла его неиспользуемым
 *  параметром «чтобы легче было вернуть» — но возвращать нечего: по названию не ищем никогда, и
 *  параметр, который функция не читает, это ложь сигнатуры и приглашение снова начать читать. */
export async function findOfferForItem(article: string | undefined, iblockId: number | null, call: RestCall): Promise<number | null> {
  if (!iblockId || !article) return null
  return await findOfferByXmlId(article, iblockId, call)
}
