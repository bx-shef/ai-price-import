import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'

// Load the portal's CRM mode flag (whether leads are usable) so the settings/import UI can HIDE the
// «Лид» target on a no-leads (simple CRM) portal. Frame-token auth (same model as useCrmStages).
// Shared singleton ref: many pickers (per staged file + settings) read one loaded value; the portal
// mode doesn't change within a session. Default TRUE → the lead option shows until we learn otherwise
// (fail-open: never hide it on a transient failure / outside a portal).

const leadsEnabled = ref(true)
let loaded = false
let inFlight: Promise<void> | null = null

export function useCrmMode() {
  const { init, auth } = useB24()

  /** Fetch once and cache. Idempotent — concurrent callers share one request. Inert outside a portal
   *  (no frame auth → keep the default true). */
  async function load(): Promise<void> {
    if (loaded || inFlight) return inFlight ?? undefined
    inFlight = (async () => {
      await init()
      const headers = buildFrameHeaders(auth())
      if (!headers) return // standalone / no auth → keep default (leads shown)
      try {
        const res = await $fetch<{ leadsEnabled?: boolean }>('/api/crm-mode', { headers })
        // Only an EXPLICIT false hides leads; anything else keeps them (fail-open).
        leadsEnabled.value = res?.leadsEnabled !== false
        loaded = true
      } catch {
        /* keep default true — don't hide the lead option on a transient failure */
      }
    })()
    try {
      await inFlight
    } finally {
      inFlight = null
    }
  }

  return { leadsEnabled, load }
}
