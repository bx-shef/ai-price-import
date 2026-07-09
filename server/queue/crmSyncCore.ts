import type { ExtractedDocument } from '~/types/document'
import type { PortalMapping, TargetRef } from '~/types/mapping'
import { resolveTarget, type RoutingSignals } from '~/utils/routing'
import { resolveMeasure } from '~/utils/units'
import { matchVatRate, type PortalVatRate } from '~/utils/vat'
import { buildProductRow, computeOpportunity } from '../utils/crmWrite'

// Pure crm-sync orchestration with injected dependencies (no I/O here).
// Deps are abstract async fns → wired to the isolated MCP tools (not direct REST):
// docs/redesign 02 §1.4 «MCP — единственная дверь в Bitrix24».

export interface CrmSyncDeps {
  getExisting: (jobId: string) => Promise<{ entityTypeId: number, entityId: number } | null>
  findCompanyByTaxId: (taxId: string) => Promise<number | null>
  findProduct: (item: ExtractedDocument['items'][number]) => Promise<number | null>
  /** Optional: create a catalog product for onMissing:'create'; returns its id. */
  createProduct?: (item: ExtractedDocument['items'][number]) => Promise<number | null>
  portalVatRates: () => Promise<PortalVatRate[]>
  /** Optional: allowed portal currency codes; when provided, an unknown currency is a hard error. */
  portalCurrencies?: () => Promise<string[]>
  createTarget: (target: TargetRef, fields: Record<string, unknown>) => Promise<number>
  setRows: (entityTypeId: number, entityId: number, rows: Array<Record<string, unknown>>) => Promise<void>
  recordResult: (jobId: string, entityTypeId: number, entityId: number) => Promise<void>
  /** One error-chat message per document (batched). Supplier name for BB-safe context. */
  reportErrors: (messages: string[], supplierName?: string) => Promise<void>
  /** Optional success notification (chat). Failure here must not fail the import. */
  notifySuccess?: (summary: {
    supplierName?: string
    entityTypeId: number
    entityId: number
    created: boolean
    rowCount: number
    warnings: string[]
  }) => Promise<void>
}

export interface CrmSyncResult {
  entityTypeId: number
  entityId: number
  created: boolean
  warnings: string[]
  errors: string[]
}

