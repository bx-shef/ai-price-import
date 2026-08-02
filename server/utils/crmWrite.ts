import type { RestCall } from './b24Rest'
import type { DocumentItem } from '~/types/document'
import type { TargetRef } from '~/types/mapping'

// Pure builders + thin callers for creating the target CRM entity and its rows.
// VAT model validated live: crm.item.productrow.set computes НДС 1-в-1 (no kernel patch).
// Consumers: server/queue/crmSyncCore.ts (production) and scripts/live-crm-sync.mjs. The old note
// here named an isolated MCP tool as the intended caller — that stopped being true when crm-sync
// began calling these builders directly, and a stale contract note is exactly how the invariant
// drift behind #302/#347 goes unnoticed.

/**
 * Short owner-type code for crm.item.productrow.set `ownerType`.
 * Static entities have letter codes (L=lead, D=deal, Q=quote, SI=smart-invoice); dynamic
 * smart-processes use `T` + entityTypeId in HEX, lowercase (the documented PREFIX rule —
 * apidocs «Типы данных и структура объектов»: 128 → T80). Both SI and the hex form are
 * live-verified; details in the inline comment below.
 */
export function ownerTypeCode(entityTypeId: number): string {
  if (entityTypeId === 1) return 'L' // lead — live-verified ('T1' → ACCESS_DENIED), #135
  if (entityTypeId === 2) return 'D'
  if (entityTypeId === 7) return 'Q'
  if (entityTypeId === 31) return 'SI'
  // Dynamic smart process: 'T' + entityTypeId in HEX — NOT decimal. Live-verified on the test
  // portal (etid 1120): 'T460' → OK, while 'T1120' / 'Tb24' / 'DYNAMIC_1120' all answer
  // ENTITY_TYPE_NOT_SUPPORTED. The decimal form silently broke EVERY smart-process product write —
  // and the error is the same one a products-disabled type returns, so it masqueraded as a portal
  // configuration problem rather than our bug. Hex LETTERS + case checked live too (etid 1054 =
  // 0x41E): 'T41e', 'T41E' and 't41e' are all accepted — the portal is case-insensitive here, so
  // toString(16)'s lowercase is safe.
  return `T${entityTypeId.toString(16)}`
}

export interface ProductRowInput {
  productId?: number
  productName: string
  /** DOCUMENT per-unit price — net or gross per `priceIncludesVat`. The written row's `price`
   *  is always gross (see buildProductRow). */
  price: number
  quantity: number
  /** VAT percent or null for «Без НДС». */
  taxRate: number | null
  /** Whether price includes VAT (document-level). */
  priceIncludesVat: boolean
  measureCode: number
}

/**
 * Build one crm.item.productrow.set row.
 *
 * B24 semantics (live-verified 2026-08-01 #302, refined 2026-08-02 #347): the row `price` is
 * ALWAYS the gross per-unit price — the docs say «цена … с учетом скидок и налогов» — and it is
 * the ONLY writable price field (`priceExclusive`/`priceNetto`/`priceBrutto` are read-only; sent
 * without `price` they yield a zero row). So the net→gross conversion happens HERE. Writing the
 * document's NET price undershot every row by the whole VAT, while the manually-set entity
 * `opportunity` (correct) masked it: the deal header said 10 320 and its product tab summed 8 600.
 *
 * `taxIncluded` does NOT touch the arithmetic — the same price with 'N' and with 'Y' stores
 * identical priceExclusive/priceBrutto/opportunity/taxValue — live-verified across lead, deal,
 * quote, smart-invoice AND a dynamic smart-process. What it DOES decide is which of the two stored
 * numbers the product grid PRINTS in the «Цена» column: 'N' → priceExclusive (net), 'Y' →
 * priceBrutto (gross). ⚠ The STORED side is verified everywhere; the PRINTED side was compared by
 * eye on deals only — REST cannot read the grid, so other entity types rest on the same rendering.
 * So it must MIRROR THE DOCUMENT'S OWN convention, not our storage format: a net-priced invoice
 * gets 'N' and the card then shows 0,86 with VAT on top, exactly as printed on paper; a
 * VAT-inclusive one gets 'Y' and shows the gross price, also as printed. #302 hardcoded 'Y' on the
 * theory that the flag merely labels the number we send — it does not, and the operators reading
 * 1,032 against a document printing 0,860 concluded the import had miscounted (#347).
 *
 * NO kopeck quantization anywhere in this function — neither on the converted price NOR on the
 * inputs. The header math (lineGross/grossTotal) works on RAW document precision and rounds the
 * line total once, so any 2-dp rounding here diverges the products tab from the header — the
 * very mismatch this builder exists to prevent:
 *   • converted gross: 0.86 @20% → 1.032; round2 → 1.03 → ×10 000 = 10 300 (not 10 320);
 *   • input net:  0.8654 @20% → round2 0.87 → 1.044 → ×10 000 = 10 440 vs header 10 384.80;
 *   • inclusive price: 1.032 → round2 1.03 → 10 300 — the same number through the other branch;
 *   • quantity: 1.3754 т → round2 1.38 → 165.60 vs header 165.05.
 * The portal stores ≥6 decimals verbatim (live-verified: 1.032456 came back unchanged), so 6 dp
 * (round6) preserves the document's own precision — sub-kopeck unit prices (per metre/kg/litre)
 * and 3-dp quantities are normal in this domain — while killing IEEE noise (0.86×1.2 is
 * 1.0319999… in floats).
 */
