import type { ExtractedDocument } from '~/types/document'
import type { PortalMapping, TargetRef } from '~/types/mapping'
import { ENTITY_TYPE_ID } from '~/config/b24'
import { resolveTarget, resolveValidTarget, type RoutingSignals } from '~/utils/routing'
import { reconcilePricing } from '~/utils/pricing'
import { resolveMeasure } from '~/utils/units'
import { supplierNotLinkedWarning } from '~/utils/taxIdLabel'
import { normalizeUnitKey } from '~/utils/measureCreate'
import { matchVatRate, type PortalVatRate } from '~/utils/vat'
import { buildProductRow, computeOpportunity, supportsOpportunity } from '../utils/crmWrite'
import { originMarkerFields, originSearchFilter } from '../utils/originMarker'

// Pure crm-sync orchestration with injected dependencies (no I/O here).
// Deps are abstract async fns → wired to the isolated MCP tools (not direct REST):
// docs/PROCESS.md §6 «Запись в CRM».

/** The portal's own measure catalogue, as crm-sync needs it: does this code exist, and does this
 *  unit name a measure already in the portal? Loaded once per job by the live deps. */
export interface MeasureCatalog {
  hasCode: (code: number) => boolean
  byName: (unit: string) => number | null
}

export interface CrmSyncDeps {
  /** Find a prior create of this job by its idempotency marker (originId/xmlId) via a
   *  crm.item.list filter — the source of truth is Bitrix24, not a local checkpoint. */
  findExisting: (entityTypeId: number, filter: Record<string, unknown>) => Promise<number | null>
  /** Originator code stamped into the marker (env; defaults to the repo code). */
  originatorPrefix?: string
  findCompanyByTaxId: (taxId: string) => Promise<number | null>
  findProduct: (item: ExtractedDocument['items'][number]) => Promise<number | null>
  /** Optional: resolve an unmatched unit to a catalog measure (mapping.units.autoCreate, Q11) —
   *  find-before-create. Returns `{code, created}` (created=false ⇒ reused an existing measure), or
   *  null when not creatable / create failed / per-job cap reached (caller uses the default code). */
  createMeasure?: (unit: string) => Promise<{ code: number, created: boolean } | null>
  /** Optional: the portal's own measure catalogue (catalog.measure.list), loaded once per job.
   *  Needed because the built-in synonym map (#272) yields an ОКЕИ code that a given portal may not
   *  actually have — writing such a code produces a silently wrong measure on the row. `null` means
   *  the catalogue could not be read (distinct from «read, code absent»). */
  measureCatalog?: () => Promise<MeasureCatalog | null>
  portalVatRates: () => Promise<PortalVatRate[]>
  /** Optional: allowed portal currency codes; when provided, an unknown currency is a hard error. */
  portalCurrencies?: () => Promise<string[]>
  /** Valid category (воронка) ids for an entity type (crm.category.list) — used to fall back off a
   *  DELETED funnel (rule/default → deal/direction-0). Optional: absent ⇒ no direction validation. */
  listCategoryIds?: (entityTypeId: number) => Promise<number[]>
  /** Whether the portal has leads (classic CRM). In the SIMPLE CRM (no leads) a created lead is
   *  auto-converted at once, so a lead target is redirected to a deal. Optional: absent ⇒ no check. */
  leadsEnabled?: () => Promise<boolean>
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
    /** Matched client company id (RQ_INN hit), or null when the supplier wasn't found. When present,
     *  the дело is ALSO recorded on the company card (owner ask — visible in company AND deal). */
    companyId?: number | null
    supplierName?: string
    rowCount: number
    /** Import problems (товар не найден / единица / НДС уточнён / итог не сошёлся …) to record on the
     *  timeline дело so the operator sees what needed attention — not just the success counts. */
    warnings: string[]
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
      warnings.push('Воронка, выбранная для импорта, удалена в CRM. Документ внесён в запасную цель. Чтобы задать другую — откройте настройки импорта и выберите направление заново.')
    }
  }

  // Lead target on a NO-LEADS portal (simple CRM mode): a created lead is auto-converted immediately
  // (pointless), so redirect it to a DEAL (default funnel) with a warning. Fail-open: an unknown mode
  // (read failed) keeps the lead. Runs after the direction fallback, before the marker check (so the
  // deal's marker is used).
  if (deps.leadsEnabled && target.entityTypeId === ENTITY_TYPE_ID.lead && !(await deps.leadsEnabled())) {
    target = { entityTypeId: ENTITY_TYPE_ID.deal }
    warnings.push('В вашей CRM отключены лиды (простой режим), поэтому документ внесён в сделку. Это нормально: лид всё равно сразу превратился бы в сделку.')
  }

  // Idempotency requires a filterable marker on the target type (originId/xmlId). A markerless
  // type (originSearchFilter → null; e.g. quote/7, or a nonsensical target set via free entityTypeId
  // input / routing rule / manual override) would create with NO marker → a retry can't find it and
  // silently duplicates. So we treat it as a HARD ERROR (→ error chat, no create) rather than create
  // a duplicate-prone entity. This is the code that ENFORCES «markerless types are not targets» (#135).
  const markerFilter = originSearchFilter(target.entityTypeId, jobId, deps.originatorPrefix)
  if (!markerFilter) {
    errors.push(`Импорт остановлен: в этот тип CRM-сущности (${target.entityTypeId}) вносить нельзя — приложение не сможет защититься от повторной записи. Откройте настройки импорта и выберите сделку, смарт-счёт или смарт-процесс.`)
  }

  // Currency must exist in the portal (hard error → do not create a wrong-currency entity).
  if (doc.currency && deps.portalCurrencies) {
    const allowed = await deps.portalCurrencies()
    if (!allowed.includes(doc.currency)) errors.push(`Импорт остановлен: валюты ${doc.currency} из документа нет в вашем Битрикс24. Добавьте её в CRM (Настройки → Валюты) и запустите импорт снова.`)
  }

  // Supplier: not found → still create, without company + warning.
  let companyId: number | null = null
  if (doc.supplier?.taxId) companyId = await deps.findCompanyByTaxId(doc.supplier.taxId)
  // Two different situations, two different messages (#264): a number we searched by and did not
  // find, versus no number in the document at all (nothing was searched — «заведите компанию» would
  // not help). The number itself is printed so the operator can check it against the document.
  if (!companyId) warnings.push(supplierNotLinkedWarning(doc.supplier?.taxId, doc.supplier?.taxIdKind))

  // Build rows. HARD errors (VAT rate not in portal) abort the whole document —
  // we must NOT drop lines (§8 «1-в-1, без потерь строк»); operator fixes the portal, re-imports.
  const vatRates = await deps.portalVatRates()
  // VAT-inclusion must be known when any line carries VAT — otherwise the whole-document
  // total flips (100 net → 120 gross). Reconcile against the document's PRINTED grand total
  // («Всего к оплате»): if it matches the net- or gross-priced interpretation, trust that (and the
  // printed total for the entity amount) — this corrects a model that guessed the flag wrong and
  // removes per-unit rounding drift. Undefined flag + VAT present + no usable printed total ⇒ hard
  // error, never guess.
  const hasVat = doc.items.some(it => (it.vatRate ?? 0) > 0)
  // Pass the TRI-STATE flag through (boolean | undefined) — reconcilePricing distinguishes «model said
  // net» from «model didn't say» so the «уточнён по итогу» warning fires when an unknown flag is resolved.
  const pricing = reconcilePricing(doc.items, doc.priceIncludesVat, doc.total)
  const priceIncludesVat = pricing.priceIncludesVat
  if (hasVat && doc.priceIncludesVat === undefined && !pricing.usedStatedTotal) {
    errors.push('Импорт остановлен: по документу не понять, включён НДС в цену или нет, а в итоге разница. Проверьте в документе строку «Всего к оплате» и загрузите его снова.')
  }
  if (pricing.corrected) {
    warnings.push(`По итогу документа уточнили НДС: ${priceIncludesVat ? 'цены указаны с НДС' : 'цены указаны без НДС'}. Если это не так — сверьте сумму в созданной записи.`)
  }
  if (pricing.totalMismatch) {
    warnings.push('Итог, напечатанный в документе, не сошёлся с суммой строк. Откройте созданную запись и сверьте сумму вручную.')
  }

  // PRE-PASS: validate every line's VAT rate against the portal BEFORE any catalog write. The create
  // loop below writes products/measures as it iterates, so a bad rate on a LATER line would otherwise
  // leave orphan catalog entries from earlier lines even though the whole document aborts. Detect all
  // hard errors up front and bail before writing anything. §8 «1-в-1» — never silently drop a line.
  for (const item of doc.items) {
    // 0 / absent = «Без НДС» → the B24 «Без НДС» flag (taxRate null), NOT a lookup for a 0% rate (a
    // portal with only «Без НДС» would otherwise fail the whole document, #owner). A NEGATIVE rate is
    // garbage (bad extraction) — a hard error, never silently tax-exempt. A positive rate must exist in
    // the portal.
    if (item.vatRate != null && item.vatRate < 0) {
      errors.push(`Импорт остановлен: в строке «${item.name}» отрицательная ставка НДС (${item.vatRate}%) — так не бывает, документ распознан неверно. Проверьте эту строку в файле и загрузите документ снова.`)
    } else if ((item.vatRate ?? 0) > 0 && matchVatRate(item.vatRate!, vatRates) === null) {
      errors.push(`Импорт остановлен: ставки НДС ${item.vatRate}% (строка «${item.name}») нет в вашем Битрикс24. Добавьте её в CRM (Настройки → Ставки налога) и запустите импорт снова.`)
    }
  }
  // Hard errors (VAT inclusion undefined and/or an unknown rate) → report and create NOTHING (no
  // catalog writes have happened yet). `unmatched` stays false — nothing was created.
  if (errors.length) {
    await deps.reportErrors(errors, doc.supplier?.name)
    return { entityTypeId: target.entityTypeId, entityId: 0, created: false, rowCount: 0, idempotent: false, unmatched: false, warnings, errors }
  }

  const rows: Array<Record<string, unknown>> = []
  const warnedUnits = new Set<string>() // dedupe per-unit measure warnings across rows
  let sort = 10
  for (const item of doc.items) {
    // Only a positive rate is matched (validated in the pre-pass); 0 / absent = «Без НДС» → taxRate
    // null (the B24 «Без НДС» flag), never a 0%-rate lookup.
    const vat = (item.vatRate ?? 0) > 0 ? matchVatRate(item.vatRate!, vatRates) : null

    const productId = await deps.findProduct(item)
    if (!productId && mapping.product.onMissing === 'skip-warn') {
      warnings.push(`Товар «${item.name}» не найден в каталоге — строка пропущена. Заведите товар (или поменяйте в настройках «Если товар не найден» на «Внести как произвольную позицию»).`)
      continue
    }
    // onMissing === 'freeform' (product creation was removed): an unmatched line is written as a
    // free-form position (productId undefined) carrying the document name/price.

    // Measure resolved only for a row we're actually writing (a SKIPPED row must not auto-create a
    // measure — #Q11 security). Auto-create (opt-in) when the unit isn't in the dictionary; best-
    // effort → a null (not creatable / create failed / cap reached) falls back to the default code.
    // Three layers, then the portal catalogue as the reality check (#272):
    //   1. the portal's own dictionary — the administrator said so, we don't second-guess it;
    //   2. the portal's measure catalogue by name — a portal that has its own «Рулон» must get ITS
    //      code, not the standard 736 from our map;
    //   3. the built-in synonym map — but only if the portal actually HAS that code.
    // Anything else falls through to auto-create (opt-in) / the default code, as before.
    const measure = resolveMeasure(item.unit, mapping.units)
    let measureCode = measure.code
    let matched = measure.matched
    if (measure.source !== 'portal' && item.unit) {
      const catalog = deps.measureCatalog ? await deps.measureCatalog() : null
      const own = catalog?.byName(item.unit) ?? null
      if (own !== null) {
        measureCode = own
        matched = true
      } else if (measure.source === 'builtin') {
        // Catalogue unreadable (null) → keep the built-in code: it is still far closer to the truth
        // than silently writing «шт», which is what happened before this map existed.
        matched = !catalog || catalog.hasCode(measure.code)
        if (!matched) measureCode = mapping.units.defaultCode
      }
    }
    if (!matched && item.unit) {
      const res = mapping.units.autoCreate && deps.createMeasure ? await deps.createMeasure(item.unit) : null
      const uKey = normalizeUnitKey(item.unit) // same normalization as the measure index/cache
      if (res) {
        measureCode = res.code
        if (!warnedUnits.has(uKey)) {
          warnings.push(res.created
            ? `Единица измерения «${item.unit}» добавлена в каталог Битрикс24 (код ${res.code}).`
            : `Единица измерения «${item.unit}» сопоставлена с единицей из вашего Битрикс24 (код ${res.code}).`)
          warnedUnits.add(uKey)
        }
      } else if (!warnedUnits.has(uKey)) {
        warnings.push(`Единица измерения «${item.unit}» не распознана — подставлена единица по умолчанию. Добавьте её в настройках импорта, в разделе «Товары и единицы».`)
        warnedUnits.add(uKey)
      }
    }

    if (item.price < 0 || item.quantity < 0) warnings.push(`В строке «${item.name}» цена или количество отрицательные — записаны как 0. Проверьте эту строку в созданной записи.`)
    rows.push(buildProductRow({
      productId: productId && productId > 0 ? productId : undefined,
      productName: item.name,
      price: clampNonNeg(item.price),
      quantity: clampNonNeg(item.quantity, 1),
      taxRate: vat ? vat.rate : null,
      priceIncludesVat,
      measureCode
    }, sort))
    sort += 10
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
    // Entity total: when the WHOLE document was written (no line skipped) use the reconciled document
    // total — that is the printed «Всего к оплате» when trusted, else the per-line sum over the ORIGINAL
    // items. Both reflect a discount line (negative price), which the persisted rows can't (row price is
    // clamped ≥0 for B24) — so we must NOT re-sum the clamped rows here or a discount would be lost. Only
    // a PARTIAL write (skip-warn dropped a line) falls back to the sum of rows actually written.
    const allLinesWritten = rows.length === doc.items.length
    const opportunityValue = allLinesWritten ? pricing.grossTotal : computeOpportunity(rows)
    // Partial write (skip-warn dropped a line): the deal amount is the sum of the WRITTEN rows, so it
    // will NOT equal the document's printed total. Warn explicitly — otherwise a bookkeeper sees a deal
    // whose sum is silently smaller than the paper (the per-line «строка пропущена» warnings don't say
    // the TOTAL is now off). Only when the document actually printed a total to diverge from.
    if (!allLinesWritten && doc.total != null && Number.isFinite(doc.total)) {
      warnings.push('Часть строк пропущена, поэтому сумма записи меньше итога документа. Сверьте сумму вручную или добавьте недостающие товары в каталог и повторите импорт.')
    }
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
        ? { opportunity: opportunityValue, isManualOpportunity: 'Y' }
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
      warnings.push('Документ внесён, но сообщение в чат отправить не удалось. Проверьте, что чат уведомлений выбран в настройках и приложение имеет к нему доступ.')
    }
  }

  // Timeline activity («настраиваемое дело») — best-effort, same one-time finalize gate as the
  // chat notification (a redelivered/idempotent job must not add a second дело). The live
  // transport is the OAuth SDK (real app context), where crm.activity.configurable.add
  // works; a webhook context would return ERROR_WRONG_CONTEXT (verified) — so this is a
  // no-op only on the dev webhook path, never in prod.
  if (deps.writeActivity && finalize) {
    try {
      await deps.writeActivity({ entityTypeId, entityId, companyId, supplierName: doc.supplier?.name, rowCount: rows.length, warnings })
    } catch {
      warnings.push('Документ внесён, но запись в таймлайне создать не удалось. На сам импорт это не влияет — товары в CRM записаны.')
    }
  }

  return { entityTypeId, entityId, created, rowCount: rows.length, idempotent: !!existingId, unmatched: !companyId, warnings, errors }
}

function clampNonNeg(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback
  return n < 0 ? 0 : Math.round(n * 100) / 100
}
