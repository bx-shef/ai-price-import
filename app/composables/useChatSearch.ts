import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'
import type { RemoteSearchFetcher } from '~/utils/remoteSearch'

// Fetcher for the notify/error chat pickers (AsyncSearchSelect): searches the portal's
// chats via /api/chat-search (frame-token auth, same model as useCatalogProperties). Inert
// outside a portal (no frame auth) → empty page, so the picker shows "nothing found"
// instead of erroring. Single page (server has no cursor — see chatSearch.ts), so `offset`
// is ignored and `hasMore` is always false.

/** A pickable chat (mirrors the server's ChatOption). `value` is the B24 DIALOG_ID
 *  (`chat<id>`), `label` its title. Index signature → assignable to the picker's row. */
export interface ChatOption {
  value: string
  label: string
  [key: string]: unknown
}

export function useChatSearch() {
  const { init, auth } = useB24()

  const fetcher: RemoteSearchFetcher<ChatOption> = async (query, _offset, signal) => {
    await init()
    const headers = buildFrameHeaders(auth())
    if (!headers) return { items: [], hasMore: false }
    const res = await $fetch<{ items?: ChatOption[], hasMore?: boolean }>('/api/chat-search', {
      headers,
      query: { q: query },
      signal
    })
    return { items: res.items ?? [], hasMore: !!res.hasMore }
  }

  return { fetcher }
}
