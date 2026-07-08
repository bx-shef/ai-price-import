import type { RestCall } from './b24Rest'

// Read the portal's configured currency codes (crm.currency.list). crm-sync uses
// this to reject a document currency the portal doesn't have (hard error — never
// create a wrong-currency entity). Verified live: entries are {CURRENCY, BASE, …}.

/** Fetch the portal's ISO 4217 currency codes (uppercased). */
export async function fetchCurrencies(call: RestCall): Promise<string[]> {
  const rows = await call('crm.currency.list', {}) as Array<{ CURRENCY?: string }> | undefined
  if (!Array.isArray(rows)) return []
  return rows
    .map(r => String(r.CURRENCY ?? '').toUpperCase())
    .filter(c => /^[A-Z]{3}$/.test(c))
}
