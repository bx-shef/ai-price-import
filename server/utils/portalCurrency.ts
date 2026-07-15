import type { RestCall } from './b24Rest'

// Read the portal's configured currency codes (crm.currency.list). crm-sync uses
// this to reject a document currency the portal doesn't have (hard error — never
// create a wrong-currency entity). Verified live: entries are {CURRENCY, BASE, …}.
//
// NOT paginated (#87): crm.currency.list returns ALL currencies in one call and reports
// total:0 (confirmed live + REST docs — `start` is ignored). So — unlike crm.vat.list /
// catalog.productProperty.list — this one must NOT be wrapped in fetchAllPages; a single
// read is complete.

/** Fetch the portal's ISO 4217 currency codes (uppercased). */
export async function fetchCurrencies(call: RestCall): Promise<string[]> {
  const rows = await call('crm.currency.list', {}) as Array<{ CURRENCY?: string }> | undefined
  if (!Array.isArray(rows)) return []
  return rows
    .map(r => String(r.CURRENCY ?? '').toUpperCase())
    .filter(c => /^[A-Z]{3}$/.test(c))
}
