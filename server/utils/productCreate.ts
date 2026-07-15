import type { RestCall } from './b24Rest'
import type { DocumentItem } from '~/types/document'
import type { PortalMapping } from '~/types/mapping'
import { normalizePropertyKey } from './productLookup'

// Create a catalog product for mapping.product.onMissing === 'create' (crm.product.add).
// DI over RestCall. Live-verified on B24_HOOK: only NAME is required; crm.product.add
// returns the new id directly as `result`; a supplier-article property (e.g. PROPERTY_99,
// type S) set as a plain string is stored AND re-found by the `%PROPERTY_<id>` LIKE filter
// — so a product we create is matched by findProductByArticle on the NEXT import instead of
// being re-created. (PRICE/CURRENCY passed to add did NOT stick via this simple path and
// are irrelevant here anyway — the deal ROW carries the document price, not the product.)
//
// Two KNOWN round-trip limits (both re-create a duplicate on the next import; both are
// pathological and low-impact — a duplicate is no worse than the pre-createProduct freeform):
//   1. NAME longer than 255 chars is capped on create but findProductByName searches the
//      full untruncated name → no match. Names that long are extraction artefacts.
//   2. An article that itself contains the configured `string` delimiter (e.g. delimiter ','
//      + article "A,B") is stored verbatim but parseSupplierArticles splits the stored value
//      on read → the whole "A,B" no longer matches. A delimiter char inside a single supplier
//      code is unusual; the admin picks a delimiter that doesn't occur in the codes.

/** Catalog product NAME cap (kept well under B24's limit). */
const MAX_PRODUCT_NAME = 255

/**
 * Build the crm.product.add `fields`. Always sets NAME; when the portal matches products
 * by ARTICLE and the document line carries one, also writes the supplier-article property
 * so the created product is findable next time (no duplicate on re-import). Pure.
 */
export function buildCreateProductFields(item: DocumentItem, mapping: PortalMapping): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    NAME: ((item.name ?? '').trim() || '(без наименования)').slice(0, MAX_PRODUCT_NAME)
  }
  const article = (item.article ?? '').trim()
  if (mapping.product.by === 'article' && article) {
    const key = normalizePropertyKey(mapping.article.field)
    if (key) fields[key] = article
  }
  return fields
}

/**
 * Create a catalog product; returns its id, or null when it can't be created (no name, or
 * an unexpected non-id response) so the caller degrades to a freeform row + a warning.
 */
export async function createProductViaRest(item: DocumentItem, mapping: PortalMapping, call: RestCall): Promise<number | null> {
  if (!(item.name ?? '').trim()) return null
  const res = await call('crm.product.add', { fields: buildCreateProductFields(item, mapping) })
  const id = Number(res)
  return Number.isInteger(id) && id > 0 ? id : null
}
