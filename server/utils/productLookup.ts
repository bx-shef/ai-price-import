import type { RestCall } from './b24Rest'
import type { PortalMapping, ArticleFieldConfig } from '~/types/mapping'
import type { DocumentItem } from '~/types/document'
import { articleMatches, parseSupplierArticles } from '~/utils/supplierArticles'
import { findOfferByProperty, findOfferByXmlId } from './offerLookup'

// Deterministic product lookup for crm-sync (find_product tool body). DI over RestCall.
// Strategies (единственная — по артикулу; `mapping.product.by` больше не читается):
//   • 'article' → the admin-configured catalog property (mapping.article.field) holding
//     the supplier article(s) AND the product's external code (XML_ID / «внешний код»).
//     Supports BOTH field variants (kind 'text' = one article per line / 'string' = delimiter-separated).
// Live-verified: an EXACT `PROPERTY_<code>` filter does NOT match a field that holds
// several articles (value "A\nB" is not found by exact "A") — only a substring `%LIKE`
// filter finds it. So we narrow with `%PROPERTY_<code>`, then confirm an EXACT article
// membership client-side (parseSupplierArticles) to reject LIKE false positives
// (e.g. "STP-5" ⊂ "STP-50"). Unmatched → mapping.product.onMissing.
//
// ACTIVE-only (owner ask): every lookup filters `ACTIVE: 'Y'` so an inactive/archived product is never
// matched. LIVE-VERIFIED 2026-08-06 by `pnpm verify:article` (#383) on a catalog-enabled portal — the
// whole edge-case matrix runs THIS function, not a hand-rewritten query: inactive product with a
// matching article is not returned; `ZQ-5` does not match `ZQ-50` (server-side %LIKE returns it, our
// exact confirmation rejects it); both field kinds parse (comma-delimited string, CRLF multiline
// text); XML_ID matches without any configured property; a property id that does not exist yields
// null rather than the first product of the catalog. The two known limits below were verified as
// limits, not fixed: homoglyphs and the single 50-row page.

/**
 * Find an ACTIVE catalog product by its external code (XML_ID / «внешний код»), or null. Distributors
 * commonly key their catalog by XML_ID, so it is tried as a second article-matching strategy after the
 * supplier-article property. Single-value match — XML_ID is not a multi-article field.
 *
 * ⚠ LIVE-VERIFIED 2026-08-06 (`pnpm verify:article`): the portal compares XML_ID
 * CASE-INSENSITIVELY — `zq-x` finds a product stored as `ZQ-X`. This comment previously claimed an
 * "exact match", which was wrong. Good for matching (suppliers print codes in any case), but it
 * means two products whose XML_ID differs ONLY by case are the SAME row to this filter and `minId`
 * picks an arbitrary one of them — the same silent-substitution hazard as duplicate names.
 */
export async function findProductByXmlId(code: string, call: RestCall): Promise<number | null> {
  const q = (code ?? '').trim()
  if (!q) return null
  const rows = await call('crm.product.list', { filter: { XML_ID: q, ACTIVE: 'Y' }, select: ['ID'] }) as Array<{ ID: string }> | undefined
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
    filter: { [`%${key}`]: q, ACTIVE: 'Y' },
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

/**
 * Подобрать товар каталога по строке документа. ТОЛЬКО по артикулу.
 *
 * Порядок — от самого сильного признака к настраиваемому (решение владельца 2026-08-05):
 *   1. **внешний код торгового предложения** (`xmlId`) — напечатанный артикул чаще всего именно он;
 *   2. **внешний код базового товара** (`XML_ID`) — системное поле, настройки не требует;
 *   3. **свойство с артикулом поставщика** — ОДИН раз, в том инфоблоке, которому оно принадлежит.
 *
 * ⚠ Почему свойство ищется один раз и строго по `article.scope`. Свойство живёт ровно в одном
 * инфоблоке — предложений либо товаров. Портал при этом **молча игнорирует** фильтр по свойству,
 * которого в инфоблоке нет, и возвращает ВЕСЬ список (живая проверка 2026-08-05). Значит «поискать
 * на всякий случай в обоих» дало бы в одном из них весь каталог; спасает только сверка точного
 * совпадения на клиенте, которая есть у обоих путей — но полагаться на неё как на единственную
 * защиту не нужно, когда инфоблок известен из настройки.
 *
 * ⚠ Оба внешних кода идут ДО свойства намеренно: они не зависят от настройки, поэтому портал,
 * где админ ничего не выбрал, всё равно подбирает товар. Прежде свойство стояло раньше, а внешний
 * код базового товара вообще был заперт за настройкой свойства.
 *
 * По названию не ищем никогда — `tests/noNameLookup.test.ts`.
 */
export async function findProduct(item: DocumentItem, mapping: PortalMapping, call: RestCall, offersIblockId: number | null = null): Promise<number | null> {
  const article = (item.article ?? '').trim()
  if (!article) return null

  // 1) Внешний код торгового предложения.
  if (offersIblockId) {
    const byOfferXml = await findOfferByXmlId(article, offersIblockId, call)
    if (byOfferXml) return byOfferXml
  }
  // 2) Внешний код базового товара.
  const byXmlId = await findProductByXmlId(article, call)
  if (byXmlId) return byXmlId

  // 3) Свойство — один раз, в своём инфоблоке.
  if (mapping.article.field) {
    if (mapping.article.scope === 'offer') {
      return offersIblockId ? await findOfferByProperty(article, mapping.article, offersIblockId, call) : null
    }
    return await findProductByArticle(article, mapping.article, call)
  }
  return null
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
