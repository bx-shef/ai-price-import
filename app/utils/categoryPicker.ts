// Pure helpers for the settings direction (воронка/categoryId) picker — extracted from
// settings.vue so the non-trivial reconcile logic is unit-tested (repo convention: чистое ядро в
// app/utils, покрытое тестами). The component keeps only the reactive `ref`/watch/fetch glue.

/** A pickable CRM category (воронка/направление) — the shape the API + composable return. */
export interface CrmCategoryOption {
  id: number
  name: string
  isDefault: boolean
}

/** A routing target whose direction we edit. `entityTypeId` may be null while a rule row is unset. */
export interface CategoryTarget {
  entityTypeId?: number | null
  categoryId?: number
}

/** Sentinel option = «don't set CATEGORY_ID» (B24 then routes to the portal's default funnel).
 *  Worded so it does NOT collide with a funnel flagged isDefault (which is suffixed «(осн.)»). */
export const CATEGORY_SENTINEL_LABEL = '— не задавать (воронка портала) —'

/** b24ui Select items for an entity's directions: the sentinel ('' value) + each funnel.
 *  The isDefault funnel is suffixed «(осн.)» — distinct from the sentinel's wording. */
export function categoryItems(cats: CrmCategoryOption[] | undefined): Array<{ label: string, value: string }> {
  return [
    { label: CATEGORY_SENTINEL_LABEL, value: '' },
    ...(cats ?? []).map(c => ({ label: c.isDefault ? `${c.name} (осн.)` : c.name, value: String(c.id) }))
  ]
}

/** Whether the entity's directions are LOADED and non-empty (deal/smart-*; lead has none). */
export function hasCategories(cats: CrmCategoryOption[] | undefined): boolean {
  return (cats ?? []).length > 0
}

/** Current categoryId as the select's string value ('' = sentinel / none). */
export function categoryValue(target: CategoryTarget): string {
  return target.categoryId == null ? '' : String(target.categoryId)
}

/** Write the select's string value back to a numeric categoryId (or clear on '').
 *  '' → undefined FIRST, so Number('')===0 is never reached; a non-integer coerces to undefined. */
export function setCategory(target: CategoryTarget, v: unknown): void {
  const s = typeof v === 'string' ? v : String(v ?? '')
  if (s === '') {
    target.categoryId = undefined
    return
  }
  const n = Number(s)
  target.categoryId = Number.isInteger(n) && n >= 0 ? n : undefined
}

/** Drop a target's categoryId if it isn't among the LOADED categories for its entity type.
 *  `cats === undefined` means NOT loaded yet → leave as-is (so a freshly-seeded valid id isn't
 *  cleared during the async load gap). `cats === []` (lead / no funnels) → clear any stale id. */
export function reconcileCategory(target: CategoryTarget, cats: CrmCategoryOption[] | undefined): void {
  if (cats === undefined) return
  if (target.categoryId == null) return
  if (!cats.some(c => c.id === target.categoryId)) target.categoryId = undefined
}
