import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'
import type { SmartProcessOption } from '~/utils/targetOptions'

// Load the portal's smart processes (СПА) so the target picker (import + settings) can offer them BY
// NAME (with their direction/stage flags) instead of a raw entityTypeId. Frame-token auth (same model as
// useCrmMode/useCrmStages). Shared singleton — many pickers read one loaded list; the SPA set doesn't
// change within a session. Empty until loaded / outside a portal.

const types = ref<SmartProcessOption[]>([])
// Whether the portal actually has smart invoices (#269). Default TRUE — fail-open: outside a portal
// or on a failed load we keep offering the option, exactly as before the probe existed.
const smartInvoiceEnabled = ref(true)
let loaded = false
// ⚠ Отдельный РЕАКТИВНЫЙ признак «список получен» (#488): проверять выбранный тип на
// существование можно ТОЛЬКО после загрузки. До неё список пуст, и смарт-процесс выглядел бы
// отключённым на портале — экран уводил бы человека в «Авто» на ровном месте, на каждом открытии.
const typesLoaded = ref(false)
let inFlight: Promise<void> | null = null

export function useCrmTypes() {
  const { init, ensureAuth } = useB24()

  /** Fetch and cache on SUCCESS. Idempotent — concurrent callers share one in-flight request; a FAILED
   *  load isn't cached, so the next mounted picker retries (best-effort). Inert outside a portal. */
  async function load(): Promise<void> {
    if (loaded || inFlight) return inFlight ?? undefined
    inFlight = (async () => {
      await init()
      const headers = buildFrameHeaders(await ensureAuth())
      if (!headers) return // standalone / no auth → keep [] (no SPA options)
      try {
        const res = await $fetch<{ types?: SmartProcessOption[], smartInvoice?: boolean }>('/api/crm-types', { headers })
        types.value = Array.isArray(res?.types) ? res.types : []
        smartInvoiceEnabled.value = res?.smartInvoice !== false
        loaded = true
        typesLoaded.value = true
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

  return { types, smartInvoiceEnabled, typesLoaded, load }
}
