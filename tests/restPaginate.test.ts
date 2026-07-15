import { describe, expect, it, vi } from 'vitest'
import { B24_PAGE_SIZE, fetchAllPages } from '../server/utils/restPaginate'
import { searchCatalogProperties } from '../server/utils/catalogPropertySearch'

/** A RestCall that serves fixed pages keyed by the `start` offset. */
function pagedCall(pages: Record<number, unknown>) {
  return vi.fn(async (_method: string, params?: Record<string, unknown>) => {
    const start = Number(params?.start ?? 0)
    return pages[start] ?? []
  })
}

describe('fetchAllPages', () => {
  it('returns a single short page without a second request', async () => {
    const call = pagedCall({ 0: [1, 2, 3] })
    const rows = await fetchAllPages(call, 'm', {}, r => r as number[])
    expect(rows).toEqual([1, 2, 3])
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]![1]).toEqual({ start: 0 })
  })

  it('pages through until a short page ends it (start offsets by page size)', async () => {
    const full = Array.from({ length: B24_PAGE_SIZE }, (_, i) => i)
    const call = pagedCall({ 0: full, [B24_PAGE_SIZE]: [100, 101] })
    const rows = await fetchAllPages(call, 'm', { filter: { A: 'Y' } }, r => r as number[])
    expect(rows).toHaveLength(B24_PAGE_SIZE + 2)
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]![1]).toEqual({ filter: { A: 'Y' }, start: B24_PAGE_SIZE })
  })

  it('stops on an exactly-full last page after the next empty page', async () => {
    const full = Array.from({ length: B24_PAGE_SIZE }, (_, i) => i)
    const call = pagedCall({ 0: full }) // page 1 (start=50) → [] → stop
    const rows = await fetchAllPages(call, 'm', {}, r => r as number[])
    expect(rows).toHaveLength(B24_PAGE_SIZE)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('treats a non-array page result as the end', async () => {
    const call = pagedCall({ 0: undefined })
    expect(await fetchAllPages(call, 'm', {}, r => r as number[])).toEqual([])
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('extracts nested rows via pick, honours maxPages cap, and WARNS (never silent)', async () => {
    const page = { items: Array.from({ length: 2 }, (_, i) => i) }
    const call = pagedCall({ 0: page, 2: page, 4: page }) // ignores start → same full page forever
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows = await fetchAllPages(call, 'catalog.stuck.list', {}, r => (r as { items?: number[] }).items, { pageSize: 2, maxPages: 2 })
    expect(rows).toHaveLength(4) // 2 pages × 2 rows — capped
    expect(call).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog.stuck.list hit MAX_PAGES=2'))
    warn.mockRestore()
  })
})

describe('searchCatalogProperties pagination (#87)', () => {
  it('pages through all product properties, then filters in memory', async () => {
    const props = Array.from({ length: B24_PAGE_SIZE }, (_, i) => ({ id: i + 1, code: `C${i}`, name: `Prop ${i}` }))
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'catalog.catalog.list') return { catalogs: [{ iblockId: 25, productIblockId: null }] }
      const start = Number(params?.start ?? 0)
      if (start === 0) return { productProperties: props }
      if (start === B24_PAGE_SIZE) return { productProperties: [{ id: 777, code: 'ART', name: 'Артикул поставщика' }] }
      return { productProperties: [] }
    })
    const page = await searchCatalogProperties(call, 'артикул')
    expect(page.hasMore).toBe(false)
    // only the 2nd-page property matches the query — proves the tail wasn't dropped
    expect(page.items).toEqual([{ value: 'ART', label: 'Артикул поставщика', code: 'ART', id: 777 }])
  })
})
