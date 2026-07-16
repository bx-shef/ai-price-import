import type { ExtractedDocument } from '~/types/document'
import type { PortalMapping, TargetRef } from '~/types/mapping'
import { resolveTarget, type RoutingSignals } from '~/utils/routing'
import { resolveMeasure } from '~/utils/units'
import { matchVatRate, type PortalVatRate } from '~/utils/vat'
import { buildProductRow, computeOpportunity, supportsOpportunity } from '../utils/crmWrite'
import { originMarkerFields, originSearchFilter } from '../utils/originMarker'

// Pure crm-sync orchestration with injected dependencies (no I/O here).
// Deps are abstract async fns → wired to the isolated MCP tools (not direct REST):
// docs/redesign 02 §1.4 «MCP — единственная дверь в Bitrix24».

export interface CrmSyncDeps {
  /** Find a prior create of this job by its idempotency marker (originId/xmlId) via a
   *  crm.item.list filter — the source of truth is Bitrix24, not a local checkpoint. */
  findExisting: (entityTypeId: number, filter: Record<string, unknown>) => Promise<number | null>
  /** Originator code stamped into the marker (env; defaults to the repo code). */
  originatorPrefix?: string
  findCompanyByTaxId: (taxId: string) => Promise<number | null>
  findProduct: (item: ExtractedDocument['items'][number]) => Promise<number | null>
  /** Optional: create a catalog product for onMissing:'create'; returns its id. */
  createProduct?: (item: ExtractedDocument['items'][number]) => Promise<number | null>
  portalVatRates: () => Promise<PortalVatRate[]>
  /** Optional: allowed portal currency codes; when provided, an unknown currency is a hard error. */
  portalCurrencies?: () => Promise<string[]>
  createTarget: (target: TargetRef, fields: Record<string, unknown>) => Promise<number>
  setRows: (entityTypeId: number, entityId: number, rows: Array<Record<string, unknown>>) => Promise<void>
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
  /** Optional: record a configurable activity («настраиваемое дело») on the created entity's
   *  timeline. Best-effort — a failure must not fail the import. */
  writeActivity?: (input: {
    entityTypeId: number
    entityId: number
    supplierName?: string
    rowCount: number
  }) => Promise<void>
}

export interface CrmSyncResult {
  entityTypeId: number
  entityId: number
  created: boolean
  /** Product rows actually written (after skip-warn/skips) — the true «lines» count. */
  rowCount: number
  /** True when this was an idempotent resume (the entity's marker was found in B24) — a
   * redelivery of an already-processed job, so dashboard counters must NOT re-count it. */
  idempotent: boolean
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

  // Idempotency requires a filterable marker on the target type (originId/xmlId). A markerless
  // type (originSearchFilter → null; e.g. quote/7, or a nonsensical target set via free entityTypeId
  // input / routing rule / manual override) would create with NO marker → a retry can't find it and
  // silently duplicates. So we treat it as a HARD ERROR (→ error chat, no create) rather than create
  // a duplicate-prone entity. This is the code that ENFORCES «markerless types are not targets» (#135).
  const markerFilter = originSearchFilter(target.entityTypeId, jobId, deps.originatorPrefix)
  if (!markerFilter) {
    errors.push(`Целевая сущность (тип ${target.entityTypeId}) не поддерживается импортом — нет поля-маркера идемпотентности; выберите сделку, смарт-счёт или смарт-процесс`)
  }

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
    return { entityTypeId: target.entityTypeId, entityId: 0, created: false, rowCount: 0, idempotent: false, warnings, errors }
  }

  // Idempotency: the created entity carries a job-id MARKER (originId/originatorId for deal,
  // xmlId for invoice/smart-processes — originMarker.ts). On retry we SEARCH Bitrix24 for that
  // marker BEFORE creating, so the source of truth is the portal itself (no local DB checkpoint).
  // This closes the old create→checkpoint window: even if a retry runs after a create but before
  // anything was recorded, the marker on the entity is found. `markerFilter` is guaranteed non-null
  // here (a null one was caught as a hard error above).
  // KNOWN NARROW LIMITATION (vs the old jobId-keyed DB checkpoint): the search key derives from
  // mutable state — the resolved target's entityTypeId (mapping) and the originator (env). If the
  // portal mapping OR IMPORT_ORIGINATOR_ID is changed in the seconds-wide window between a create
  // and its retry, the retry searches under a different key and may duplicate. This targets crash
  // recovery, not concurrent reconfiguration; acceptable residual for the «search in B24» design.
  const existingId = await deps.findExisting(target.entityTypeId, markerFilter!)
  const entityTypeId = target.entityTypeId
  let entityId: number
  let created: boolean
  if (existingId) {
    entityId = existingId
    created = false
  } else {
    const fields: Record<string, unknown> = {
      // Idempotency marker FIRST so a retry can find this exact create.
      ...originMarkerFields(target.entityTypeId, jobId, deps.originatorPrefix),
      title: `Импорт: ${doc.supplier?.name ?? 'документ'}`.slice(0, 255),
      ...(companyId ? { companyId } : {}),
      ...(doc.currency ? { currencyId: doc.currency } : {}),
      // Set the total explicitly (+ manual flag): live-verified that productrow.set does
      // NOT recompute `opportunity` on portals without trade-accounting → deal would show 0.
      // Only for entities that always expose the field (deal/smart-invoice); dynamic
      // smart-processes are skipped (the field may be absent → create could be rejected).
      ...(rows.length && supportsOpportunity(target.entityTypeId)
        ? { opportunity: computeOpportunity(rows), isManualOpportunity: 'Y' }
        : {})
    }
    entityId = await deps.createTarget(target, fields)
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

  // Timeline activity («настраиваемое дело») — best-effort, gated on `created` like the
  // chat notification (a redelivered/idempotent job must not add a second дело). The live
  // transport is the OAuth SDK (real app context), where crm.activity.configurable.add
  // works; a webhook context would return ERROR_WRONG_CONTEXT (verified) — so this is a
  // no-op only on the dev webhook path, never in prod.
  if (deps.writeActivity && created) {
    try {
      await deps.writeActivity({ entityTypeId, entityId, supplierName: doc.supplier?.name, rowCount: rows.length })
    } catch {
      warnings.push('Дело в таймлайне не создано')
    }
  }

  return { entityTypeId, entityId, created, rowCount: rows.length, idempotent: !!existingId, warnings, errors }
}

function clampNonNeg(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback
  return n < 0 ? 0 : Math.round(n * 100) / 100
}
