import type { ExtractedDocument } from '~/types/document'
import type { PortalMapping, TargetRef } from '~/types/mapping'
import { ENTITY_TYPE_ID } from '~/config/b24'
import { resolveTarget, resolveValidTarget, type RoutingSignals } from '~/utils/routing'
import { describeTotalMismatch, findTotalGapSuspect, pricingTolerance, reconcilePricing } from '~/utils/pricing'
import { resolveMeasure } from '~/utils/units'
import { supplierNotLinkedWarning } from '~/utils/taxIdLabel'
import { buildFailedImportTitle, buildImportTitle, supplierNameTrusted } from '~/utils/importTitle'
import { normalizeUnitKey } from '~/utils/measureCreate'
import { allLinesSkippedError, lineSkippedWarning, noLinesMatchedWarning, skippedLinesAdvice } from '~/utils/importOutcome'
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
  /** Имя загруженного файла — попадает в заголовок карточки НЕУДАЧНОЙ загрузки (#459): по нему
   *  человек понимает, о каком документе речь, не открывая карточку. */
  sourceFileName?: string
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
    /** Совет «что делать с пропущенными строками» — ОТДЕЛЬНО от `warnings` (#388). Это подсказка,
     *  а не дефект документа: в общем списке она и раздувала счётчик («Проблемы (4)» при трёх
     *  пропущенных строках), и подавалась человеку как ещё одна поломка. Печатается отдельной
     *  строкой ПОСЛЕ списка и вне его обрезки. */
    advice?: string
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
    /** Сколько строк связано с каталогом — блок «Позиций: N · сопоставлено: M» в деле. */
    matchedCount?: number | null
    /** Готовая подпись суммы для дела («10 320,00 BYN»). Собирается ЗДЕСЬ, а не в проводке, чтобы
     *  число в деле приходило из того же расчёта, что и сумма записи: два независимых
     *  форматирования разъехались бы, и дело сообщало бы сумму, отличную от карточки. */
    amountLabel?: string
    /** Import problems (товар не найден / единица / НДС уточнён / итог не сошёлся …) to record on the
     *  timeline дело so the operator sees what needed attention — not just the success counts. */
    warnings: string[]
    /** См. `notifySuccess.advice` (#388): подсказка, не проблема — отдельной строкой и вне обрезки. */
    advice?: string
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
  /** Совет «что делать с пропущенными строками» — подсказка, НЕ проблема (#388). Отдельно от
   *  `warnings`: там он раздувал счётчик («Проблемы (4)» на трёх пропущенных строках) и подавался
   *  человеку как ещё одна поломка документа. Потребители печатают его отдельной строкой после
   *  списка и вне его обрезки. */
  advice?: string
  errors: string[]
}

