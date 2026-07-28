// Shared, pure rules for the target picker — used by BOTH the import staging picker (TargetPicker.vue)
// and the settings page (settings.vue) so «куда импортировать» behaves identically (owner ask: код общий).
// No I/O — the SPA list and leadsEnabled are fetched by composables and passed in.

/** A smart process (СПА) type as offered to the user (from crm.type.list). */
export interface SmartProcessOption {
  entityTypeId: number
  title: string
  /** Whether the process uses directions (воронки). */
  hasCategories: boolean
  /** Whether the process uses stages. */
  hasStages: boolean
}

/** One entity choice shown as a button/preset in the picker. `id` is the entityTypeId (null = «Авто»). */
export interface EntityChoice {
  id: number | null
  label: string
}

export const ENTITY = { lead: 1, deal: 2, smartInvoice: 31 } as const

/** Build the entity choices: Авто → Лид (only when leads are enabled) → Сделка → Смарт-счёт → each smart
 *  process BY NAME (like a preset, not a raw id). `includeAuto` adds the «Авто (по правилам)» option
 *  (used in the per-file import picker; the settings entity selector omits it). */
export function buildEntityChoices(
  leadsEnabled: boolean,
  smartProcesses: SmartProcessOption[],
  includeAuto = true
): EntityChoice[] {
  const out: EntityChoice[] = []
  if (includeAuto) out.push({ id: null, label: 'Авто (по правилам)' })
  if (leadsEnabled) out.push({ id: ENTITY.lead, label: 'Лид' })
  out.push({ id: ENTITY.deal, label: 'Сделка' })
  out.push({ id: ENTITY.smartInvoice, label: 'Смарт-счёт' })
  for (const sp of smartProcesses) out.push({ id: sp.entityTypeId, label: sp.title })
  return out
}

/** Index SPA options by entityTypeId for O(1) lookup of its flags. */
export function smartProcessByEtid(smartProcesses: SmartProcessOption[]): Map<number, SmartProcessOption> {
  return new Map(smartProcesses.map(sp => [sp.entityTypeId, sp]))
}

/** Whether the DIRECTION (воронка) picker applies to an entity type:
 *  - lead → no (leads have no directions);
 *  - deal → yes;
 *  - smart-invoice → NO (always exactly one direction — hide it, owner ask; the single category is
 *    auto-used for stage addressing);
 *  - smart process (≥1000) → only when the process uses categories (isCategoriesEnabled);
 *  - anything else → no. */
export function directionApplies(entityTypeId: number | null | undefined, sp?: SmartProcessOption): boolean {
  if (entityTypeId == null) return false
  if (entityTypeId === ENTITY.lead || entityTypeId === ENTITY.smartInvoice) return false
  if (entityTypeId === ENTITY.deal) return true
  if (entityTypeId >= 1000) return !!sp?.hasCategories
  return false
}

/** Whether the STAGE picker applies to an entity type:
 *  - lead → yes (statuses);
 *  - deal → yes;
 *  - smart-invoice → yes;
 *  - smart process (≥1000) → only when the process uses stages (isStagesEnabled);
 *  - anything else → no. */
export function stageApplies(entityTypeId: number | null | undefined, sp?: SmartProcessOption): boolean {
  if (entityTypeId == null) return false
  if (entityTypeId === ENTITY.lead || entityTypeId === ENTITY.deal || entityTypeId === ENTITY.smartInvoice) return true
  if (entityTypeId >= 1000) return !!sp?.hasStages
  return false
}

/** Whether, when the direction picker is HIDDEN but the entity still addresses stages by category
 *  (smart-invoice, or a category-less SPA that has stages), we must silently auto-pick the single
 *  category so the stage list can load. True = the caller should set categoryId = the sole category. */
export function autoPickSingleCategory(entityTypeId: number | null | undefined, sp?: SmartProcessOption): boolean {
  if (entityTypeId == null) return false
  return !directionApplies(entityTypeId, sp) && stageApplies(entityTypeId, sp) && entityTypeId !== ENTITY.lead
}
