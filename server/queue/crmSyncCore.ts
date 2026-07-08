import type { ExtractedDocument } from '~/types/document'
import type { PortalMapping } from '~/types/mapping'
import { resolveTarget, type RoutingSignals } from '~/utils/routing'
import { resolveMeasure } from '~/utils/units'
import { matchVatRate, type PortalVatRate } from '~/utils/vat'

// Pure crm-sync orchestration with injected dependencies (no I/O here).
// Ties routing → supplier lookup → product rows → target creation → file/activity.
// See docs/redesign 02 §4 «Запись в CRM» + матрица нестыковок.

export interface CrmSyncDeps {
  /** Idempotency: already-created entity for this job, or null. */
  getExisting: (jobId: string) => Promise<{ entityTypeId: number, entityId: number } | null>
  findCompanyByTaxId: (taxId: string) => Promise<number | null>
  findProduct: (item: ExtractedDocument['items'][number]) => Promise<number | null>
  portalVatRates: () => Promise<PortalVatRate[]>
  createTarget: (entityTypeId: number, fields: Record<string, unknown>) => Promise<number>
  setRows: (entityTypeId: number, entityId: number, rows: Array<Record<string, unknown>>) => Promise<void>
  recordResult: (jobId: string, entityTypeId: number, entityId: number) => Promise<void>
  /** Send an error line to the error chat (валюта/единица/…). */
  reportError: (message: string) => Promise<void>
}

export interface CrmSyncResult {
  entityTypeId: number
  entityId: number
  created: boolean
  warnings: string[]
  errors: string[]
}

/** Run the crm-sync step for one document. Returns the created (or existing) entity + report. */
export async function runCrmSync(
  jobId: string,
  doc: ExtractedDocument,
  mapping: PortalMapping,
  signals: RoutingSignals,
  deps: CrmSyncDeps
): Promise<CrmSyncResult> {
  const warnings: string[] = []
  const errors: string[] = []

  // Idempotency: never double-create on retry.
  const existing = await deps.getExisting(jobId)
  if (existing) {
    return { ...existing, created: false, warnings, errors }
  }

  const target = resolveTarget(signals, mapping.routingRules, mapping.defaultTarget)

  // Supplier: not found → still create, without company + warning.
  let companyId: number | null = null
  if (doc.supplier?.taxId) {
    companyId = await deps.findCompanyByTaxId(doc.supplier.taxId)
  }
  if (!companyId) warnings.push('Поставщик не найден — создано без компании')

  // VAT: rates from the portal; uniform taxIncluded on the whole document.
  const vatRates = await deps.portalVatRates()
  const priceIncludesVat = doc.priceIncludesVat === true

  const rows: Array<Record<string, unknown>> = []
  for (const item of doc.items) {
    const vat = matchVatRate(item.vatRate ?? null, vatRates)
    if (item.vatRate != null && vat === null) {
      errors.push(`Ставка НДС ${item.vatRate}% отсутствует в портале`)
      await deps.reportError(`Импорт: ставка НДС ${item.vatRate}% не настроена в портале`)
      continue
    }
    const measure = resolveMeasure(item.unit, mapping.units)
    if (!measure.matched) {
      errors.push(`Единица «${item.unit ?? ''}» не сопоставлена`)
      await deps.reportError(`Импорт: единица «${item.unit ?? ''}» не сопоставлена (использован дефолт)`)
    }
    const productId = await deps.findProduct(item)
    if (!productId && mapping.product.onMissing === 'skip-warn') {
      warnings.push(`Товар «${item.name}» не найден — строка пропущена`)
      continue
    }
    rows.push(buildRow(item, vat, measure.code, priceIncludesVat, productId))
  }

  const fields: Record<string, unknown> = {
    title: `Импорт: ${doc.supplier?.name ?? 'документ'}`.slice(0, 255),
    ...(companyId ? { companyId } : {}),
    ...(doc.currency ? { currencyId: doc.currency } : {})
  }
  const entityId = await deps.createTarget(target.entityTypeId, applyTargetToFields(fields, target))
  if (rows.length) await deps.setRows(target.entityTypeId, entityId, rows)
  await deps.recordResult(jobId, target.entityTypeId, entityId)

  return { entityTypeId: target.entityTypeId, entityId, created: true, warnings, errors }
}

function applyTargetToFields(fields: Record<string, unknown>, target: { categoryId?: number, stageId?: string }): Record<string, unknown> {
  return {
    ...fields,
    ...(target.categoryId != null ? { categoryId: target.categoryId } : {}),
    ...(target.stageId != null ? { stageId: target.stageId } : {})
  }
}

function buildRow(item: ExtractedDocument['items'][number], vat: PortalVatRate | null, measureCode: number, priceIncludesVat: boolean, productId: number | null): Record<string, unknown> {
  const row: Record<string, unknown> = {
    productName: item.name.slice(0, 500),
    price: round2(finite(item.price)),
    quantity: round2(finite(item.quantity, 1)),
    taxRate: vat ? vat.rate : null,
    taxIncluded: priceIncludesVat ? 'Y' : 'N',
    measureCode
  }
  if (productId && productId > 0) row.productId = productId
  return row
}

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
