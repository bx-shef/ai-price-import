import type { TargetRef } from '~/types/mapping'

// Parse a CLIENT-SUPPLIED manual import target (the operator's «куда импортировать» choice, posted
// with the upload) into a safe TargetRef. Untrusted input — mirror the same gates as a routing rule
// (portalSettings.asTarget / routingRulesEditor) so a manual target obeys the same rules: a positive
// integer entityTypeId, an integer categoryId (≥0 — 0 is the default deal pipeline), a non-empty
// stageId string. Unknown/extra keys are ignored. Absent or invalid → null (follow the routing
// rules instead). The entity being markerless (quote) or lead-with-categoryId is handled downstream
// (originSearchFilter hard-errors a markerless target; crm-sync strips categoryId for a lead, #135).

export function parseManualTarget(raw: unknown): TargetRef | null {
  let o: unknown = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s) return null
    try {
      o = JSON.parse(s)
    } catch {
      return null
    }
  }
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const etid = Number(r.entityTypeId)
  if (!Number.isInteger(etid) || etid <= 0) return null // no valid target → follow the rules
  const categoryId = Number(r.categoryId)
  const stageId = typeof r.stageId === 'string' ? r.stageId.trim() : ''
  return {
    entityTypeId: etid,
    ...(r.categoryId != null && Number.isInteger(categoryId) && categoryId >= 0 ? { categoryId } : {}),
    ...(stageId ? { stageId: stageId.slice(0, 100) } : {})
  }
}
