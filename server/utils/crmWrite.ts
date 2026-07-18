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
  if (entityTypeId === 1) return 'L' // lead — live-verified ('T1' → ACCESS_DENIED), #135
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
  // Leads (entityTypeId 1) have NO categories (crm.category.list etid=1 → ENTITY_TYPE_NOT_SUPPORTED);
  // a stray categoryId — e.g. carried over when a deal routing rule is switched to «Лид» — makes
  // crm.item.add reject with «Item has no CATEGORY_ID field» (live-verified, #135). Skip it for leads.
  if (target.categoryId != null && target.entityTypeId !== 1) (params.fields as Record<string, unknown>).categoryId = target.categoryId
  // Leads ignore the stage on crm.item.add (live-verified: `stageId`/`statusId` both silently
  // dropped, the lead lands on the portal's default status) — so don't forward it for leads.
  if (target.stageId != null && target.entityTypeId !== 1) (params.fields as Record<string, unknown>).stageId = target.stageId
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

/**
 * Gross total of the product rows (VAT-inclusive). Live-verified need: on portals
 * without trade-accounting/a catalog, `crm.item.productrow.set` does NOT recompute the
 * parent `opportunity` (it stays 0). Setting `opportunity` = this sum + `isManualOpportunity:'Y'`
 * at create time makes the entity total correct regardless of portal auto-recalc.
 *
 * Rounding mirrors Bitrix EXACTLY: the per-unit gross price is rounded to 2 dp FIRST
 * (`priceBrutto = round2(price × (1+rate/100))`), THEN multiplied by quantity — otherwise
 * the header total would diverge from the row grid (Σ priceBrutto·qty) by kopecks on
 * net-priced multi-row docs, and `isManualOpportunity` would freeze that mismatch.
 */
export function computeOpportunity(rows: Array<Record<string, unknown>>): number {
  let sum = 0
  for (const r of rows) {
    const price = finite(Number(r.price))
    const qty = finite(Number(r.quantity), 1)
    const inclusive = r.taxIncluded === 'Y'
    const rate = r.taxRate == null ? 0 : finite(Number(r.taxRate))
    const unitGross = inclusive ? price : round2(price * (1 + rate / 100))
    sum += unitGross * qty
  }
  return round2(sum)
}

/**
 * Whether we set an explicit `opportunity`+`isManualOpportunity` on this entity type.
 * Only money-bearing STATIC entities always expose the field: lead(1), deal(2), quote(7),
 * smart-invoice(31) — all live-verified via crm.item.fields. Dynamic smart-processes
 * (entityTypeId ≥ 1000) expose it only when their money toggle is on — setting an absent field
 * can reject the create — so we skip them and let the portal handle the total.
 */
export function supportsOpportunity(entityTypeId: number): boolean {
  return entityTypeId === 1 || entityTypeId === 2 || entityTypeId === 7 || entityTypeId === 31
}

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
