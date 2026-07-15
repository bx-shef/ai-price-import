// Backend proxy core for the supplier-article picker (P7): search a portal's catalog
// product properties so an admin can PICK the property that holds the supplier article
// instead of typing a raw code. Reads via the portal's OAuth token (SdkTransport), so
// the route resolves the caller's member_id from the frame token first (resolveFrameMember).
//
// Two REST reads, verified live (scope `catalog`):
//   - catalog.catalog.list (single `.call`) → pick the MAIN product catalog (offers
//     catalogs carry a productIblockId pointing at their parent; the main one has
//     productIblockId=null);
//   - catalog.productProperty.list (full-list `.list`, grouped key `productProperties`,
//     keyset cursor `id`) → { id, code, name, propertyType } rows. The SDK pages through
//     ALL of them, so a large B2B catalog with >50 properties doesn't drop the tail.
// Normalized to one shape ({ value: code, label: name }); the query is applied in-memory
// (the REST list has no name-substring filter).

import type { RestCall } from './b24Rest'
import type { SdkTransport } from './b24Sdk'

/** One pickable property: `value` is the stored code (or PROPERTY_<id> fallback),
 *  `label` the human name. `id`/`code` are carried for callers that need them. */
export interface PropertyOption {
  value: string
  label: string
  code?: string
  id?: number
}

/** A page of property options plus whether more pages exist (single page here). */
export interface PropertySearchPage {
  items: PropertyOption[]
  hasMore: boolean
}

/**
 * Resolve the MAIN product catalog's iblockId. Offers catalogs reference their parent
 * via `productIblockId`; the main catalog has `productIblockId == null`. Returns null
 * when no catalog is found (empty portal / missing scope).
 */
export async function resolveMainIblockId(call: RestCall): Promise<number | null> {
  // The transport's `.call` (makeSdkRestCall) returns the UNWRAPPED `result`, so read
  // `catalogs` directly — NOT `result.catalogs` (that double-unwrap yields undefined in prod).
  const resp = await call('catalog.catalog.list', {}) as { catalogs?: Array<Record<string, unknown>> }
  const catalogs = resp?.catalogs ?? []
  const main = catalogs.find(c => c.productIblockId == null) ?? catalogs[0]
  const id = main ? Number(main.iblockId) : NaN
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Normalize a catalog.productProperty.list response into pickable options. Keeps only
 * properties with a stable reference (a code, else PROPERTY_<id>); label prefers the
 * human name. A property with neither code nor a positive id is dropped (unreferenceable).
 */
export function normalizeProperties(resp: unknown): PropertyOption[] {
  // RestCall returns the UNWRAPPED result → read `productProperties` directly.
  const rows = (resp as { productProperties?: Array<Record<string, unknown>> })?.productProperties
  if (!Array.isArray(rows)) return []
  const out: PropertyOption[] = []
  for (const p of rows) {
    const rawId = Number(p.id)
    const id = Number.isInteger(rawId) && rawId > 0 ? rawId : undefined
    const code = typeof p.code === 'string' ? p.code.trim() : ''
    const value = code || (id ? `PROPERTY_${id}` : '')
    if (!value) continue
    const label = String(p.name ?? '').trim() || code || (id ? `#${id}` : value)
    out.push({ value, label, code: code || undefined, id })
  }
  return out
}

/** Filter options by a case-insensitive substring of the label OR the value/code. */
export function filterProperties(props: PropertyOption[], q: string): PropertyOption[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return props
  return props.filter(p =>
    p.label.toLowerCase().includes(needle) || p.value.toLowerCase().includes(needle))
}

/**
 * Compose: resolve the main iblockId → fetch ALL its product properties (SDK full-list) →
 * normalize → filter by query. `hasMore` is always false because the SDK already fetched
 * every page (not because we assume one page). Empty list when no catalog is found
 * (never throws for that — the route maps transport failures to 502).
 */
export async function searchCatalogProperties(t: SdkTransport, q: string): Promise<PropertySearchPage> {
  const iblockId = await resolveMainIblockId(t.call)
  if (!iblockId) return { items: [], hasMore: false }
  // catalog.productProperty.list groups rows under `productProperties` and keys on `id`
  // (lowercase) — the SDK needs both to page a >50-property catalog correctly.
  const rows = await t.list('catalog.productProperty.list', { filter: { iblockId } }, { idKey: 'id', listKey: 'productProperties' })
  return { items: filterProperties(normalizeProperties({ productProperties: rows }), q), hasMore: false }
}
