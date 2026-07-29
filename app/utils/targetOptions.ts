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

/** Options for buildEntityChoices. Both availability flags default to TRUE (fail-open): a picker that
 *  hasn't loaded portal metadata yet shows the full list rather than silently dropping a valid target. */
export interface EntityChoiceOptions {
  /** Portal has leads (classic CRM). False on a «без лидов» portal. */
  leadsEnabled?: boolean
  /** Portal has smart invoices. False → the option is hidden (#269: it used to be offered
   *  unconditionally, and picking it on such a portal failed at import time with the portal's raw
   *  «Сущность CRM не поддерживается»). */
  smartInvoiceEnabled?: boolean
  /** Add «Авто (по правилам)» — the per-file import picker does, the settings selector doesn't. */
  includeAuto?: boolean
}

/** Build the entity choices: Авто → Лид → Сделка → Смарт-счёт → each smart process BY NAME (like a
 *  preset, not a raw id). Lead and smart invoice appear only when the portal supports them; smart
 *  processes already arrive as a live list from the portal. */
export function buildEntityChoices(
  smartProcesses: SmartProcessOption[],
  opts: EntityChoiceOptions = {}
): EntityChoice[] {
  const { leadsEnabled = true, smartInvoiceEnabled = true, includeAuto = true } = opts
  const out: EntityChoice[] = []
  if (includeAuto) out.push({ id: null, label: 'Авто (по правилам)' })
  if (leadsEnabled) out.push({ id: ENTITY.lead, label: 'Лид' })
  out.push({ id: ENTITY.deal, label: 'Сделка' })
  if (smartInvoiceEnabled) out.push({ id: ENTITY.smartInvoice, label: 'Смарт-счёт' })
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
