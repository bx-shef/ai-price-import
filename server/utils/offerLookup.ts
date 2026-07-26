import type { RestCall } from './b24Rest'

// Trade-offer (SKU / «торговое предложение») lookup for crm-sync. Offers live in a SEPARATE iblock
// linked to the product iblock: `catalog.catalog.list` returns one catalog per iblock, and the one whose
// `productIblockId` is set IS the offers catalog (its `iblockId` is the offers iblock; the base-product
// catalog has `productIblockId: null`). A document's printed article often IS the offer's XML_ID (the
// base product carries a DIFFERENT XML_ID), so crm-sync searches offers FIRST and prefers them over the
// base product — owner ask «приоритет отдавать товару SKU». ACTIVE-only.
//
// LIVE-VERIFIED on bel.bitrix24.by: offers iblock 27 (productIblockId 25); `catalog.product.offer.list`
// REQUIRES `iblockId` in BOTH filter AND select; filtering by `xmlId`/`name`+`active:'Y'` returns the
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
 *  returns `{ catalogs: [...] }` (or a bare array on some portals). */
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

/** Find an ACTIVE offer id by exact name, or null. */
export async function findOfferByName(name: string, iblockId: number, call: RestCall): Promise<number | null> {
  const q = (name ?? '').trim()
  if (!q || !iblockId) return null
  const res = await call('catalog.product.offer.list', {
    select: ['id', 'iblockId'],
    filter: { iblockId, name: q, active: 'Y' }
  }) as { offers?: unknown } | undefined
  return minOfferId(res?.offers)
}

/** Resolve a document line to an offer id: by article-as-xmlId first (the strong signal), then by exact
 *  name. Null when no offers iblock or nothing matched. */
export async function findOfferForItem(article: string | undefined, name: string, iblockId: number | null, call: RestCall): Promise<number | null> {
  if (!iblockId) return null
  const byArticle = article ? await findOfferByXmlId(article, iblockId, call) : null
  if (byArticle) return byArticle
  return findOfferByName(name, iblockId, call)
}
