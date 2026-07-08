import type { RestCall } from './b24Rest'
import type { PortalMapping } from '~/types/mapping'
import type { DocumentItem } from '~/types/document'

// Deterministic product lookup for crm-sync (find_product tool body). DI over RestCall.
// MVP resolves by EXACT product name via crm.product.list (verified live: {ID, NAME}).
// Article-by-property search (mapping.article.field) needs per-portal catalog iblock
// property wiring — a documented follow-up; until then an article strategy also
// falls back to name. Unmatched → mapping.product.onMissing (skip-warn/create/freeform).

/** Find a catalog product id by exact name, or null (min id on duplicates). */
export async function findProductByName(name: string, call: RestCall): Promise<number | null> {
  const q = (name ?? '').trim()
  if (!q) return null
  const rows = await call('crm.product.list', { filter: { NAME: q }, select: ['ID'] }) as Array<{ ID: string }> | undefined
  if (!Array.isArray(rows) || !rows.length) return null
  const ids = rows.map(r => Number(r.ID)).filter(n => Number.isFinite(n) && n > 0)
  return ids.length ? Math.min(...ids) : null
}

/** Resolve a document line to a catalog product id per the portal mapping. */
export async function findProduct(item: DocumentItem, _mapping: PortalMapping, call: RestCall): Promise<number | null> {
  // TODO(article): when mapping.product.by === 'article', search the configured
  // article property (mapping.article.field) once per-portal iblock wiring exists.
  return findProductByName(item.name, call)
}
