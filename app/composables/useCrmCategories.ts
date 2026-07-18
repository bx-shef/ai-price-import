import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'
import type { CrmCategoryOption } from '~/utils/categoryPicker'

// Load a portal's CRM categories (воронки/направления) for a target entity type, so the settings
// routing UI can offer a direction picker («тип документа → сущность + направление»). Frame-token
// auth (same model as useSettings/useCatalogProperties). Inert outside a portal (no frame auth) →
// empty list, so the picker just shows no directions instead of erroring. The row type
// `CrmCategoryOption` lives in ~/utils/categoryPicker (import it from there).

export function useCrmCategories() {
  const { init, auth } = useB24()

  /** Fetch categories for an entity type. Non-positive/absent id or no frame auth → []. */
  async function load(entityTypeId: number | null | undefined): Promise<CrmCategoryOption[]> {
    if (!entityTypeId || !Number.isInteger(entityTypeId) || entityTypeId <= 0) return []
    await init()
    const headers = buildFrameHeaders(auth())
    if (!headers) return []
    try {
      const res = await $fetch<{ categories?: CrmCategoryOption[] }>('/api/crm-categories', {
        headers,
        query: { entityTypeId }
      })
      return res.categories ?? []
    } catch {
      return [] // read failed → no direction offered (form still works)
    }
  }

  return { load }
}