export function buildProductRow(input: ProductRowInput, sort: number): Record<string, unknown> {
  // B24 rejects a negative row price, so crm-sync already clamps before calling (a discount line
  // is carried by the entity total instead). Clamping HERE too costs nothing and stops the
  // invariant from resting on one caller's memory — the exact way #302/#347 happened.
  const net = Math.max(0, round6(finite(input.price)))
  const quantity = Math.max(0, round6(finite(input.quantity, 1)))
  const rate = input.taxRate == null ? 0 : finite(input.taxRate)
  const price = input.priceIncludesVat || rate <= 0 ? net : round6(net * (1 + rate / 100))
  const row: Record<string, unknown> = {
    productName: input.productName.slice(0, 500),
    price,
    quantity,
    taxRate: input.taxRate,
    // Display only (see above): picks WHICH stored number the grid prints as «Цена». Mirrors the
    // document so the card reads like the paper. ⚠ Nothing downstream may infer the price format
    // from this flag — `price` is gross either way (see computeOpportunity).
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
  // Stage goes straight into the add for ALL entity types, leads included (owner: одним шагом, без
  // второго вызова) — a lead's status field is `stageId` (crm_status; statuses via crm.status.list
  // ENTITY_ID='STATUS'). No category is needed to address a lead status.
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

/**
 * Gross total of the product rows (VAT-inclusive). Live-verified need: on portals
 * without trade-accounting/a catalog, `crm.item.productrow.set` does NOT recompute the
 * parent `opportunity` (it stays 0). Setting `opportunity` = this sum + `isManualOpportunity:'Y'`
 * at create time makes the entity total correct regardless of portal auto-recalc.
 *
 * ⚠ CONTRACT: rows come from `buildProductRow`, whose `price` is ALWAYS the gross per-unit price
 * (#302). So this is Σ round2(price × qty) and NOTHING here adds VAT — the net→gross conversion,
 * with its once-per-line rounding, already happened in the builder. (crm-sync prefers the
 * document's printed grand total when it states one — see reconcilePricing — this is the
 * fallback/partial path.)
 *
 * It used to read `taxIncluded` to decide whether to add VAT — harmless only while the flag was
 * hardcoded 'Y'. Since #347 the flag mirrors the DOCUMENT (it is what the grid prints in «Цена»),
 * so a net-priced invoice now carries 'N' next to an already-gross price: the old branch would
 * have added the VAT a second time and set the deal to 12 384 instead of 10 320. The lesson is the
 * comment above the flag — nothing may infer the price FORMAT from a DISPLAY setting.
 *
 * NB the portal's own tab total was observed (live, auto-recalc deal) to equal rounding the SUM
 * of unrounded row products — whether it also rounds per row is NOT verified; the two differ by
 * ≤ a cent per line, which is why the live check compares in whole kopecks with a per-line
 * allowance rather than exact equality.
 */
export function computeOpportunity(rows: Array<Record<string, unknown>>): number {
  let sum = 0
  for (const r of rows) {
    // Deliberately NOT `lineGross(…, null, true)`: passing two constants to hide the tax branch
    // leaves the double-VAT one refactor away — if lineGross ever read `rate` before checking
    // `inclusive`, this would silently start adding it again. The arithmetic is one line; say it.
    sum += round2(finite(Number(r.price)) * finite(Number(r.quantity), 1))
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
/** 6-dp rounding for row price/quantity: preserves the document's own precision (sub-kopeck unit
 *  prices, fractional quantities) so line totals stay exact to the cent at realistic quantities,
 *  while float noise (0.86×1.2 = 1.0319999…) collapses to 1.032. Assumes VAT rates with ≤2
 *  decimals (RF/RB/KZ rates are integers; расчётные like 16.67 are 2 dp) — a ≤2-dp net × ≤2-dp
 *  rate is exactly 6 dp, so nothing is lost; an exotic 3-dp rate would drop its 7th decimal
 *  (error ≤5e-7 per unit). */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
