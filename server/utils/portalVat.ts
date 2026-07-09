import type { RestCall } from './b24Rest'
import type { PortalVatRate } from '~/utils/vat'

// Read the portal's configured VAT rates (crm.vat.list) for crm-sync's deterministic
// rate matching. DI over RestCall; verified live: entries are
// {ID, ACTIVE, NAME, RATE} where RATE is null ("Без НДС") or a decimal string.

/** Fetch active portal VAT rates → PortalVatRate[] (rate null = «Без НДС»). */
export async function fetchVatRates(call: RestCall): Promise<PortalVatRate[]> {
  const rows = await call('crm.vat.list', {
    order: { C_SORT: 'ASC' },
    filter: { ACTIVE: 'Y' },
    select: ['ID', 'NAME', 'RATE']
  }) as Array<{ ID: string, NAME?: string, RATE: string | null }> | undefined
  if (!Array.isArray(rows)) return []
  return rows.map(r => ({
    id: String(r.ID),
    name: String(r.NAME ?? ''),
    rate: r.RATE === null || r.RATE === undefined || r.RATE === '' ? null : Number(r.RATE)
  })).filter(r => r.rate === null || Number.isFinite(r.rate))
}
