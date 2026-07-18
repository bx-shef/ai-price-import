import type { RestCall } from './b24Rest'

// Fetch a portal's CRM stages (стадии) for a target entity type + direction (categoryId), so the
// settings/import UI can offer a stage picker («тип → сущность + направление + СТАДИЯ»). Pure over
// RestCall (DI). The crm.status.list ENTITY_ID differs per entity type — all live-verified on the
// test portal (crm.status.list `result` is a flat array):
//   deal (2), cat 0   → 'DEAL_STAGE'                   (NEW/PREPARATION/…)
//   deal (2), cat N>0 → 'DEAL_STAGE_<N>'               (C<N>:NEW/…)
//   smart-invoice(31) → 'SMART_INVOICE_STAGE_<cat>'    (DT31_<cat>:N/…) — NOT DYNAMIC_31_*
//   smart-process ≥1000 → 'DYNAMIC_<etid>_STAGE_<cat>' (DT<etid>_<cat>:NEW/…)
// Leads (1) are intentionally NOT offered a stage: live-verified that crm.item.add for a lead
// SILENTLY IGNORES both `stageId` and `statusId` (the lead lands on the portal's default status, no
// error) — so pinning a lead stage would be a control that does nothing. Mirrors the lead
// categoryId carve-out (#135); createTargetItem likewise doesn't forward stageId for leads.

export interface CrmStage {
  id: string
  name: string
}

/** The crm.status.list ENTITY_ID for an entity type's stage list in a given category, or null when
 *  stages can't be addressed (a smart-process/smart-invoice with no category pinned yet). */
export function stageEntityId(entityTypeId: number, categoryId: number | null | undefined): string | null {
  if (!Number.isInteger(entityTypeId) || entityTypeId <= 0) return null
  if (entityTypeId === 1) return null // lead — crm.item.add ignores the stage, so don't offer one
  if (entityTypeId === 2) return categoryId && categoryId > 0 ? `DEAL_STAGE_${categoryId}` : 'DEAL_STAGE'
  const cat = categoryId
  if (cat == null || !Number.isInteger(cat) || cat < 0) return null // smart-* need a category
  if (entityTypeId === 31) return `SMART_INVOICE_STAGE_${cat}`
  if (entityTypeId >= 1000) return `DYNAMIC_${entityTypeId}_STAGE_${cat}`
  return null
}

/**
 * Stages for an entity type + direction via crm.status.list. Returns `[]` when the stage list can't
 * be addressed (no ENTITY_ID) or a transient read fails — never throws (the form must not break).
 * `crm.status.list` returns `result` as a flat array (STATUS_ID / NAME / SORT). We sort by SORT
 * explicitly so the picker order is load-bearing, not a reliance on the method's arrival order.
 */
export async function fetchCrmStages(entityTypeId: number, categoryId: number | null | undefined, call: RestCall): Promise<CrmStage[]> {
  const entityId = stageEntityId(entityTypeId, categoryId)
  if (!entityId) return []
  let res: unknown
  try {
    res = await call('crm.status.list', { filter: { ENTITY_ID: entityId }, select: ['STATUS_ID', 'NAME', 'SORT'] })
  } catch {
    return []
  }
  const rows = Array.isArray(res) ? res as Array<Record<string, unknown>> : []
  return rows
    .map(s => ({ id: String(s.STATUS_ID ?? ''), name: String(s.NAME ?? ''), sort: Number(s.SORT) }))
    .filter(s => s.id)
    .sort((a, b) => (Number.isFinite(a.sort) ? a.sort : 0) - (Number.isFinite(b.sort) ? b.sort : 0))
    .map(({ id, name }) => ({ id, name }))
}