// ⚠ ПРАВИЛО ВЛАДЕЛЬЦА (#459): импорт создаёт сущность CRM ВСЕГДА — и когда файл не разобрался, и
// когда ни одна позиция не найдена. Цель, воронка и стадия берутся из настроек; сумма таких
// карточек РОВНО 0, заголовок начинается словами «Импорт не удался». Причина: журнал импортов на
// главной строится из ДЕЛ, а дело не существует без карточки-владельца (`crm.activity.todo.add`
// требует `ownerTypeId` и проверяет его на существование — live-verified). Загрузка без записи не
// оставляла бы в портале НИ СЛЕДА, и журнал молчал бы ровно о тех случаях, ради которых в него
// заходят. ⚠ Отказ при этом остаётся отказом: ошибки уходят в чат, статус задания «Ошибка».
// ⚠ Плата принята владельцем: в воронку попадает карточка на каждый негодный файл. Отличают их
// глазами по трём признакам разом — название, сумма 0 и первая стадия.

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
    // ⚠ ЕДИНСТВЕННОЕ исключение из правила «запись создаётся всегда» (#459), и оно вынужденное:
    // у типа без маркера повтор задания не сможет найти прежнюю запись, поэтому «создавать всегда»
    // означало бы «дублировать при каждом ретрае». Молча плодить карточки хуже, чем не оставить
    // следа: клиент получил бы не пропуск в журнале, а мусор в воронке, растущий сам по себе.
    // Настройка при этом чинится в одно действие — текст ошибки прямо говорит, что выбрать.
    await deps.reportErrors(errors, doc.supplier?.name)
    return { entityTypeId: target.entityTypeId, entityId: 0, created: false, rowCount: 0, idempotent: false, unmatched: false, warnings, errors }
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
  if (!companyId) warnings.push(supplierNotLinkedWarning(doc.supplier?.taxId, doc.supplier?.taxIdKind, doc.supplier?.name))

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
  if (pricing.totalAmbiguous) {
    // #302: печатный итог совпал с суммой строк, но эта сумма — одновременно и «Всего к оплате»
    // документа с НДС в цене, и «Итого» документа без НДС. Числа тут не различают эти случаи, и мы
    // взяли слово модели. Молчать нельзя: если модель взяла «Итого», в сделке не хватит НДС.
    warnings.push('Итог документа совпадает с суммой строк, поэтому по цифрам не отличить «цены с НДС» от «цены без НДС». Взяли вариант «цены с НДС» — откройте созданную запись и сверьте сумму с документом.')
  }
  if (pricing.totalMismatch) {
    // #336: назвать НОМЕРА, а не факт. Разница — поисковый ключ: неверно прочитанная ячейка
    // (не та ценовая колонка, количество, съеденное названием) сдвигает ровно одну строку. Если
    // разница арифметически сходится ровно с ОДНОЙ строкой — называем и её: на документе в 44 или
    // 61 позицию (такие в прогоне были) три числа всё ещё оставляли человека искать глазами.
    // Допуск — ТОТ ЖЕ, которым сверка признала расхождение: полукопеечный показывал не на ту строку
    // (настоящий виновник в него не укладывался на документе с НДС, округлённым на итог).
    const suspect = findTotalGapSuspect(
      doc.items,
      pricing.grossTotal - (doc.total ?? 0),
      priceIncludesVat,
      pricingTolerance(doc.items.length, doc.total ?? 0)
    )
    // Строку зовём ПО НАЗВАНИЮ: наш номер — позиция в разобранном списке, и он расходится с бумагой
    // ровно тогда, когда строка при разборе потерялась, — то есть в том самом случае, ради которого
    // подсказка и существует.
    warnings.push(describeTotalMismatch(doc.total, pricing.grossTotal, doc.currency, suspect, suspect ? doc.items[suspect.index]?.name : undefined))
  }
  // #337: флаг «цены с НДС» ничем не подтверждён, а он меняет сумму сделки ровно на ставку налога.
  // Раньше здесь была тишина: тот же документ с однозначным итогом получал предупреждение
  // (totalAmbiguous), а этот — ничего, хотя знаем мы РОВНО СТОЛЬКО ЖЕ. Прайс и КП — половина
  // поддерживаемых типов входа, и итога у них часто нет по жанру. Флаг НЕ трогаем (в обе стороны
  // это гадание), но молчать нельзя.
  //
  // ⚠ ПРИЧИНА берётся из `hasPrintedTotal`, а НЕ выводится из `!usedStatedTotal`: не подтверждён —
  // не значит «не напечатан». Документ, где итог совпал с суммой строк без НДС, читается как «Итого»
  // и намеренно не якорится (reconcilePricing), то есть `usedStatedTotal` false при живой строке
  // «Всего к оплате» на бумаге — первая редакция этого предупреждения уверенно сообщала оператору,
  // что строки нет, ровно когда он на неё смотрел.
  if (hasVat && doc.priceIncludesVat !== undefined && !pricing.usedStatedTotal
    && !pricing.totalMismatch && !pricing.totalAmbiguous) {
    const taken = `Взяли вариант «${priceIncludesVat ? 'цены с НДС' : 'цены без НДС'}» — откройте созданную запись и сверьте сумму с документом.`
    warnings.push(pricing.hasPrintedTotal
      ? `Итог документа совпал с суммой строк без НДС, поэтому подтвердить цифрами, включён ли НДС в цены, нечем. ${taken}`
      : `В документе нет строки «Всего к оплате», поэтому проверить нечем, включён ли НДС в цены. ${taken}`)
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
  // ⚠ Раньше здесь стоял ВЫХОД без записи. Теперь запись создаётся всегда (#459): загрузка, не
  // оставившая в портале следа, не попадает в журнал импортов — а он строится из дел, и дело не
  // существует без карточки-владельца. Ошибки по-прежнему уходят в чат и в результат; цикл по
  // строкам ниже пропускается целиком, поэтому каталог не трогается ни одной записью.
  const documentUnusable = errors.length > 0
  if (documentUnusable) await deps.reportErrors(errors, doc.supplier?.name)

  const rows: Array<Record<string, unknown>> = []
  const warnedUnits = new Set<string>() // dedupe per-unit measure warnings across rows
  let skippedLines = 0
  let matchedLines = 0
  let sort = 10
  for (const item of documentUnusable ? [] : doc.items) {
    // Only a positive rate is matched (validated in the pre-pass); 0 / absent = «Без НДС» → taxRate
    // null (the B24 «Без НДС» flag), never a 0%-rate lookup.
    const vat = (item.vatRate ?? 0) > 0 ? matchVatRate(item.vatRate!, vatRates) : null

    const productId = await deps.findProduct(item)
    if (!productId && mapping.product.onMissing === 'skip-warn') {
      warnings.push(lineSkippedWarning(item.name))
      skippedLines++
      continue
    }
    if (productId) matchedLines++
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

  // EVERY line was skipped (skip-warn + not a single product matched the catalogue) — #373. Before
  // this guard the import created an entity with NO rows, sum 0 and no company, and reported it as
  // «Готово»: the operator saw five green imports and five useless deals to delete by hand. The
  // per-line «строка пропущена» warnings did say it, but they sat inside a successful-looking result.
  //
  // We create NOTHING rather than an empty entity: with no rows there is nothing in the entity that
  // the document contributed, so it is pure noise in the funnel — and the operator would have to
  // delete it before re-importing anyway. The hard-error path gives the honest outcome for free:
  // status «Ошибка», error-chat message, no timeline дело about a document that didn't land.
  //
  // ⚠ AFTER the marker search, not before (ревью): attempt 1 could have created a POPULATED entity
  // and died before recording it, and by the retry the catalogue may no longer match (product
  // deactivated, `onMissing` flipped). Checking rows first would then declare «запись в CRM не
  // создана» about a deal that is sitting in the funnel, flip a finished job to «Ошибка», and lose
  // the marker that protects the re-upload from duplicating it. A marker hit wins: the document DID
  // land, the run is an idempotent redelivery, and nothing is reported as failed.
  //
  // ⚠ `doc.items.length > 0` — сегодня недостижимо (`validateExtractedDocument` отвергает документ
  // без позиций ещё в извлечении), но остаётся страховкой: без него текст «ни одна из 0 позиций»
  // и сам отказ появились бы у документа, который ничего не пропускал.
  // ⚠ Тоже БЕЗ выхода (#459): отказ остаётся отказом — он уходит в чат и в результат, — но запись
  // создаётся, иначе загрузка не оставит следа и в журнале её не будет. Плата принята владельцем:
  // карточка с нулевой суммой на первой стадии.
  const allSkippedReported = !existingId && !documentUnusable && doc.items.length > 0 && rows.length === 0
  if (allSkippedReported) {
    errors.push(allLinesSkippedError(doc.items.length))
    await deps.reportErrors(errors, doc.supplier?.name)
    // `unmatched` — честное состояние поиска поставщика (он уже отработал выше), а не константа:
    // счётчик существует ровно чтобы показывать, как часто поставщик не находится, и обнулять его
    // на самом провальном классе документов значит занижать его именно там, где он важен.
  }

  // Совет «что делать с пропущенными» — РОВНО ОДИН раз на документ и только когда импорт всё-таки
  // состоялся. Стоит ЗДЕСЬ, после жёсткой ошибки, по двум причинам:
  //
  //  • пропущено всё и записи нет ⇒ совет уже несёт текст отказа выше; продублировать его значило бы
  //    вернуть ту самую простыню повторов, ради которой его убрали из построчных строк;
  //  • но повтор задания, чья первая попытка создала запись, а к ретраю каталог изменился так, что
  //    строки перестали подбираться, до отказа НЕ доходит (маркер найден) — и на прежнем месте
  //    (`rows.length > 0`) совет там не появлялся вовсе. Разбор нашёл эту дыру.
  //
  // ⚠ Совет НЕ кладётся в `warnings` (#388). Прежде он стоял там первым — потребители режут список
  // с начала (дело по шести, чат по десяти), и в хвосте он отрезался бы тем вернее, чем больше строк
  // пропущено, то есть ровно там, где нужнее. Но место в списке проблем стоило дороже: счётчик
  // печатал «Проблемы (4)» на трёх пропущенных строках, а сама подсказка читалась как четвёртая
  // поломка документа. Отдельное поле снимает и обрезку, и счётчик разом.
  // ⚠ Условие — «отказ уже произнёс совет», а НЕ «строки записаны». Разница видна на повторе
  // задания, чья первая попытка создала запись: маркер найден, отказ не печатается, строк ноль —
  // и совет обязан прозвучать, иначе человек остаётся без единственного указания, что делать.
  // Проверка `rows.length > 0` тут была бы неверной ровно на этом случае.
  const advice = skippedLines > 0 && !allSkippedReported ? skippedLinesAdvice() : undefined

  // ⚠ «Ни одна строка не связалась с каталогом» — ОТДЕЛЬНОЕ предупреждение и самый тихий исход из
  // возможных: строки записаны все до единой, сумма верна, статус «Готово», а связи с номенклатурой
  // нет ни у одной. Заметить нечего, всплывает недели спустя в отчёте по товарам. Ставится только
  // при `freeform` (при `skip-warn` строк просто не будет и сработает другой текст) и только когда
  // записанные строки ЕСТЬ — иначе оно повторяло бы отказ выше.
  if (rows.length > 0 && matchedLines === 0 && mapping.product.onMissing === 'freeform') {
    warnings.push(noLinesMatchedWarning(Boolean(mapping.article.field)))
  }

  // Подпись суммы для дела таймлайна. Считается ОДИН раз и здесь же, где считается сумма записи:
  // отдельный расчёт в проводке рано или поздно разошёлся бы с карточкой, и дело сообщало бы
  // человеку не то число, которое стоит в CRM.
  // ⚠ Валюты может не быть — тогда печатаем голое число, а не выдуманный код.
  const activityAmountLabel = Number.isFinite(pricing.grossTotal)
    ? `${pricing.grossTotal.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${doc.currency ? ` ${doc.currency}` : ''}`
    : ''

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
    // ⚠ Неудачная загрузка (#459) — сумма РОВНО 0, а не печатный итог документа: позиций в карточке
    // нет, и любое другое число обещало бы деньги, которых в записи не существует, и попало бы в
    // отчёты клиента по обороту. Ноль и первая стадия — то, по чему такие карточки отличают глазами.
    const failedImport = rows.length === 0
    const opportunityValue = failedImport ? 0 : (allLinesWritten ? pricing.grossTotal : computeOpportunity(rows))
    // Partial write (skip-warn dropped a line): the deal amount is the sum of the WRITTEN rows, so it
    // will NOT equal the document's printed total. Warn explicitly — otherwise a bookkeeper sees a deal
    // whose sum is silently smaller than the paper (the per-line «строка пропущена» warnings don't say
    // the TOTAL is now off). Only when the document actually printed a total to diverge from.
    if (!allLinesWritten && doc.total != null && Number.isFinite(doc.total)) {
      warnings.push('Часть строк пропущена, поэтому сумма записи меньше итога документа. Сверьте сумму вручную или добавьте недостающие товары в каталог и повторите импорт.')
    }
    // Одно вычисление на обе точки: повторный вызов с `!` ломался бы молча при следующей правке.
    const trustedSupplierName = supplierNameTrusted(doc)
    const fields: Record<string, unknown> = {
      // Idempotency marker FIRST so a retry can find this exact create.
      ...originMarkerFields(target.entityTypeId, jobId, deps.originatorPrefix),
      // ⚠ Заголовок неудачной загрузки говорит об этом ПЕРВЫМ СЛОВОМ: такие карточки человек
      // отличает в списке сущностей, не открывая их (#459).
      title: failedImport ? buildFailedImportTitle(deps.sourceFileName) : buildImportTitle(doc, opportunityValue),
      // Counterparty (#135): supplier FOUND → link companyId (repeat lead / deal on a company).
      // Supplier NOT found on a LEAD target → fill the lead's own companyTitle from the document
      // (a "raw" lead a manager qualifies) — this removes the unmatched dead-end that other
      // targets have. Other target kinds keep the prior behaviour (created without a company).
      // ⚠ `companyTitle` лида подчиняется ТОМУ ЖЕ правилу, что и заголовок (#440): здесь непроверенное
      // название становится не подписью, а ПОЛЕМ ДАННЫХ карточки — то есть хуже заголовка. Два
      // независимых условия разъехались бы, и имя, не попавшее в заголовок, всё равно оказалось бы
      // в карточке; поэтому обе точки читают один `supplierNameTrusted`.
      ...(companyId
        ? { companyId }
        : (target.entityTypeId === ENTITY_TYPE_ID.lead && trustedSupplierName
            ? { companyTitle: trustedSupplierName.slice(0, 255) }
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
  // ⚠ Успешным импорт считается ТОЛЬКО без жёстких ошибок (#459). Раньше это следовало из того,
  // что при ошибке до создания дело не доходило; теперь запись-след создаётся всегда, и без
  // явного условия в чат ушло бы «Готово» по документу, который не разобрался, — то есть худшая
  // из возможных ложь: человек не пошёл бы разбираться.
  // ⚠ Сама ЗАЯВКА на финализацию тоже не подаётся: она одноразовая, и потратить её на неудачный
  // прогон значило бы лишить сообщения тот повтор задания, который в итоге сработает.
  const importSucceeded = errors.length === 0
  const finalize = importSucceeded && (deps.claimFinalize ? await deps.claimFinalize() : created)

  // Success chat notification (best-effort — never fail an import over a chat hiccup).
  if (deps.notifySuccess && finalize) {
    try {
      await deps.notifySuccess({
        supplierName: doc.supplier?.name,
        entityTypeId,
        entityId,
        created,
        rowCount: rows.length,
        warnings,
        advice
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
  // ⚠ Дело пишется и на НЕУДАЧНОМ импорте (#459) — именно ради него и заводился журнал. Гейт
  // одноразовости при этом сохраняется: на отказе финализация не заявлена, поэтому берём тот же
  // однократный клейм, но по своему условию.
  const writeActivityOnce = finalize || (!importSucceeded && created)
  if (deps.writeActivity && writeActivityOnce) {
    try {
      await deps.writeActivity({ entityTypeId, entityId, companyId, supplierName: doc.supplier?.name, rowCount: rows.length, matchedCount: matchedLines, amountLabel: activityAmountLabel, warnings, advice })
    } catch {
      warnings.push('Документ внесён, но запись в таймлайне создать не удалось. На сам импорт это не влияет — товары в CRM записаны.')
    }
  }

  return { entityTypeId, entityId, created, rowCount: rows.length, idempotent: !!existingId, unmatched: !companyId, warnings, errors, advice }
}

function clampNonNeg(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback
  // 6 dp, NOT kopecks: the header math (lineGross) works on raw document precision, so
  // quantizing the unit price/quantity here diverges the products tab from the header
  // (0.8654 → 0.87 @20% ×10 000 = 10 440 vs 10 384.80). Sub-kopeck unit prices and
  // fractional quantities are normal in this domain; buildProductRow keeps 6 dp too (#302).
  return n < 0 ? 0 : Math.round(n * 1e6) / 1e6
}
