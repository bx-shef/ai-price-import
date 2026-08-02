import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'

// Does the portal have the app's chat bot (#316/#360)? Without it chat messages are signed by the
// employee whose token the app holds, not by the app — see `server/api/chat-bot-status.get.ts`.
//
// FAIL-OPEN by design: the default is «есть», and only an EXPLICIT `ready: false` from the server
// flips it. The value drives a warning banner, and a banner shown by mistake (offline, transient
// 5xx, outside a portal) is worse than a missing one: it would tell the admin his portal is broken
// when it is not, on every hiccup.
//
// Singleton, like `useCrmMode` — the state does not change within a session, and several places may
// ask for it.

const ready = ref(true)
let loaded = false
let inFlight: Promise<void> | null = null

export function useChatBotStatus() {
  const { init, auth } = useB24()

  /** Fetch once and cache. Concurrent callers share one request. Inert outside a portal. */
  async function load(): Promise<void> {
    if (loaded || inFlight) return inFlight ?? undefined
    inFlight = (async () => {
      await init()
      const headers = buildFrameHeaders(auth())
      if (!headers) return // standalone → keep the default, no banner
      try {
        const res = await $fetch<{ ready?: boolean }>('/api/chat-bot-status', { headers })
        ready.value = res?.ready !== false
        loaded = true
      } catch {
        /* keep the default — never accuse a healthy portal on a transient failure */
      }
    })()
    try {
      await inFlight
    } finally {
      inFlight = null
    }
  }

  return { ready, load }
}