/** Run the crm-sync step for one document. Idempotent: safe to retry. */
export async function runCrmSync(
  jobId: string,
  doc: ExtractedDocument,
  mapping: PortalMapping,
  signals: RoutingSignals,
  deps: CrmSyncDeps
): Promise<CrmSyncResult> {
  const warnings: string[] = []
  const errors: string[] = []
  const target = resolveTarget(signals, mapping.routingRules, mapping.defaultTarget)

  // Currency must exist in the portal (hard error → do not create a wrong-currency entity).
  if (doc.currency && deps.portalCurrencies) {
    const allowed = await deps.portalCurrencies()
    if (!allowed.includes(doc.currency)) errors.push(`Валюта ${doc.currency} отсутствует в портале`)
  }

  // Supplier: not found → still create, without company + warning.
  let companyId: number | null = null
  if (doc.supplier?.taxId) companyId = await deps.findCompanyByTaxId(doc.supplier.taxId)
  if (!companyId) warnings.push('Поставщик не найден — создано без компании')

  // Build rows. HARD errors (VAT rate not in portal) abort the whole document —
  // we must NOT drop lines (§8 «1-в-1, без потерь строк»); operator fixes the portal, re-imports.
  const vatRates = await deps.portalVatRates()
  // VAT-inclusion must be known when any line carries VAT — otherwise the whole-document
  // total flips (100 net → 120 gross). Undefined + VAT present ⇒ hard error, never guess.
  const hasVat = doc.items.some(it => (it.vatRate ?? 0) > 0)
  if (hasVat && doc.priceIncludesVat === undefined) {
    errors.push('Не определено, включён ли НДС в цену — уточните документ и повторите импорт')
  }
  const priceIncludesVat = doc.priceIncludesVat === true
  const rows: Array<Record<string, unknown>> = []
  let sort = 10
  for (const item of doc.items) {
    const vat = matchVatRate(item.vatRate ?? null, vatRates)
    if (item.vatRate != null && vat === null) {
      errors.push(`Ставка НДС ${item.vatRate}% отсутствует в портале (строка «${item.name}»)`)
      continue // hard error already recorded; abort happens below
    }
    const measure = resolveMeasure(item.unit, mapping.units)
    if (!measure.matched && item.unit) warnings.push(`Единица «${item.unit}» не сопоставлена — использован дефолт`)

    let productId = await deps.findProduct(item)
    if (!productId && mapping.product.onMissing === 'skip-warn') {
      warnings.push(`Товар «${item.name}» не найден — строка пропущена`)
      continue
    }
    if (!productId && mapping.product.onMissing === 'create') {
      productId = deps.createProduct ? await deps.createProduct(item) : null
      if (!productId) warnings.push(`Товар «${item.name}» не создан — внесён как произвольная позиция`)
    }

    if (item.price < 0 || item.quantity < 0) warnings.push(`Отрицательная цена/кол-во в «${item.name}» — обнулено`)
    rows.push(buildProductRow({
      productId: productId && productId > 0 ? productId : undefined,
      productName: item.name,
      price: clampNonNeg(item.price),
      quantity: clampNonNeg(item.quantity, 1),
      taxRate: vat ? vat.rate : null,
      priceIncludesVat,
      measureCode: measure.code
    }, sort))
    sort += 10
  }

  // Hard errors → report and DO NOT create a partial/wrong entity.
  if (errors.length) {
    await deps.reportErrors(errors, doc.supplier?.name)
    return { entityTypeId: target.entityTypeId, entityId: 0, created: false, warnings, errors }
  }

  // Idempotency: create + checkpoint before rows; on retry resume rows (productrow.set replaces).
  // NB: create→recordResult is not atomic (no transaction spans a REST create + a DB write).
  // If the process dies in that ~1ms window, a retry re-creates → a rare duplicate. Fully
  // closing it needs an entity-side job-id marker + pre-create search (future hardening).
  const existing = await deps.getExisting(jobId)
  let entityTypeId: number
  let entityId: number
  let created: boolean
  if (existing) {
    entityTypeId = existing.entityTypeId
    entityId = existing.entityId
    created = false
  } else {
    const fields: Record<string, unknown> = {
      title: `Импорт: ${doc.supplier?.name ?? 'документ'}`.slice(0, 255),
      ...(companyId ? { companyId } : {}),
      ...(doc.currency ? { currencyId: doc.currency } : {}),
      // Set the total explicitly (+ manual flag): live-verified that productrow.set does
      // NOT recompute `opportunity` on portals without trade-accounting → deal would show 0.
      ...(rows.length ? { opportunity: computeOpportunity(rows), isManualOpportunity: 'Y' } : {})
    }
    entityTypeId = target.entityTypeId
    entityId = await deps.createTarget(target, fields)
    await deps.recordResult(jobId, entityTypeId, entityId)
    created = true
  }

  if (rows.length) await deps.setRows(entityTypeId, entityId, rows)

  // Success chat notification (best-effort — never fail an import over a chat hiccup).
  // Gated on `created`: an idempotent resume (retry / redelivery of an already-done job)
  // must NOT re-post — the notification went out on the first, creating run.
  if (deps.notifySuccess && created) {
    try {
      await deps.notifySuccess({
        supplierName: doc.supplier?.name,
        entityTypeId,
        entityId,
        created,
        rowCount: rows.length,
        warnings
      })
    } catch {
      warnings.push('Уведомление в чат не отправлено')
    }
  }

  return { entityTypeId, entityId, created, warnings, errors }
}

function clampNonNeg(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback
  return n < 0 ? 0 : Math.round(n * 100) / 100
}
