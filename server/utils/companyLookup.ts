import type { RestCall } from './b24Rest'

// Find a counterparty company by tax id via the universal requisite field RQ_INN
// (RU=ИНН, BY=УНП, KZ=БИН/ИИН — same field for all countries). DI over RestCall.
// Intended consumer: the isolated MCP `find_supplier` tool (MCP is the only door to B24).

const ENTITY_TYPE_ID_COMPANY = 4

/** Return the company id for a tax id, or null. On duplicates → minimal id. */
export async function findCompanyByTaxId(taxId: string, call: RestCall): Promise<number | null> {
  const digits = taxId.replace(/\D+/g, '')
  if (!digits) return null
  const requisites = await call('crm.requisite.list', {
    filter: { RQ_INN: digits, ENTITY_TYPE_ID: ENTITY_TYPE_ID_COMPANY },
    select: ['ID', 'ENTITY_ID', 'ENTITY_TYPE_ID']
  }) as Array<{ ENTITY_ID: string }>
  if (!requisites || requisites.length === 0) return null
  const ids = requisites.map(r => Number(r.ENTITY_ID)).filter(n => Number.isFinite(n) && n > 0)
  return ids.length ? Math.min(...ids) : null
}
