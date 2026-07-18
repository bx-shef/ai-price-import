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
export async function fetchCrmCategories(entityTypeId: number, call: RestCall): Promise<CrmCategory[]> {
  if (!Number.isInteger(entityTypeId) || entityTypeId <= 0) return []
  let res: unknown
  try {
    res = await call('crm.category.list', { entityTypeId })
  } catch {
    return [] // lead (no funnels) / transient error → no direction offered
  }
  const cats = (res as { categories?: Array<Record<string, unknown>> })?.categories ?? []
  return cats
    .map(c => ({
      id: Number(c.id),
      name: String(c.name ?? ''),
      // B24 returns 'Y'/'N'; tolerate a boolean too.
      isDefault: c.isDefault === 'Y' || c.isDefault === true
    }))
    .filter(c => Number.isInteger(c.id) && c.id >= 0)
}
