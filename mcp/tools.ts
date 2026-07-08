import type { RestCall } from '../server/utils/b24Rest'
import { findCompanyByTaxId } from '../server/utils/companyLookup'
import { createTargetItem, setProductRows } from '../server/utils/crmWrite'
import type { TargetRef } from '../app/types/mapping'

// Bodies of the isolated MCP tools. Each takes a portal-bound RestCall (the MCP
// server resolves it by member_id from a file — the agent never sees the token).
// The MCP SDK server (HTTP transport + registration) wraps these. docs/redesign 02 §1.4.

export interface FindSupplierInput { taxId: string }
export interface FindSupplierOutput { companyId: number | null }

/** MCP tool: find_supplier — company by tax id (RQ_INN). */
export async function findSupplierTool(input: FindSupplierInput, call: RestCall): Promise<FindSupplierOutput> {
  if (!input || typeof input.taxId !== 'string') throw new Error('find_supplier: taxId required')
  return { companyId: await findCompanyByTaxId(input.taxId, call) }
}

export interface CreateTargetInput {
  target: TargetRef
  fields: Record<string, unknown>
  rows?: Array<Record<string, unknown>>
}
export interface CreateTargetOutput { entityId: number }

/** MCP tool: create_target — create the CRM entity and (optionally) its product rows. */
export async function createTargetTool(input: CreateTargetInput, call: RestCall): Promise<CreateTargetOutput> {
  // entityTypeId must be a real CRM owner type (>0); 0/negative would produce a
  // malformed crm.item.add and is never a valid target.
  if (!input?.target || !(input.target.entityTypeId > 0)) throw new Error('create_target: target.entityTypeId required')
  const entityId = await createTargetItem(input.target, input.fields ?? {}, call)
  if (input.rows && input.rows.length) await setProductRows(input.target.entityTypeId, entityId, input.rows, call)
  return { entityId }
}

/** Names of IMPLEMENTED tools exposed to the agent (allowlist). `find_product`
 * is not advertised until implemented (product resolution currently runs in
 * crm-sync backend). Guarded by a test against the exported functions. */
export const MCP_TOOL_NAMES = ['find_supplier', 'create_target'] as const
