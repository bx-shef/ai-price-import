import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'

// Loads the portal's catalog measures once for the units-dictionary editor (settings form).
// Not a search fetcher — the list is small (usually < 30), so we fetch it whole via
// /api/catalog-measures (frame-token auth). Inert outside a portal (no frame auth → empty).

/** A pickable measure (mirrors the server's MeasureOption). `value` is the numeric code as a
 *  string (b24ui Select item), `label` a human name. */
export interface MeasureOption {
  value: string
  label: string
  [key: string]: unknown
}

export function useCatalogMeasures() {
  const { init, auth } = useB24()
  const measures = ref<MeasureOption[]>([])
  const loaded = ref(false)

  async function load() {
    await init()
    const headers = buildFrameHeaders(auth())
    if (!headers) {
      loaded.value = true
      return
    }
    try {
      const res = await $fetch<{ items?: MeasureOption[] }>('/api/catalog-measures', { headers })
      measures.value = res.items ?? []
    } catch {
      measures.value = []
    } finally {
      loaded.value = true
    }
  }

  return { measures, loaded, load }
}
