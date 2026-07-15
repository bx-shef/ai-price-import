import type { SdkListCall } from './b24Sdk'
import type { PortalVatRate } from '~/utils/vat'

// Read the portal's configured VAT rates (crm.vat.list) for crm-sync's deterministic
// rate matching. Verified live: entries are {ID, ACTIVE, NAME, RATE} where RATE is null
// ("Без НДС") or a decimal string. crm.vat.list is a paginated crm.* list (50/page, #87)
// — the SDK's full-list fetch (SdkListCall, keyset by ID) pages through ALL rates so a
// portal with >50 rates can't silently drop the tail (mis-matched VAT downstream).

/** Fetch active portal VAT rates → PortalVatRate[] (rate null = «Без НДС»). */
export async function fetchVatRates(list: SdkListCall): Promise<PortalVatRate[]> {
  const rows = await list('crm.vat.list', { filter: { ACTIVE: 'Y' }, select: ['ID', 'NAME', 'RATE'] }) as Array<{ ID: string, NAME?: string, RATE: string | null }>
  if (!Array.isArray(rows)) return [] // SdkListCall guarantees an array; guard defensively
  return rows.map(r => ({
    id: String(r.ID),
    name: String(r.NAME ?? ''),
    rate: r.RATE === null || r.RATE === undefined || r.RATE === '' ? null : Number(r.RATE)
  })).filter(r => r.rate === null || Number.isFinite(r.rate))
}
