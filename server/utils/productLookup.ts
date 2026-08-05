import type { RestCall } from './b24Rest'
import type { PortalMapping, ArticleFieldConfig } from '~/types/mapping'
import type { DocumentItem } from '~/types/document'
import { articleMatches, parseSupplierArticles } from '~/utils/supplierArticles'
import { findOfferForItem } from './offerLookup'

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
// matched. ⚠ the `ACTIVE`/`XML_ID` filters on crm.product.list are per the classic product contract —
// live-verify on a catalog-enabled portal before relying on them (this dev webhook has no catalog REST).
// SKU / trade-offer («торговое предложение») matching with priority over the base product is a
// documented follow-up (needs catalog.product.offer.* + a subscription portal) — see docs.

/**
 * Find an ACTIVE catalog product by its external code (XML_ID / «внешний код»), or null. Distributors
 * commonly key their catalog by XML_ID, so it is tried as a second article-matching strategy after the
 * supplier-article property. Exact match (XML_ID is a single value, not a multi-article field).
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

/** Resolve a document line to a catalog product/offer id per the portal mapping.
 *  - **Trade offers (SKU) have PRIORITY** when the portal has them (`offersIblockId` resolved once per
 *    job): a printed article is often the OFFER's XML_ID, and a deal row can carry the offer id directly
 *    (owner ask «приоритет SKU»). Fail-soft: no offers iblock / no match → fall through to products.
 *  - Base product then tries: the supplier-article property → the external code (XML_ID), both
 *    ACTIVE-only. NAME matching does not exist — see the note at the end of the function. */
export async function findProduct(item: DocumentItem, mapping: PortalMapping, call: RestCall, offersIblockId: number | null = null): Promise<number | null> {
  // 1) Offers (SKU / ТП) first — by article-as-xmlId. Only when the portal has an offers iblock;
  //    otherwise this is a no-op (returns null) and we go straight to the base-product lookup.
  if (offersIblockId) {
    const offerId = await findOfferForItem(item.article, item.name, offersIblockId, call)
    if (offerId) return offerId
  }
  // 2) Base product: the configured article property, then the external code (XML_ID).
  //
  // ⚠ XML_ID стоит ВНЕ гейта `mapping.article.field`, и это правка по существу. Прежде обе ветки
  // сидели под одним условием, то есть портал, где админ НЕ выбрал свойство артикула, не делал в
  // каталог ни одного запроса — даже когда артикулы документа буквально равны внешним кодам его
  // товаров. Внешний код — системное поле `crm.product`, настройки оно не требует, и запирать его
  // за чужой настройкой было ошибкой. Раньше её частично прикрывал подбор по имени; с его удалением
  // она стала видимой и дорогой.
  if (item.article) {
    if (mapping.article.field) {
      const byArticle = await findProductByArticle(item.article, mapping.article, call)
      if (byArticle) return byArticle
    }
    const byXmlId = await findProductByXmlId(item.article, call)
    if (byXmlId) return byXmlId
  }
  // ⚠ ПОДБОРА ПО ИМЕНИ НЕТ — решение владельца 2026-08-05. Обоснование записано ТОЧНО, потому что
  // первая его редакция была сильнее фактов и разбор это поймал.
  //
  // Чем подбор по имени БЫЛ: `filter: { NAME: q, ACTIVE: 'Y' }` — ТОЧНОЕ совпадение, не подстрока.
  // Поэтому довод «у каждого поставщика своё написание» работает против самого себя: при разном
  // написании точный фильтр просто не совпадёт и вернёт null. То есть в этом сценарии подбор по
  // имени был не опасен, а бесполезен.
  //
  // Настоящих оснований два, и оба уже: (1) ТИХИЙ ФОЛБЭК МАСКИРОВАЛ ПОЛОМКУ ветки артикула — живой
  // прогон был зелёным при том, что свойства артикула на портале не существовало вовсе, и промах
  // был виден «только по тому, чего в выводе нет»; (2) дубли в каталоге с байт-идентичным активным
  // названием (та же «Доставка» от двух поставщиков, наследие прошлых импортов) — тогда `minId`
  // берёт произвольную, старейшую запись, а после #348 строка ещё и переименовывается в каталожное
  // имя, то есть подмена становится невидимой. Риск узкий, но именно он и есть риск.
  //
  // ⚠ Плата названа: документ БЕЗ колонки артикула (в РБ/РФ распространённый вид первички) больше
  // не связывается с каталогом ни одной строкой. Раньше часть строк подбиралась по названию.
  // Молчать об этом нельзя — `crmSyncCore` отдельно предупреждает «ни одна позиция не связана с
  // каталогом»; без такого предупреждения исход был бы неотличим от успешного импорта.
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
