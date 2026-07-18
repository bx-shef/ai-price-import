import type { RestCall } from './b24Rest'

// Fetch a portal's CRM categories («воронки» / направления) for a target entity type, so the
// settings UI can offer a direction picker for a routing rule / default target (#135 follow-up:
// «тип документа → сущность + направление»). Pure over RestCall (DI) — the transport is the
// portal's OAuth SDK call, same as crm-sync. crm.category.list field shapes live-verified on the
// test portal: deal(2) → {id:0 Default, 1, 3}; smart-invoice(31) → {id:11}; lead(1) →
// ENTITY_TYPE_NOT_SUPPORTED (no funnels). `isDefault` arrives as 'Y'/'N'.

export interface CrmCategory {
  id: number
  name: string
  isDefault: boolean
}

/**
 * Categories (воронки) for an entity type via crm.category.list. Entity types that have no
 * categories (lead=1 → the method throws ENTITY_TYPE_NOT_SUPPORTED) resolve to `[]` — the caller
 * then simply offers no direction. Any other transient read error also degrades to `[]` (a picker
 * with no options), never throws: fetching the direction list must not break the settings form.
 */
/** Page cap for crm.category.list (page size 50). A portal with >50·MAX_PAGES funnels of one type
 *  would still truncate, but that's far beyond any realistic pipeline count. */
const MAX_CATEGORY_PAGES = 20

export async function fetchCrmCategories(entityTypeId: number, call: RestCall): Promise<CrmCategory[]> {
  if (!Number.isInteger(entityTypeId) || entityTypeId <= 0) return []
  const out: CrmCategory[] = []
  let start = 0
  // crm.category.list paginates at 50 (returns top-level `next`); a portal with >50 funnels of one
  // entity type would otherwise silently drop the tail from the picker. Page by `next` with a cap.
  for (let page = 0; page < MAX_CATEGORY_PAGES; page++) {
    let res: { categories?: Array<Record<string, unknown>>, next?: unknown }
    try {
      res = (await call('crm.category.list', { entityTypeId, start })) as typeof res
    } catch {
      return out // lead (no funnels) / transient error → whatever we have (usually none)
    }
    for (const c of res?.categories ?? []) {
      const id = Number(c.id)
      if (!Number.isInteger(id) || id < 0) continue
      out.push({
        id,
        name: String(c.name ?? ''),
        // B24 returns 'Y'/'N'; tolerate a boolean too.
        isDefault: c.isDefault === 'Y' || c.isDefault === true
      })
    }
    const next = Number(res?.next)
    if (!Number.isInteger(next) || next <= start) break // no more pages
    start = next
  }
  return out
}
