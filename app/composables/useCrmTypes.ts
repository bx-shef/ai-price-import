import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'
import type { SmartProcessOption } from '~/utils/targetOptions'

// Load the portal's smart processes (СПА) so the target picker (import + settings) can offer them BY
// NAME (with their direction/stage flags) instead of a raw entityTypeId. Frame-token auth (same model as
// useCrmMode/useCrmStages). Shared singleton — many pickers read one loaded list; the SPA set doesn't
// change within a session. Empty until loaded / outside a portal.

const types = ref<SmartProcessOption[]>([])
let loaded = false
let inFlight: Promise<void> | null = null

export function useCrmTypes() {
  const { init, auth } = useB24()

  /** Fetch once and cache. Idempotent — concurrent callers share one request. Inert outside a portal. */
  async function load(): Promise<void> {
    if (loaded || inFlight) return inFlight ?? undefined
    inFlight = (async () => {
      await init()
      const headers = buildFrameHeaders(auth())
      if (!headers) return // standalone / no auth → keep [] (no SPA options)
      try {
        const res = await $fetch<{ types?: SmartProcessOption[] }>('/api/crm-types', { headers })
        types.value = Array.isArray(res?.types) ? res.types : []
        loaded = true
      } catch {
        /* keep [] — no SPA options on a transient failure */
      }
    })()
    try {
      await inFlight
    } finally {
      inFlight = null
    }
  }

  return { types, load }
}
