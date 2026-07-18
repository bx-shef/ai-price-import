import type { ExtractedDocument } from '~/types/document'
import type { PortalMapping, TargetRef } from '~/types/mapping'
import { ENTITY_TYPE_ID } from '~/config/b24'
import { resolveTarget, resolveValidTarget, type RoutingSignals } from '~/utils/routing'
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
  /** Valid category (воронка) ids for an entity type (crm.category.list) — used to fall back off a
   *  DELETED funnel (rule/default → deal/direction-0). Optional: absent ⇒ no direction validation. */
  listCategoryIds?: (entityTypeId: number) => Promise<number[]>
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
  /** Optional: atomically CLAIM the one-time finalize (success chat + timeline дело) for this
   *  job (#164). Returns true for the FIRST run to claim, false for any later resume/redelivery.
   *  When absent (unit tests / no job row), the caller falls back to the `created` gate. */
  claimFinalize?: () => Promise<boolean>
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
  /** True when the supplier company could NOT be matched (no taxId or no `RQ_INN` hit) — the
   * entity was still created but without a company (see the warning). Drives the `unmatched`
   * dashboard counter so the operator sees how often supplier resolution fails. */
  unmatched: boolean
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
  const resolved = resolveTarget(signals, mapping.routingRules, mapping.defaultTarget)
  // Guard the resolved direction against a DELETED funnel (settings not fixed after the воронка was
  // removed in CRM): rule/manual with a gone direction → default target → deal/direction-0. No-op
  // when a target pins no categoryId, or when direction validation isn't wired (tests). Fail-open.
  let target = resolved
  if (deps.listCategoryIds) {
    target = await resolveValidTarget(resolved, mapping.defaultTarget, deps.listCategoryIds)
    // Surface the redirect so it's NOT silent: the operator sees the document landed in a fallback
    // target (its chosen/rule direction — or entity — was gone). Warning, not error: import proceeds.
    if (target.entityTypeId !== resolved.entityTypeId || target.categoryId !== resolved.categoryId) {
      warnings.push('Направление цели недоступно (воронка удалена в CRM) — импорт направлен в запасную цель')
    }
  }

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

  // Hard errors → report and DO NOT create a partial/wrong entity. `unmatched` stays FALSE here:
  // nothing was created, so this is NOT a «created without a company» case (that's what the counter
  // means — see the field JSDoc). A hard error is its own failure mode, counted via `errors`.
  if (errors.length) {
    await deps.reportErrors(errors, doc.supplier?.name)
    return { entityTypeId: target.entityTypeId, entityId: 0, created: false, rowCount: 0, idempotent: false, unmatched: false, warnings, errors }
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
      // Counterparty (#135): supplier FOUND → link companyId (repeat lead / deal on a company).
      // Supplier NOT found on a LEAD target → fill the lead's own companyTitle from the document
      // (a "raw" lead a manager qualifies) — this removes the unmatched dead-end that other
      // targets have. Other target kinds keep the prior behaviour (created without a company).
      ...(companyId
        ? { companyId }
        : (target.entityTypeId === ENTITY_TYPE_ID.lead && doc.supplier?.name
            ? { companyTitle: doc.supplier.name.slice(0, 255) }
            : {})),
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

  // FINALIZE (success chat + timeline дело) EXACTLY ONCE per job. Gating on `created` alone lost
  // both when a post-create step (setRows) threw on the first attempt and the retry resumed with
  // created=false — the entity existed, but the operator got no notice (#164). Instead we take a
  // write-once claim: whichever run wins finalizes; a resume/redelivery that finds it already
  // claimed skips (no double chat post). The claim runs AFTER setRows (the entity is fully built)
  // and BEFORE the side effects, so a crash between claim and post errs toward a missed notice
  // over a double post — the accepted trade (#164). Fallback to the `created` gate when no claim
  // dep is wired (unit tests, or a path without a tracked job row).
  const finalize = deps.claimFinalize ? await deps.claimFinalize() : created

  // Success chat notification (best-effort — never fail an import over a chat hiccup).
  if (deps.notifySuccess && finalize) {
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

  // Timeline activity («настраиваемое дело») — best-effort, same one-time finalize gate as the
  // chat notification (a redelivered/idempotent job must not add a second дело). The live
  // transport is the OAuth SDK (real app context), where crm.activity.configurable.add
  // works; a webhook context would return ERROR_WRONG_CONTEXT (verified) — so this is a
  // no-op only on the dev webhook path, never in prod.
  if (deps.writeActivity && finalize) {
    try {
      await deps.writeActivity({ entityTypeId, entityId, supplierName: doc.supplier?.name, rowCount: rows.length })
    } catch {
      warnings.push('Дело в таймлайне не создано')
    }
  }

  return { entityTypeId, entityId, created, rowCount: rows.length, idempotent: !!existingId, unmatched: !companyId, warnings, errors }
}

function clampNonNeg(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback
  return n < 0 ? 0 : Math.round(n * 100) / 100
}
