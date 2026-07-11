import { useB24 } from './useB24'
import { buildFrameHeaders } from '~/utils/frameHeaders'
import type { RemoteSearchFetcher } from '~/utils/remoteSearch'

// Fetcher for the supplier-article picker (AsyncSearchSelect, P7): searches the
// portal's catalog product properties via /api/catalog-properties (frame-token auth,
// same model as useSettings). Inert outside a portal (no frame auth) → empty page, so
// the picker shows "nothing found" instead of erroring.

/** A pickable catalog property (mirrors the server's PropertyOption). The index
 *  signature keeps it assignable to AsyncSearchSelect's generic `Record<string, unknown>`
 *  option row (interfaces have no implicit index signature). */
export interface PropertyOption {
  value: string
  label: string
  code?: string
  id?: number
  [key: string]: unknown
}

export function useCatalogProperties() {
  const { init, auth } = useB24()

  const fetcher: RemoteSearchFetcher<PropertyOption> = async (query, _offset, signal) => {
    await init()
    const headers = buildFrameHeaders(auth())
    if (!headers) return { items: [], hasMore: false }
    const res = await $fetch<{ items?: PropertyOption[], hasMore?: boolean }>('/api/catalog-properties', {
      headers,
      query: { q: query },
      signal
    })
    return { items: res.items ?? [], hasMore: !!res.hasMore }
  }

  return { fetcher }
}
