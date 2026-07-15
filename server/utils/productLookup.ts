import type { RestCall } from './b24Rest'
import type { PortalMapping, ArticleFieldConfig } from '~/types/mapping'
import type { DocumentItem } from '~/types/document'
import { articleMatches, parseSupplierArticles } from '~/utils/supplierArticles'

// Deterministic product lookup for crm-sync (find_product tool body). DI over RestCall.
// Two strategies (mapping.product.by):
//   • 'name'    → exact product NAME via crm.product.list (verified live: {ID, NAME}).
//   • 'article' → the admin-configured catalog property (mapping.article.field) holding
//     the supplier article(s). Supports BOTH field variants (kind 'text' = one article
//     per line / 'string' = delimiter-separated).
// Live-verified: an EXACT `PROPERTY_<code>` filter does NOT match a field that holds
// several articles (value "A\nB" is not found by exact "A") — only a substring `%LIKE`
// filter finds it. So we narrow with `%PROPERTY_<code>`, then confirm an EXACT article
// membership client-side (parseSupplierArticles) to reject LIKE false positives
// (e.g. "STP-5" ⊂ "STP-50"). Unmatched → mapping.product.onMissing.

/** Find a catalog product id by exact name, or null (min id on duplicates). */
export async function findProductByName(name: string, call: RestCall): Promise<number | null> {
  const q = (name ?? '').trim()
  if (!q) return null
  const rows = await call('crm.product.list', { filter: { NAME: q }, select: ['ID'] }) as Array<{ ID: string }> | undefined
  return minId(rows)
}

/**
 * Find a catalog product id by supplier article via the configured catalog property.
 * `cfg.field` is the property code (`PROPERTY_99`, `99`, or a symbolic code); `cfg.kind`
 * + `cfg.delimiter` say how multiple articles are packed in one value. Returns null when
 * no article / no field / nothing matched EXACTLY.
 */
export async function findProductByArticle(article: string, cfg: ArticleFieldConfig, call: RestCall): Promise<number | null> {
  const q = (article ?? '').trim()
  const key = normalizePropertyKey(cfg.field)
  if (!q || !key) return null
  // %LIKE narrows server-side (exact filter misses multi-article values). `order` ID ASC
  // makes the (Bitrix-default 50-row) page deterministic and the min-id contract hold
  // within it. NB two known limits: (1) the byte-based LIKE won't surface a stored
  // article that differs only by a homoglyph (Cyrillic С vs Latin C) — the fold in
  // articleMatches only helps among rows LIKE already returned; (2) an article that is a
  // substring of >50 products could be missed if its exact holder sits past row 50.
  // Both are acceptable for specific supplier codes; the field must be the numeric id.
  const rows = await call('crm.product.list', {
    filter: { [`%${key}`]: q },
    select: ['ID', key],
    order: { ID: 'ASC' }
  }) as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(rows) || !rows.length) return null
  const matched: number[] = []
  for (const r of rows) {
    const id = Number(r.ID)
    if (!Number.isFinite(id) || id <= 0) continue
    // Confirm exact membership in the product's parsed article set (kills substring hits).
    if (articleMatches(q, parseSupplierArticles(propValue(r[key]), cfg))) matched.push(id)
  }
  return matched.length ? Math.min(...matched) : null
}

/** Resolve a document line to a catalog product id per the portal mapping. */
export async function findProduct(item: DocumentItem, mapping: PortalMapping, call: RestCall): Promise<number | null> {
  if (mapping.product.by === 'article' && mapping.article.field) {
    const byArticle = item.article ? await findProductByArticle(item.article, mapping.article, call) : null
    if (byArticle) return byArticle
    // No article printed or no match → fall back to name (never drop the line here).
  }
  return findProductByName(item.name, call)
}

/**
 * Require a NUMERIC property id — `PROPERTY_130` or `130`. A symbolic code is REJECTED
 * (→ null): live-verified that `%PROPERTY_<CODE>` does NOT filter (Bitrix returns the
 * WHOLE catalog), which would fetch everything and then silently miss. The settings
 * property-picker supplies the numeric id.
 */
export function normalizePropertyKey(field: string): string | null {
  const f = (field ?? '').trim().replace(/^PROPERTY_/i, '')
  return /^\d+$/.test(f) ? `PROPERTY_${f}` : null
}

/**
 * Extract a crm.product property value to a string. Shapes seen: a bare string,
 * `{ value, valueId }`, and — if the property is configured multiple — an array or an
 * index-keyed object of those. Multi-value parts are joined with newlines so
 * `parseSupplierArticles` (text kind) still yields one article per part.
 */
function propValue(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(propValue).filter(Boolean).join('\n')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('value' in o) return String(o.value ?? '')
    return Object.values(o).map(propValue).filter(Boolean).join('\n')
  }
  return String(v)
}

/** Smallest positive id from a crm.product.list result, or null. */
function minId(rows: Array<{ ID: string }> | undefined): number | null {
  if (!Array.isArray(rows) || !rows.length) return null
  const ids = rows.map(r => Number(r.ID)).filter(n => Number.isFinite(n) && n > 0)
  return ids.length ? Math.min(...ids) : null
}
