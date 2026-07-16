import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'

// In-portal feedback client (#182 channel «сотрудник»): submit 👍/👎 + a comment on the import
// result. The channel is server-gated (GITHUB_FEEDBACK_* env) — `enabled` is probed ONCE and shared
// by every widget (module-level ref) so N rows don't each hit /api/feedback. Inert outside a portal.

const enabled = ref<boolean | null>(null) // null = not probed yet; shared across widgets
let probing: Promise<void> | null = null

export function useFeedback() {
  const { init, auth } = useB24()

  /** Probe whether the channel is on (once). Failure → treated as OFF (widget stays hidden). */
  async function ensureEnabled(): Promise<void> {
    if (enabled.value !== null) return
    if (!probing) {
      probing = (async () => {
        try {
          const r = await $fetch<{ enabled?: boolean }>('/api/feedback')
          enabled.value = !!r?.enabled
        } catch {
          enabled.value = false
        }
      })()
    }
    await probing
  }

  /** Send a rating (+ optional comment). Throws on failure; returns false outside a portal. */
  async function submit(kind: 'up' | 'down', comment?: string): Promise<boolean> {
    await init()
    const headers = buildFrameHeaders(auth())
    if (!headers) return false // outside a portal — no frame token
    await $fetch('/api/feedback', { method: 'POST', headers, body: { kind, comment } })
    return true
  }

  return { enabled, ensureEnabled, submit }
}
