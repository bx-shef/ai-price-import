// Pure helpers for the settings/import stage (стадия) picker — mirrors categoryPicker.ts but for
// stages (string ids, no isDefault). Extracted so the reconcile logic is unit-tested (repo
// convention). The component keeps only the reactive ref/watch/fetch glue.

/** A pickable CRM stage (стадия) — the shape the API + composable return. */
export interface CrmStageOption {
  id: string
  name: string
}

/** A routing target whose stage we edit. */
export interface StageTarget {
  stageId?: string
}

/** Sentinel = «don't pin a stage» (the entity is created in its default/first stage). */
export const STAGE_SENTINEL_LABEL = '— стадия по умолчанию —'

/** Sentinel Select VALUE for «default stage». MUST be non-empty: b24ui/Reka `SelectItem` throws on
 *  an empty-string value. Mapped back to `undefined` in `setStage` / `stageValue`. */
export const STAGE_SENTINEL_VALUE = '__none__'

/** b24ui Select items for a stage list: the sentinel + each stage (label = name, else id). */
export function stageItems(stages: CrmStageOption[] | undefined): Array<{ label: string, value: string }> {
  return [
    { label: STAGE_SENTINEL_LABEL, value: STAGE_SENTINEL_VALUE },
    ...(stages ?? []).map(s => ({ label: s.name || s.id, value: s.id }))
  ]
}

/** Whether the stages are LOADED and non-empty. */
export function hasStages(stages: CrmStageOption[] | undefined): boolean {
  return (stages ?? []).length > 0
}

/** Current stageId as the select's string value (sentinel value = default/none). */
export function stageValue(target: StageTarget): string {
  return target.stageId ?? STAGE_SENTINEL_VALUE
}

/** Write the select's string value back to stageId (or clear on the sentinel/empty), bounded. */
export function setStage(target: StageTarget, v: unknown): void {
  const s = typeof v === 'string' ? v : String(v ?? '')
  target.stageId = s === '' || s === STAGE_SENTINEL_VALUE ? undefined : s.slice(0, 100)
}

/** Drop a target's stageId if it isn't among the LOADED stages (entity/category switched, or the
 *  stage was deleted). `stages === undefined` (not loaded yet) → leave as-is (no async-gap clear). */
export function reconcileStage(target: StageTarget, stages: CrmStageOption[] | undefined): void {
  if (stages === undefined) return
  if (target.stageId == null) return
  if (!stages.some(s => s.id === target.stageId)) target.stageId = undefined
}
