import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'
import type { CrmStageOption } from '~/utils/stagePicker'

// Load a portal's CRM stages (стадии) for a target entity type + direction (categoryId), so the
// settings/import UI can offer a stage picker. Frame-token auth (same model as useCrmCategories).
// Inert outside a portal → empty list. The row type `CrmStageOption` lives in ~/utils/stagePicker.

export function useCrmStages() {
  const { init, auth } = useB24()

  /** Fetch stages for an entity type + optional category. Non-positive/absent entity or no frame
   *  auth → []. categoryId is omitted from the query when null (lead / deal default funnel). */
  async function load(entityTypeId: number | null | undefined, categoryId: number | null | undefined): Promise<CrmStageOption[]> {
    if (!entityTypeId || !Number.isInteger(entityTypeId) || entityTypeId <= 0) return []
    await init()
    const headers = buildFrameHeaders(auth())
    if (!headers) return []
    try {
      const res = await $fetch<{ stages?: CrmStageOption[] }>('/api/crm-stages', {
        headers,
        query: { entityTypeId, ...(categoryId != null ? { categoryId } : {}) }
      })
      return res.stages ?? []
    } catch {
      return []
    }
  }

  return { load }
}
