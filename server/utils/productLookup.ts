import type { RestCall } from './b24Rest'
import type { PortalMapping } from '~/types/mapping'
import type { DocumentItem } from '~/types/document'

// Deterministic product lookup for crm-sync (find_product tool body). DI over RestCall.
// Two strategies (mapping.product.by):
//   • 'name'    → exact product NAME via crm.product.list (verified live: {ID, NAME}).
//   • 'article' → the admin-configured catalog property (mapping.article.field) holding
//     the supplier article; falls back to NAME when no article printed / none matched.
// Live fact: the default CRM catalog (iblock 25) ships NO article property — only
// MORE_PHOTO/CML2_LINK — so article lookup is strictly per-portal-configured; without a
// configured field we never guess a property name. Unmatched → mapping.product.onMissing.

/** Find a catalog product id by exact name, or null (min id on duplicates). */
export async function findProductByName(name: string, call: RestCall): Promise<number | null> {
  const q = (name ?? '').trim()
  if (!q) return null
  const rows = await call('crm.product.list', { filter: { NAME: q }, select: ['ID'] }) as Array<{ ID: string }> | undefined
  return minId(rows)
}

/**
 * Find a catalog product id by supplier article via a configured catalog property.
 * `field` is the property code as printed in the mapping (e.g. "PROPERTY_130" or a
 * bare code like "ARTNUMBER" — Bitrix accepts both `PROPERTY_<id>` and `PROPERTY_<CODE>`
 * filter keys). Returns null when no article / no field / nothing matched.
 */
export async function findProductByArticle(article: string, field: string, call: RestCall): Promise<number | null> {
  const q = (article ?? '').trim()
  const key = normalizePropertyKey(field)
  if (!q || !key) return null
  const rows = await call('crm.product.list', { filter: { [key]: q }, select: ['ID'] }) as Array<{ ID: string }> | undefined
  return minId(rows)
}

/** Resolve a document line to a catalog product id per the portal mapping. */
export async function findProduct(item: DocumentItem, mapping: PortalMapping, call: RestCall): Promise<number | null> {
  if (mapping.product.by === 'article' && mapping.article.field) {
    const byArticle = item.article ? await findProductByArticle(item.article, mapping.article.field, call) : null
    if (byArticle) return byArticle
    // No article printed or no match → fall back to name (never drop the line here).
  }
  return findProductByName(item.name, call)
}

/** Accept both `PROPERTY_130` and a bare `130`/`ARTNUMBER` code; empty → null. */
function normalizePropertyKey(field: string): string | null {
  const f = (field ?? '').trim()
  if (!f) return null
  return /^PROPERTY_/i.test(f) ? f : `PROPERTY_${f}`
}

/** Smallest positive id from a crm.product.list result, or null. */
function minId(rows: Array<{ ID: string }> | undefined): number | null {
  if (!Array.isArray(rows) || !rows.length) return null
  const ids = rows.map(r => Number(r.ID)).filter(n => Number.isFinite(n) && n > 0)
  return ids.length ? Math.min(...ids) : null
}
