import type { RestCall } from './b24Rest'
import type { DocumentItem } from '~/types/document'
import type { TargetRef } from '~/types/mapping'

// Pure builders + thin callers for creating the target CRM entity and its rows.
// VAT model validated live: crm.item.productrow.set computes НДС 1-в-1 (no kernel patch).
// NOTE: intended consumer is the isolated MCP `create_target` tool (docs/redesign 02 §1.4),
// not direct calls from crm-sync — MCP is the only door to Bitrix24.

/**
 * Short owner-type code for crm.item.productrow.set `ownerType`.
 * Static entities have letter codes (D=deal, Q=quote, SI=smart-invoice);
 * dynamic smart-processes (entityTypeId >= 1000) use the `T<entityTypeId>` token,
 * NOT the bare numeric id (which B24 rejects). ⚠ verify `SI`/`T<id>` live per portal.
 */
export function ownerTypeCode(entityTypeId: number): string {
  if (entityTypeId === 2) return 'D'
  if (entityTypeId === 7) return 'Q'
  if (entityTypeId === 31) return 'SI'
  return `T${entityTypeId}`
}

export interface ProductRowInput {
  productId?: number
  productName: string
  price: number
  quantity: number
  /** VAT percent or null for «Без НДС». */
  taxRate: number | null
  /** Whether price includes VAT (document-level). */
  priceIncludesVat: boolean
  measureCode: number
}

/** Build one crm.item.productrow.set row. Clamps price/qty to finite, 2 dp. */
export function buildProductRow(input: ProductRowInput, sort: number): Record<string, unknown> {
  const price = round2(finite(input.price))
  const quantity = round2(finite(input.quantity, 1))
  const row: Record<string, unknown> = {
    productName: input.productName.slice(0, 500),
    price,
    quantity,
    taxRate: input.taxRate,
    taxIncluded: input.priceIncludesVat ? 'Y' : 'N',
    measureCode: input.measureCode,
    sort
  }
  if (input.productId && input.productId > 0) row.productId = input.productId
  return row
}

/** Map document items to product rows using resolved VAT rate + measure. */
export function buildProductRows(
  items: DocumentItem[],
  resolve: (item: DocumentItem, index: number) => { taxRate: number | null, measureCode: number, productId?: number },
  priceIncludesVat: boolean
): Array<Record<string, unknown>> {
  return items.map((item, i) => {
    const r = resolve(item, i)
    return buildProductRow({
      productId: r.productId,
      productName: item.name,
      price: item.price,
      quantity: item.quantity,
      taxRate: r.taxRate,
      priceIncludesVat,
      measureCode: r.measureCode
    }, (i + 1) * 10)
  })
}

/** Create the target entity via crm.item.add, returning its id. */
export async function createTargetItem(target: TargetRef, fields: Record<string, unknown>, call: RestCall): Promise<number> {
  const params: Record<string, unknown> = {
    entityTypeId: target.entityTypeId,
    fields: { ...fields }
  }
  if (target.categoryId != null) (params.fields as Record<string, unknown>).categoryId = target.categoryId
  if (target.stageId != null) (params.fields as Record<string, unknown>).stageId = target.stageId
  const res = await call('crm.item.add', params) as { item?: { id?: number } }
  const id = res?.item?.id
  if (!id) throw new Error('crm.item.add: no id in result')
  return id
}

/** Write product rows onto a created entity. */
export async function setProductRows(entityTypeId: number, ownerId: number, rows: Array<Record<string, unknown>>, call: RestCall): Promise<void> {
  await call('crm.item.productrow.set', {
    ownerType: ownerTypeCode(entityTypeId),
    ownerId,
    productRows: rows
  })
}

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
