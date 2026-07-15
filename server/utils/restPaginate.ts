// Fetch ALL pages of a Bitrix24 list method over our generic `RestCall`.
//
// Use this ONLY on the frame-access-token transport (makeRestCall) — the in-portal
// admin routes (e.g. the supplier-article catalog-property picker). The crm-sync /
// OAuth transport does NOT use this: it has the SDK client, whose built-in full-list
// fetch (b24Sdk.SdkListCall → actions.v2.callList.make) already pages everything.
//
// Our RestCall returns the UNWRAPPED `result`, so the envelope's `next`/`total`
// pagination fields are invisible. Instead we page by the classic `start` offset:
// request start=0, 50, 100, … and stop when a page returns fewer than the page size
// (the last page) — this needs no envelope access and is correct for every crm and
// catalog list method whose page size is 50.

import type { RestCall } from './b24Rest'

/** Bitrix24 list page size (fixed at 50 for crm and catalog list methods). */
export const B24_PAGE_SIZE = 50

/** Hard cap on pages so a misbehaving portal (or a method that ignores `start` and keeps
 *  returning the same full page) can't loop forever. 200 pages × 50 = 10 000 rows — far
 *  above any realistic VAT-rate / currency / catalog-property list. Hitting it is a real
 *  anomaly (never a normal list), so fetchAllPages logs a warning — no silent truncation. */
const MAX_PAGES = 200

/**
 * Page through `method` accumulating every row. `pick` extracts the row array from one
 * page's unwrapped result (e.g. identity for crm.vat.list, `r.productProperties` for
 * catalog.productProperty.list). Stops on the first short (< pageSize) or empty page,
 * or at MAX_PAGES. A page that yields a non-array is treated as empty (stops).
 */
export async function fetchAllPages<T>(
  call: RestCall,
  method: string,
  params: Record<string, unknown>,
  pick: (result: unknown) => T[] | undefined,
  opts: { pageSize?: number, maxPages?: number } = {}
): Promise<T[]> {
  const pageSize = opts.pageSize ?? B24_PAGE_SIZE
  const maxPages = opts.maxPages ?? MAX_PAGES
  const out: T[] = []
  for (let page = 0; page < maxPages; page++) {
    const result = await call(method, { ...params, start: page * pageSize })
    const rows = pick(result)
    if (!Array.isArray(rows) || rows.length === 0) return out
    out.push(...rows)
    if (rows.length < pageSize) return out // last page
  }
  // Exhausted the cap on full pages — the list is anomalously large OR the method ignores
  // `start` (looping the same page). Never silent: warn so the truncation is visible.
  console.warn(`fetchAllPages: ${method} hit MAX_PAGES=${maxPages} (${out.length} rows) — result may be truncated`)
  return out
}
