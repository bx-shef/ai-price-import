import { describe, expect, it, vi } from 'vitest'
import { runCrmSync } from '../server/queue/crmSyncCore'
import { defaultMapping } from '../app/utils/portalSettings'
import type { ExtractedDocument } from '../app/types/document'
import type { PortalMapping } from '../app/types/mapping'
import { skippedLinesAdvice } from '../app/utils/importOutcome'

const VAT = [{ id: '1', name: 'Без НДС', rate: null }, { id: '5', name: 'НДС 22%', rate: 22 }]

function mapping(): PortalMapping {
  const m = defaultMapping()
  m.units.dictionary = { шт: 796 }
  m.defaultTarget = { entityTypeId: 2, categoryId: 1 }
  m.product.onMissing = 'freeform'
  return m
}

function baseDeps(over: Partial<Parameters<typeof runCrmSync>[4]> = {}) {
  return {
    findExisting: vi.fn(async () => null as number | null),
    findCompanyByTaxId: vi.fn(async () => 42),
    findProduct: vi.fn(async () => null),
    portalVatRates: vi.fn(async () => VAT),
    createTarget: vi.fn(async () => 555),
    setRows: vi.fn(async () => {}),
    reportErrors: vi.fn(async () => {}),
    ...over
  }
}

const doc: ExtractedDocument = {
  currency: 'BYN',
  priceIncludesVat: true,
  supplier: { name: 'ООО Ромашка', taxId: '190000000' },
  items: [{ name: 'Гвоздь', price: 100, quantity: 2, unit: 'шт', vatRate: 22 }]
}

describe('runCrmSync — happy + supplier/idempotency', () => {
  it('creates target (target+fields incl. job-id marker) + rows', async () => {
    const deps = baseDeps()
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.entityId).toBe(555)
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypeId: 2, categoryId: 1 }),
      // Гвоздь 100×2, НДС включён → opportunity 200, флаг ручной суммы (live-verified).
      // Deal (2) carries the origin marker (originId=jobId + originatorId) for idempotency.
      expect.objectContaining({
        companyId: 42, currencyId: 'BYN', opportunity: 200, isManualOpportunity: 'Y',
        originId: 'job1', originatorId: 'ai-price-import'
      })
    )
    expect(deps.setRows).toHaveBeenCalledWith(2, 555, expect.arrayContaining([
      expect.objectContaining({ taxRate: 22, taxIncluded: 'Y', measureCode: 796, price: 100, quantity: 2 })
    ]))
  })

  it('NEGATIVE vatRate → hard error (not silently «Без НДС»)', async () => {
    // A negative rate is garbage (bad extraction) — it must abort with an error, never be written as
    // a tax-exempt line (regression guard for the 0-rate change).
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, priceIncludesVat: false, items: [{ name: 'x', price: 1, quantity: 1, unit: 'шт', vatRate: -5 }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(deps.createTarget).not.toHaveBeenCalled()
    expect(r.errors.some(e => /отрицательная ставка НДС/i.test(e))).toBe(true)
  })

  it('vatRate 0 → «Без НДС» (taxRate null), NOT a lookup for a 0% portal rate', async () => {
    // The portal has ONLY «Без НДС» (null) + 22% — no explicit «НДС 0%». A 0-rate line must still
    // import (taxRate null), not hard-error «ставка 0% отсутствует».
    const deps = baseDeps()
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: false,
      supplier: { name: 'X', taxId: '190000000' },
      items: [{ name: 'Услуга', price: 100, quantity: 1, unit: 'шт', vatRate: 0 }]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.errors).toHaveLength(0)
    expect(r.created).toBe(true)
    // Флаг зеркалит документ (#347): здесь цены без НДС → 'N', и портал напечатает в «Цене»
    // ровно 100. Ставка null — конвертировать нечего, цена и так валовая.
    expect(deps.setRows).toHaveBeenCalledWith(2, 555, expect.arrayContaining([
      expect.objectContaining({ taxRate: null, taxIncluded: 'N', price: 100, quantity: 1 })
    ]))
  })

  it('reconciles a WRONG priceIncludesVat against the printed total + anchors opportunity to it (deal #37 bug)', async () => {
    // The reported real invoice: net 0.86 × 10000 @20% → «Итого» 8600 → «Всего к оплате» 10320. Even if
    // the model wrongly says prices INCLUDE VAT, the printed total (10320) matches the NET reading →
    // correct the document-level flag to «без НДС», and set opportunity to the paper's 10320 (not 10300
    // that per-unit rounding, nor 8600 that the wrong flag, would give). The WRITTEN row then carries
    // the GROSS unit price 1.032 (#302: the portal reads `price` as gross — net-as-is undershot the
    // row sum by the whole VAT), while the flag follows the CORRECTED document reading (#347).
    const deps = baseDeps({ portalVatRates: vi.fn(async () => [{ id: '1', name: 'Без НДС', rate: null }, { id: '6', name: 'НДС 20%', rate: 20 }]) })
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: true, total: 10320,
      supplier: { name: 'X', taxId: '190000000' },
      items: [{ name: 'Мешок', price: 0.86, quantity: 10000, unit: 'шт', vatRate: 20 }]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ opportunity: 10320, isManualOpportunity: 'Y' }))
    expect(deps.setRows).toHaveBeenCalledWith(2, 555, expect.arrayContaining([
      // Модель сказала «с НДС», но печатный итог это опроверг → флаг документа стал «без НДС»,
      // значит и в карточке показываем нетто-цену 0,86 (taxIncluded 'N') при валовой 1,032.
      expect.objectContaining({ taxIncluded: 'N', price: 1.032, quantity: 10000, taxRate: 20 })
    ]))
    expect(r.warnings.some(w => /уточнили НДС/.test(w))).toBe(true)
  })

  it('DISCOUNT line (negative price) → deal opportunity reflects the discount, not the inflated row-sum', async () => {
    // Товар 100 + скидка −20, оба @20%. Реальный итог = (100−20)×1.2 = 96. Строка скидки в CRM пишется
    // с ценой 0 (B24 не держит отрицательную цену), но opportunity сделки должен быть 96, не 120.
    const deps = baseDeps({ portalVatRates: vi.fn(async () => [{ id: '6', name: 'НДС 20%', rate: 20 }]) })
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: false, total: 96,
      supplier: { name: 'X', taxId: '190000000' },
      items: [
        { name: 'Товар', price: 100, quantity: 1, unit: 'шт', vatRate: 20 },
        { name: 'Скидка', price: -20, quantity: 1, unit: 'шт', vatRate: 20 }
      ]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ opportunity: 96, isManualOpportunity: 'Y' }))
    expect(r.errors).toHaveLength(0)
  })

  // #337: слепая зона, найденная на ревью. Без печатного итога флаг «цены с НДС» подтвердить
  // нечем, а он двигает сумму сделки ровно на ставку налога. Тот же документ С итогом получал
  // предупреждение (totalAmbiguous), а БЕЗ итога уходил молча — при том же объёме знания.
  // Прайс и КП — половина поддерживаемых типов входа, и итога у них часто нет по жанру.
  it('НЕТ печатного итога + НДС в строках → предупреждаем в ОБЕ стороны, флаг не трогаем', async () => {
    const vat = { portalVatRates: vi.fn(async () => [{ id: '6', name: 'НДС 20%', rate: 20 }]) }
    const base = {
      currency: 'BYN' as const,
      supplier: { name: 'X', taxId: '190000000' },
      items: [{ name: 'Товар', price: 100, quantity: 1, unit: 'шт', vatRate: 20 }]
    }
    // Модель сказала «цены с НДС»: сделка = 100 (НДС уже внутри). Если она ошиблась — не хватит 20.
    const incl = baseDeps(vat)
    const rIncl = await runCrmSync('j', { ...base, priceIncludesVat: true } as ExtractedDocument, mapping(), {}, incl)
    expect(rIncl.errors).toHaveLength(0)
    expect(incl.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ opportunity: 100 }))
    expect(rIncl.warnings.some(w => /нет строки «Всего к оплате»/.test(w) && /цены с НДС/.test(w))).toBe(true)

    // И симметрично: «цены без НДС» → 120. Ошибка здесь завышает сделку — предупреждать тоже надо.
    const excl = baseDeps(vat)
    const rExcl = await runCrmSync('j', { ...base, priceIncludesVat: false } as ExtractedDocument, mapping(), {}, excl)
    expect(excl.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ opportunity: 120 }))
    expect(rExcl.warnings.some(w => /нет строки «Всего к оплате»/.test(w) && /цены без НДС/.test(w))).toBe(true)
  })

  // #337 (ревью): «флаг не подтверждён» ≠ «итога нет». Печатный итог, совпавший с суммой строк без
  // НДС, читается как «Итого» и намеренно НЕ якорится — usedStatedTotal остаётся false при живой
  // строке «Всего к оплате» на бумаге. Предупреждение, выводившее причину из !usedStatedTotal,
  // уверенно сообщало оператору, что строки нет, ровно когда он на неё смотрел.
  it('итог НАПЕЧАТАН, но флага не подтверждает → предупреждаем, НЕ утверждая, что итога нет', async () => {
    const deps = baseDeps({ portalVatRates: vi.fn(async () => [{ id: '6', name: 'НДС 20%', rate: 20 }]) })
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: false, total: 100, // = Σ цена×кол: это либо «Итого», либо «Всего к оплате»
      supplier: { name: 'X', taxId: '190000000' },
      items: [{ name: 'Товар', price: 100, quantity: 1, unit: 'шт', vatRate: 20 }]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.errors).toHaveLength(0)
    // Читаем как «Итого» → НДС сверху, сделка 120 (поведение reconcilePricing не меняем).
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ opportunity: 120 }))
    // Предупредить обязаны — но ЛОЖЬ про отсутствие строки недопустима.
    expect(r.warnings.some(w => /нет строки «Всего к оплате»/.test(w))).toBe(false)
    expect(r.warnings.some(w => /совпал с суммой строк без НДС/.test(w) && /цены без НДС/.test(w))).toBe(true)
  })

  it('НЕТ итога, но и НДС нет → предупреждения быть не должно (флаг ни на что не влияет)', async () => {
    const deps = baseDeps({ portalVatRates: vi.fn(async () => [{ id: '1', name: 'Без НДС', rate: null }]) })
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: true,
      supplier: { name: 'X', taxId: '190000000' },
      items: [{ name: 'Услуга', price: 100, quantity: 1, unit: 'шт', vatRate: 0 }]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.warnings.some(w => /нет строки «Всего к оплате»/.test(w))).toBe(false)
  })

  it('печатный итог ПОДТВЕРДИЛ флаг → нового предупреждения нет (не дублируем шум)', async () => {
    const deps = baseDeps({ portalVatRates: vi.fn(async () => [{ id: '6', name: 'НДС 20%', rate: 20 }]) })
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: false, total: 120, // 100 нетто @20% → 120: однозначно
      supplier: { name: 'X', taxId: '190000000' },
      items: [{ name: 'Товар', price: 100, quantity: 1, unit: 'шт', vatRate: 20 }]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.warnings.some(w => /нет строки «Всего к оплате»/.test(w))).toBe(false)
  })

  it('printed total matches NEITHER interpretation → warns with the NUMBERS, still creates (opportunity from lines)', async () => {
    const deps = baseDeps({ portalVatRates: vi.fn(async () => [{ id: '6', name: 'НДС 20%', rate: 20 }]) })
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: false, total: 99999, // wildly off both net (120) and incl (100)
      supplier: { name: 'X', taxId: '190000000' },
      items: [{ name: 'Товар', price: 100, quantity: 1, unit: 'шт', vatRate: 20 }]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.errors).toHaveLength(0)
    // #336: the warning must carry printed / computed / difference — the bare fact of a mismatch
    // is unusable on a 44-line document. Difference here: |120 − 99 999| = 99 879.
    // Числа пинятся ВМЕСТЕ С ПОДПИСЯМИ: набор из трёх `toContain` переживал перестановку
    // «напечатано» и «посчитано» местами, а такой текст говорит оператору ровно обратное.
    const w = r.warnings.find(x => /^Итог документа —/.test(x))!
    expect(w).toMatch(/Итог документа — 99 999,00 BYN/)
    expect(w).toMatch(/по строкам вышло 120,00 BYN/)
    expect(w).toMatch(/разница 99 879,00 BYN/)
    // NOT anchored to the bogus 99999 — opportunity computed from the lines (net-priced gross = 120).
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ opportunity: 120 }))
  })

  it('skip-warn drops the discount line → opportunity inflates to 120 BUT warns «не совпадает с итогом»', async () => {
    // Known interaction (the pricing comment warns of it): with skip-warn, an unmatched discount line is
    // SKIPPED, so allLinesWritten=false → opportunity = sum of written rows (120), losing the −20 discount.
    // The deal amount is then wrong vs the paper (96) — so we MUST surface the explicit partial-write warning.
    const m = mapping()
    m.product.onMissing = 'skip-warn'
    const findProduct = vi.fn(async (it: { name: string }) => (it.name === 'Скидка' ? null : 777))
    const deps = baseDeps({ portalVatRates: vi.fn(async () => [{ id: '6', name: 'НДС 20%', rate: 20 }]), findProduct })
    const d: ExtractedDocument = {
      currency: 'BYN', priceIncludesVat: false, total: 96,
      supplier: { name: 'X', taxId: '190000000' },
      items: [
        { name: 'Товар', price: 100, quantity: 1, unit: 'шт', vatRate: 20 },
        { name: 'Скидка', price: -20, quantity: 1, unit: 'шт', vatRate: 20 }
      ]
    }
    const r = await runCrmSync('j', d, m, {}, deps)
    expect(r.rowCount).toBe(1) // discount line skipped
    expect(r.warnings.some(w => /сумма записи меньше итога/i.test(w))).toBe(true)
    // Число, а не только текст предупреждения: это ЕДИНСТВЕННЫЙ тест файла, доходящий до
    // computeOpportunity (частичная запись), и без этой строки денежная регрессия #347 —
    // возврат к добавлению НДС по флагу — оставила бы весь файл зелёным (проверено мутацией:
    // сумма стала бы 144 вместо 120, а падений не было бы ни одного).
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ opportunity: 120 }))
  })

  it('searches B24 for the job marker BEFORE creating (deal → filter on originId+originatorId)', async () => {
    const deps = baseDeps()
    await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(deps.findExisting).toHaveBeenCalledWith(2, { '=originId': 'job1', '=originatorId': 'ai-price-import' })
  })

  it('smart-invoice target → xmlId marker + xmlId search filter', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 31 }
    const deps = baseDeps()
    await runCrmSync('job1', doc, m, {}, deps)
    expect(deps.findExisting).toHaveBeenCalledWith(31, { '=xmlId': 'ai-price-import:job1' })
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypeId: 31 }),
      expect.objectContaining({ xmlId: 'ai-price-import:job1' })
    )
  })

  it('lead target on a NO-LEADS portal → redirected to a deal + warning', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 1 } // lead
    const deps = baseDeps({ leadsEnabled: vi.fn(async () => false) })
    const r = await runCrmSync('job1', doc, m, {}, deps)
    // Created as a DEAL (2), not a lead (1); marker/filter use the deal.
    expect(deps.createTarget).toHaveBeenCalledWith(expect.objectContaining({ entityTypeId: 2 }), expect.any(Object))
    expect(deps.findExisting).toHaveBeenCalledWith(2, expect.any(Object))
    expect(r.warnings.some(w => /отключены лиды/.test(w))).toBe(true)
  })

  it('lead target with leads ENABLED (classic) stays a lead', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 1 }
    const deps = baseDeps({ leadsEnabled: vi.fn(async () => true) })
    await runCrmSync('job1', doc, m, {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.objectContaining({ entityTypeId: 1 }), expect.any(Object))
  })

  it('lead target when leadsEnabled dep is ABSENT → no redirect (guard off)', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 1 }
    const deps = baseDeps() // no leadsEnabled wired → the `deps.leadsEnabled &&` guard skips the check
    await runCrmSync('job1', doc, m, {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.objectContaining({ entityTypeId: 1 }), expect.any(Object))
  })

  it('originatorPrefix overrides the marker/filter originator', async () => {
    const deps = baseDeps({ originatorPrefix: 'acme' })
    await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(deps.findExisting).toHaveBeenCalledWith(2, { '=originId': 'job1', '=originatorId': 'acme' })
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ originatorId: 'acme' }))
  })

  it('markerless target (no idempotency field, e.g. quote/7) → hard error, NO create, NO search', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 7 } // quote — no originId/xmlId → not a supported target
    const reportErrors = vi.fn(async () => {})
    const deps = baseDeps({ reportErrors })
    const r = await runCrmSync('job1', doc, m, {}, deps)
    expect(r.created).toBe(false)
    expect(r.errors.some(e => /вносить нельзя/.test(e))).toBe(true)
    expect(deps.findExisting).not.toHaveBeenCalled()
    expect(deps.createTarget).not.toHaveBeenCalled()
    expect(reportErrors).toHaveBeenCalled()
  })

  it('calls notifySuccess with a summary on success', async () => {
    const notifySuccess = vi.fn(async () => {})
    const deps = baseDeps({ notifySuccess })
    await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(notifySuccess).toHaveBeenCalledWith(expect.objectContaining({
      supplierName: 'ООО Ромашка', entityTypeId: 2, entityId: 555, created: true, rowCount: 1
    }))
  })

  it('a failing notifySuccess adds a warning but does not fail the import', async () => {
    const notifySuccess = vi.fn(() => Promise.reject(new Error('chat down')))
    const deps = baseDeps({ notifySuccess })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.warnings.some(w => /сообщение в чат отправить не удалось/.test(w))).toBe(true)
  })

  it('writeActivity records a configurable дело on the created entity', async () => {
    const writeActivity = vi.fn(async () => {})
    await runCrmSync('job1', doc, mapping(), {}, baseDeps({ writeActivity }))
    // У общей заготовки `doc` НДС в строках и НЕТ печатного итога, поэтому с #337 она честно
    // несёт предупреждение «подтвердить флаг нечем» — раньше этот случай уходил молча.
    expect(writeActivity).toHaveBeenCalledWith({
      entityTypeId: 2, entityId: 555, companyId: 42, supplierName: 'ООО Ромашка', rowCount: 1,
      warnings: [expect.stringMatching(/нет строки «Всего к оплате»/)]
    })
  })

  it('passes import PROBLEMS (warnings) to writeActivity so they land on the timeline дело', async () => {
    const writeActivity = vi.fn(async () => {})
    // Supplier not found → a warning is accumulated; it must be forwarded to the дело.
    const deps = baseDeps({ writeActivity, findCompanyByTaxId: vi.fn(async () => null) })
    await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(writeActivity).toHaveBeenCalledWith(expect.objectContaining({
      warnings: expect.arrayContaining([expect.stringMatching(/Поставщик не найден в CRM по /)])
    }))
  })

  it('does NOT write a дело on an idempotent resume (already-processed job)', async () => {
    const writeActivity = vi.fn(async () => {})
    const deps = baseDeps({ writeActivity, findExisting: vi.fn(async () => 900 as number | null) })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.idempotent).toBe(true)
    expect(writeActivity).not.toHaveBeenCalled()
  })

  it('a failing writeActivity adds a warning but does not fail the import', async () => {
    const writeActivity = vi.fn(() => Promise.reject(new Error('timeline down')))
    const r = await runCrmSync('job1', doc, mapping(), {}, baseDeps({ writeActivity }))
    expect(r.created).toBe(true)
    expect(r.warnings.some(w => /запись в таймлайне создать не удалось/.test(w))).toBe(true)
  })

  it('writeActivity rowCount is WRITTEN rows, not document item count (skip-warn divergence)', async () => {
    const writeActivity = vi.fn(async () => {})
    const m = mapping()
    m.product.onMissing = 'skip-warn'
    const twoItems: ExtractedDocument = { ...doc, items: [
      { name: 'A', price: 10, quantity: 1, unit: 'шт', vatRate: 22 },
      { name: 'B', price: 20, quantity: 1, unit: 'шт', vatRate: 22 }
    ] }
    // Only A matches → B is skip-warned → 1 row written though the doc has 2 items.
    const findProduct = vi.fn(async (it: ExtractedDocument['items'][number]) => it.name === 'A' ? 111 : null)
    await runCrmSync('job1', twoItems, m, {}, baseDeps({ writeActivity, findProduct }))
    expect(writeActivity).toHaveBeenCalledWith(expect.objectContaining({ rowCount: 1 }))
  })

  it('idempotent resume → does NOT re-notify (created=false path stays silent)', async () => {
    const notifySuccess = vi.fn(async () => {})
    const deps = baseDeps({ findExisting: vi.fn(async () => 999 as number | null), notifySuccess })
    await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(notifySuccess).not.toHaveBeenCalled()
  })

  it('idempotent: existing entity → no create, but resumes setRows', async () => {
    const deps = baseDeps({ findExisting: vi.fn(async () => 999 as number | null) })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r).toMatchObject({ created: false, entityId: 999 })
    expect(deps.createTarget).not.toHaveBeenCalled()
    expect(deps.setRows).toHaveBeenCalledWith(2, 999, expect.any(Array))
  })

  // #164 — the one-time finalize claim overrides the `created` gate so a retry resuming after a
  // post-create failure (setRows threw on attempt 1) still delivers the chat + timeline дело.
  it('claimFinalize wins on a RESUME (created=false) → notify + activity STILL fire (#164 fix)', async () => {
    const notifySuccess = vi.fn(async () => {})
    const writeActivity = vi.fn(async () => {})
    const claimFinalize = vi.fn(async () => true) // this run wins the claim
    const deps = baseDeps({
      findExisting: vi.fn(async () => 900 as number | null), // resume: entity already created
      notifySuccess, writeActivity, claimFinalize
    })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(false) // it was a resume…
    expect(claimFinalize).toHaveBeenCalledTimes(1)
    expect(notifySuccess).toHaveBeenCalledTimes(1) // …but the notice is no longer lost
    // Payload on the resume path: the entity is the found one (900), created reflects the resume.
    expect(notifySuccess).toHaveBeenCalledWith(expect.objectContaining({ entityId: 900, created: false, rowCount: 1 }))
    expect(writeActivity).toHaveBeenCalledTimes(1)
  })

  it('claimFinalize already taken (false) → skip both EVEN when created=true (no double post)', async () => {
    const notifySuccess = vi.fn(async () => {})
    const writeActivity = vi.fn(async () => {})
    const claimFinalize = vi.fn(async () => false) // a prior run already finalized
    const deps = baseDeps({ notifySuccess, writeActivity, claimFinalize })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(claimFinalize).toHaveBeenCalledTimes(1)
    expect(notifySuccess).not.toHaveBeenCalled()
    expect(writeActivity).not.toHaveBeenCalled()
  })

  it('does NOT claim on a hard-error abort (no create/setRows → no spurious claim)', async () => {
    const claimFinalize = vi.fn(async () => true)
    // VAT 25 is not in the portal → hard error → abort before create/setRows.
    const bad: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'шт', vatRate: 25 }] }
    const deps = baseDeps({ claimFinalize })
    const r = await runCrmSync('job1', bad, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(claimFinalize).not.toHaveBeenCalled() // nothing was created → nothing to finalize
  })

  it('claims AFTER setRows: a throwing setRows propagates and does NOT consume the claim (#164)', async () => {
    // The exact regression scenario: create succeeds, then setRows throws on the first attempt.
    // The claim must NOT be taken (it sits after setRows), so the retry can still finalize.
    const claimFinalize = vi.fn(async () => true)
    const notifySuccess = vi.fn(async () => {})
    const deps = baseDeps({
      setRows: vi.fn(() => Promise.reject(new Error('productrow.set down'))),
      claimFinalize, notifySuccess
    })
    await expect(runCrmSync('job1', doc, mapping(), {}, deps)).rejects.toThrow('productrow.set down')
    expect(deps.createTarget).toHaveBeenCalledTimes(1) // entity was created…
    expect(claimFinalize).not.toHaveBeenCalled() // …but the claim is untouched → retry can finalize
    expect(notifySuccess).not.toHaveBeenCalled()
  })

  // #135 — lead target: contractor nuance (found → companyId / not found → companyTitle).
  it('lead target, supplier FOUND → companyId set, NO companyTitle, opportunity+marker', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 1 } // lead
    const deps = baseDeps() // findCompanyByTaxId → 42
    await runCrmSync('job1', doc, m, {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypeId: 1 }),
      expect.objectContaining({
        companyId: 42,
        // lead is money-bearing (#135) → explicit total, like a deal
        opportunity: 200, isManualOpportunity: 'Y', currencyId: 'BYN',
        originId: 'job1', originatorId: 'ai-price-import'
      })
    )
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.not.objectContaining({ companyTitle: expect.anything() }))
    // marker search runs on the lead type (entityTypeId 1 → origin strategy)
    expect(deps.findExisting).toHaveBeenCalledWith(1, { '=originId': 'job1', '=originatorId': 'ai-price-import' })
    // product rows written with the lead ownerType (entityTypeId 1 → 'L' resolved in setRows)
    expect(deps.setRows).toHaveBeenCalledWith(1, 555, expect.any(Array))
  })

  it('lead target, supplier NOT found AND no supplier name → no companyTitle, no crash', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 1 }
    const noName: ExtractedDocument = { ...doc, supplier: undefined }
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
    const r = await runCrmSync('job1', noName, m, {}, deps)
    expect(r.created).toBe(true)
    // no supplier.name ⇒ companyTitle omitted entirely (never companyTitle:undefined)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.not.objectContaining({ companyTitle: expect.anything() }))
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.not.objectContaining({ companyId: expect.anything() }))
  })

  it('lead target, supplier NOT found → companyTitle from document, NO companyId (#135 fix)', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 1 } // lead
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
    const r = await runCrmSync('job1', doc, m, {}, deps)
    expect(r.created).toBe(true)
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypeId: 1 }),
      expect.objectContaining({ companyTitle: 'ООО Ромашка' }) // raw lead carries the name
    )
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.not.objectContaining({ companyId: expect.anything() }))
  })

  it('NON-lead target (deal), supplier NOT found → NO companyTitle (unchanged behaviour)', async () => {
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) }) // default target = deal (2)
    await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.not.objectContaining({ companyTitle: expect.anything() }))
  })

  it('deleted funnel: default target pins a gone direction → falls back to deal/направление-0', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 2, categoryId: 5 } // funnel 5 was DELETED in CRM
    // portal now has deal funnels 0 and 3 only (5 is gone)
    const deps = baseDeps({ listCategoryIds: vi.fn(async () => [0, 3]) })
    const r = await runCrmSync('job1', doc, m, {}, deps)
    // create lands on the hard anchor: deal, direction 0
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypeId: 2, categoryId: 0 }),
      expect.any(Object)
    )
    // the redirect is surfaced, not silent
    expect(r.warnings.some(w => /Воронка, выбранная для импорта, удалена/i.test(w))).toBe(true)
  })

  it('validation is SKIPPED when listCategoryIds dep is absent (backward-compat)', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 2, categoryId: 5 } // would be "gone" but no validation wired
    const deps = baseDeps() // no listCategoryIds
    const r = await runCrmSync('job1', doc, m, {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.objectContaining({ entityTypeId: 2, categoryId: 5 }), expect.any(Object))
    expect(r.warnings.some(w => /Воронка, выбранная для импорта, удалена/i.test(w))).toBe(false)
  })

  it('deleted funnel: rule direction gone → falls back to the (valid) default target', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 2, categoryId: 3 } // valid
    m.routingRules = [{ match: { type: 'счёт' }, target: { entityTypeId: 2, categoryId: 5 } }] // funnel 5 gone
    const deps = baseDeps({ listCategoryIds: vi.fn(async () => [0, 3]) })
    await runCrmSync('job1', { ...doc, documentType: 'счёт' } as typeof doc, m, { documentType: 'счёт' }, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypeId: 2, categoryId: 3 }), // the default, not the gone rule dir
      expect.any(Object)
    )
  })

  it('valid direction is untouched (no needless fallback)', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 2, categoryId: 3 }
    const deps = baseDeps({ listCategoryIds: vi.fn(async () => [0, 3]) })
    await runCrmSync('job1', doc, m, {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.objectContaining({ entityTypeId: 2, categoryId: 3 }), expect.any(Object))
  })

  it('supplier not found → still creates, warning, no companyId', async () => {
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.warnings.some(w => /Поставщик не найден в CRM по /.test(w))).toBe(true)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.not.objectContaining({ companyId: expect.anything() }))
  })

  it('#264: номер есть, компании нет → в предупреждении печатается сам номер с его меткой', async () => {
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
    const d: ExtractedDocument = { ...doc, supplier: { name: 'ООО Ромашка', taxId: '191234567', taxIdKind: 'UNP' } }
    const r = await runCrmSync('job1', d, mapping(), {}, deps)
    const w = r.warnings.find(x => /Поставщик не найден/.test(x))!
    expect(w).toContain('по УНП 191234567')
    expect(w).not.toContain('УНП/ИНН') // перечисление аббревиатур ушло
  })

  it('#264: номера в документе нет → другое сообщение, без совета заводить компанию', async () => {
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
    const d: ExtractedDocument = { ...doc, supplier: { name: 'ООО Ромашка' } }
    const r = await runCrmSync('job1', d, mapping(), {}, deps)
    const w = r.warnings.find(x => /налоговый номер/.test(x))!
    expect(w).toContain('не распознан налоговый номер')
    expect(w).not.toContain('Заведите компанию')
    expect(deps.findCompanyByTaxId).not.toHaveBeenCalled() // искать было не по чему
  })

  it('no supplier.taxId → no lookup; net doc → gross price, flag mirrors the document (#302/#347)', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, priceIncludesVat: false, supplier: { name: 'X' } }
    await runCrmSync('j', d, mapping(), {}, deps)
    expect(deps.findCompanyByTaxId).not.toHaveBeenCalled()
    const row = (deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]!
    expect(row.taxIncluded).toBe('N') // документ печатает цены без НДС → карточка покажет 100
    expect(row.price).toBe(122) // 100 net @22% → gross; the portal reads `price` as gross
  })
})

describe('runCrmSync — hard errors abort (no partial entity, no line loss)', () => {
  it('VAT rate not in portal → error to chat, NOT created', async () => {
    const deps = baseDeps()
    const bad: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'шт', vatRate: 25 }] }
    const r = await runCrmSync('j', bad, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(r.errors.some(e => /25%/.test(e))).toBe(true)
    // reportErrors receives the supplier name (BB-safe chat context) …
    expect(deps.reportErrors).toHaveBeenCalledWith(expect.any(Array), 'ООО Ромашка')
    expect(deps.createTarget).not.toHaveBeenCalled()
  })

  it('hard error → notifySuccess is NOT called (no false success chat)', async () => {
    const notifySuccess = vi.fn(async () => {})
    const deps = baseDeps({ notifySuccess })
    const bad: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'шт', vatRate: 25 }] }
    await runCrmSync('j', bad, mapping(), {}, deps)
    expect(notifySuccess).not.toHaveBeenCalled()
  })

  it('vatRate 0 → «Без НДС» (taxRate null), NOT a hard error even when the portal has no 0% rate', async () => {
    // Reversed from the old behaviour (#owner): a 0-rate line is tax-exempt (B24 «Без НДС» flag), so it
    // imports with taxRate null instead of failing «ставка 0% отсутствует в портале».
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, priceIncludesVat: false, items: [{ name: 'x', price: 1, quantity: 1, unit: 'шт', vatRate: 0 }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.errors).toHaveLength(0)
    expect(deps.setRows).toHaveBeenCalledWith(2, 555, expect.arrayContaining([
      expect.objectContaining({ taxRate: null })
    ]))
  })

  it('VAT present but priceIncludesVat undefined → hard error (total would flip)', async () => {
    const deps = baseDeps()
    const { priceIncludesVat, ...rest } = doc // omit the inclusion flag
    void priceIncludesVat
    const r = await runCrmSync('j', rest as ExtractedDocument, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(r.errors.some(e => /не понять, включён НДС/.test(e))).toBe(true)
    expect(deps.createTarget).not.toHaveBeenCalled()
  })

  it('no VAT anywhere + priceIncludesVat undefined → OK (flag irrelevant)', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { currency: 'BYN', supplier: { name: 'X' }, items: [{ name: 'a', price: 10, quantity: 1, unit: 'шт' }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('currency not in portal → error, NOT created', async () => {
    const deps = baseDeps({ portalCurrencies: vi.fn(async () => ['BYN']) })
    const r = await runCrmSync('j', { ...doc, currency: 'USD' }, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(r.errors.some(e => /USD/.test(e))).toBe(true)
  })

  it('mixed items with one bad-VAT → whole doc aborts (no line loss, NO orphan catalog writes)', async () => {
    // The good line ('a') comes BEFORE the bad-VAT line ('b'). Pre-pass must catch the error and
    // abort before the write loop, so 'a' never writes an orphan measure to the catalog.
    const m = mapping()
    m.product.onMissing = 'freeform' // 'a' would be a free-form row → would resolve/create a measure
    m.units.autoCreate = true
    const createMeasure = vi.fn(async () => ({ code: 1001, created: true }))
    const deps = baseDeps({ createMeasure })
    const d: ExtractedDocument = {
      ...doc,
      items: [
        { name: 'a', price: 1, quantity: 1, unit: 'бухта', vatRate: 22 }, // valid, would create a measure
        { name: 'b', price: 2, quantity: 1, unit: 'шт', vatRate: 25 } // unknown rate → hard error
      ]
    }
    const r = await runCrmSync('j', d, m, {}, deps)
    expect(r.created).toBe(false)
    expect(deps.createTarget).not.toHaveBeenCalled()
    expect(createMeasure).not.toHaveBeenCalled() // no orphan measure from line 'a'
  })
})

describe('runCrmSync — products / units / routing', () => {
  it('found product → productId on row; freeform omits it', async () => {
    const withProd = baseDeps({ findProduct: vi.fn(async () => 777) })
    await runCrmSync('j', doc, mapping(), {}, withProd)
    expect((withProd.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ productId: 777 })
    const freeform = baseDeps()
    await runCrmSync('j', doc, mapping(), {}, freeform)
    expect((freeform.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('productId')
  })

  it('skip-warn: product not found → row skipped, setRows not called', async () => {
    const m = mapping()
    m.product.onMissing = 'skip-warn'
    const deps = baseDeps()
    const r = await runCrmSync('j', doc, m, {}, deps)
    expect(r.warnings.some(w => /пропущена/.test(w))).toBe(true)
    expect(deps.setRows).not.toHaveBeenCalled()
  })

  // #373. Живой прогон дал пять сделок с суммой 0, без строк и с зелёным «Готово»: каталог портала
  // был пуст, а «Если товар не найден» стояло в «пропустить» — то есть пропускалось ВСЁ.
  describe('#373: пропущены ВСЕ строки — отдельный исход, а не успех', () => {
    const twoItems: ExtractedDocument = {
      ...doc,
      items: [
        { name: 'Гвоздь', price: 100, quantity: 2, unit: 'шт', vatRate: 22 },
        { name: 'Шуруп', price: 50, quantity: 1, unit: 'шт', vatRate: 22 }
      ]
    }

    it('запись в CRM не создаётся вовсе', async () => {
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps() // findProduct → null для обеих позиций
      const r = await runCrmSync('j', twoItems, m, {}, deps)
      expect(r.created).toBe(false)
      expect(r.entityId).toBe(0)
      expect(r.rowCount).toBe(0)
      expect(deps.createTarget).not.toHaveBeenCalled()
      expect(deps.setRows).not.toHaveBeenCalled()
    })

    it('документ ИЗ ОДНОЙ строки — тот же исход', async () => {
      // Замечание ревью: все остальные проверки блока идут на двух позициях, и мутация
      // `doc.items.length > 0` → `> 1` их не роняла — то есть #373 оставался целиком живым для
      // однострочных документов, а они в этом домене обычны.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps()
      const r = await runCrmSync('j', doc, m, {}, deps)
      expect(r.created).toBe(false)
      expect(deps.createTarget).not.toHaveBeenCalled()
      expect(r.errors.length).toBeGreaterThan(0)
    })

    it('текст несёт настоящее число позиций документа', async () => {
      // Шов между чистой функцией и вызовом: `allLinesSkippedError(0)` или `rows.length` (всегда 0)
      // прошли бы и тест функции, и regex на «Импорт остановлен» — а человек прочёл бы «ни одна из
      // 0 позиций».
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const three: ExtractedDocument = { ...doc, items: [
        { name: 'a', price: 1, quantity: 1, unit: 'шт', vatRate: null },
        { name: 'b', price: 2, quantity: 1, unit: 'шт', vatRate: null },
        { name: 'c', price: 3, quantity: 1, unit: 'шт', vatRate: null }
      ] }
      const r = await runCrmSync('j', three, m, {}, baseDeps())
      expect(r.errors[0]).toContain('ни одна из 3 позиций')
    })

    it('текст говорит «запись не создана», а не «часть строк пропущена»', async () => {
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const r = await runCrmSync('j', twoItems, m, {}, baseDeps())
      expect(r.errors.some(e => /запись в CRM не создана/i.test(e))).toBe(true)
      // Прежний текст про «часть строк» тут — прямая неправда: пропущена не часть, а всё.
      expect(r.errors.concat(r.warnings).some(t => /Часть строк пропущена/i.test(t))).toBe(false)
    })

    it('тип сущности в результате сохранён — по нему строится ссылка в интерфейсе', async () => {
      const m = mapping() // defaultTarget entityTypeId 2
      m.product.onMissing = 'skip-warn'
      const r = await runCrmSync('j', twoItems, m, {}, baseDeps())
      expect(r.entityTypeId).toBe(2)
    })

    it('поставщик не найден — счётчик unmatched это по-прежнему видит', async () => {
      // Обнулять его на самом провальном классе документов значит занижать счётчик ровно там, где
      // он и заведён показывать проблему.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
      const r = await runCrmSync('j', twoItems, m, {}, deps)
      expect(r.unmatched).toBe(true)
    })

    it('повтор задания, которое УЖЕ создало запись, не объявляется провалом', async () => {
      // Первая попытка создала сущность со строками и умерла до записи статуса; к повтору каталог
      // изменился и строки перестали подбираться. Гард ДО поиска маркера сказал бы «запись в CRM не
      // создана» про живую сделку, перевёл бы завершённое задание в «Ошибка» и потерял бы защиту от
      // дубля при повторной загрузке.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps({ findExisting: vi.fn(async () => 777) })
      const r = await runCrmSync('j', twoItems, m, {}, deps)
      expect(r.errors).toEqual([])
      expect(r.idempotent).toBe(true)
      expect(r.entityId).toBe(777)
      expect(deps.reportErrors).not.toHaveBeenCalled()
    })

    it('сообщение уходит в чат ошибок — молчать нельзя', async () => {
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps()
      await runCrmSync('j', twoItems, m, {}, deps)
      expect(deps.reportErrors).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringMatching(/не найдена в каталоге, запись в CRM не создана/i)]),
        'ООО Ромашка'
      )
    })

    it('дело на таймлайне не пишется — сущности, к которой его привязать, нет', async () => {
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const writeActivity = vi.fn(async () => {})
      await runCrmSync('j', twoItems, m, {}, baseDeps({ writeActivity }))
      expect(writeActivity).not.toHaveBeenCalled()
    })

    it('совет «что делать» звучит РОВНО ОДИН раз и стоит ПЕРВЫМ', async () => {
      // Живой прогон 2026-08-02: совет висел на каждой построчной строке, и карточка документа из
      // трёх позиций несла его четыре раза подряд. Названия товаров в повторах тонули.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps({ findProduct: vi.fn(async (it: { name: string }) => it.name === 'Гвоздь' ? 7 : null) })
      const r = await runCrmSync('j', twoItems, m, {}, deps)
      // ⚠ Сверяем с САМИМ текстом, а не с подстрокой названия пункта настроек: подстрока есть и в
      // тексте жёсткого отказа, и мутация «поставить сюда текст отказа» проходила незамеченной —
      // импорт, который создал сделку, сообщал бы «запись в CRM не создана».
      expect(r.warnings.filter(w => w === skippedLinesAdvice())).toHaveLength(1)
      expect(r.warnings.some(w => /не создана|остановлен/i.test(w))).toBe(false)
      // ⚠ ПЕРВЫМ: потребители режут список с начала (дело — по шести, чат — по десяти), и совет
      // в хвосте отрезался бы тем вернее, чем больше строк пропущено.
      expect(r.warnings[0]).toBe(skippedLinesAdvice())
      // Названия пропущенных товаров при этом на месте — блок существует ради них.
      expect(r.warnings.some(w => w.includes('Шуруп'))).toBe(true)
    })

    it('совет доезжает даже когда пропущенных строк больше, чем влезает в дело', async () => {
      // Дело в таймлайне печатает первые шесть предупреждений. Совет в хвосте не попадал бы туда
      // ровно на документах, где он нужнее всего.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const many: ExtractedDocument = { ...doc, items: [
        ...Array.from({ length: 8 }, (_, i) => ({ name: `Товар ${i}`, price: 10, quantity: 1, unit: 'шт', vatRate: null })),
        { name: 'Гвоздь', price: 10, quantity: 1, unit: 'шт', vatRate: null }
      ] }
      const deps = baseDeps({ findProduct: vi.fn(async (it: { name: string }) => it.name === 'Гвоздь' ? 7 : null) })
      const r = await runCrmSync('j', many, m, {}, deps)
      expect(r.warnings.slice(0, 6)).toContain(skippedLinesAdvice())
    })

    it('повтор задания, где ВСЕ строки теперь пропускаются, тоже несёт совет', async () => {
      // Дыра, найденная разбором: первая попытка создала запись, к ретраю каталог изменился и
      // строки перестали подбираться. До отказа не доходит (маркер найден), а прежнее условие
      // `rows.length > 0` совет не выдавало — человек оставался с перечнем «не найден» и без него.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const r = await runCrmSync('j', twoItems, m, {}, baseDeps({ findExisting: vi.fn(async () => 777) }))
      expect(r.idempotent).toBe(true)
      expect(r.warnings[0]).toBe(skippedLinesAdvice())
    })

    it('пропущено ВСЁ — совет только в отказе, в предупреждениях его нет', async () => {
      // Иначе вернулась бы та же простыня: красная строка с советом плюс он же под каждым товаром.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const r = await runCrmSync('j', twoItems, m, {}, baseDeps())
      expect(r.errors[0]).toContain('Внести строку как есть')
      expect(r.warnings.filter(w => w.includes('Внести строку как есть'))).toEqual([])
      expect(r.warnings.some(w => w.includes('Гвоздь'))).toBe(true)
    })

    it('пропущена ЧАСТЬ строк — импорт по-прежнему проходит', async () => {
      // Граница исхода: убери из гарда `rows.length === 0`, и этот случай тоже начнёт падать.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps({ findProduct: vi.fn(async (it: { name: string }) => it.name === 'Гвоздь' ? 7 : null) })
      const r = await runCrmSync('j', twoItems, m, {}, deps)
      expect(r.created).toBe(true)
      expect(r.rowCount).toBe(1)
      expect(r.errors).toEqual([])
    })

    it('в документе НЕТ позиций вовсе — это другой случай, ошибку не выдумываем', async () => {
      // Граница с другой стороны: `doc.items.length > 0` в гарде. ⚠ Сегодня недостижимо —
      // `validateExtractedDocument` отвергает документ без позиций ещё в извлечении. Гард и тест
      // остаются страховкой: без них текст «ни одна из 0 позиций» и сам отказ появились бы у
      // документа, который ничего не пропускал.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const deps = baseDeps()
      const r = await runCrmSync('j', { ...doc, items: [] }, m, {}, deps)
      expect(r.errors.some(e => /не найдена в каталоге/i.test(e))).toBe(false)
      expect(r.created).toBe(true)
    })

    it('дело на таймлайне при ЧАСТИЧНОМ пропуске по-прежнему пишется', async () => {
      // Пара к проверке «на полном пропуске дела нет»: без неё мутация «не писать дело, если
      // пропущена хоть одна строка» прошла бы весь блок.
      const m = mapping()
      m.product.onMissing = 'skip-warn'
      const writeActivity = vi.fn(async () => {})
      await runCrmSync('j', twoItems, m, {}, baseDeps({
        writeActivity,
        findProduct: vi.fn(async (it: { name: string }) => it.name === 'Гвоздь' ? 7 : null)
      }))
      expect(writeActivity).toHaveBeenCalled()
    })

    it('сумма 0 сама по себе не повод отказать — отказ про ОТСУТСТВИЕ строк', async () => {
      // Различение, которое проводит #373: «пустая запись» и «запись на ноль» — не одно и то же.
      // Документ с нулевыми ценами импортируется как обычно.
      const m = mapping()
      const zero: ExtractedDocument = { ...doc, items: [{ name: 'Гвоздь', price: 0, quantity: 1, unit: 'шт', vatRate: null }] }
      const r = await runCrmSync('j', zero, m, {}, baseDeps())
      expect(r.created).toBe(true)
      expect(r.rowCount).toBe(1)
      expect(r.errors).toEqual([])
    })

    it('дефолт портала до этого исхода не доводит', async () => {
      // Смысл второго пункта #373: у нетронутого портала ненайденный товар становится произвольной
      // позицией, поэтому «пропустить всё» вообще не может случиться без явной настройки.
      const r = await runCrmSync('j', twoItems, defaultMapping(), {}, baseDeps())
      expect(r.created).toBe(true)
      expect(r.rowCount).toBe(2)
    })
  })

  it('freeform: product not found → row written WITHOUT productId (free-form position)', async () => {
    const m = mapping()
    m.product.onMissing = 'freeform'
    const deps = baseDeps() // default findProduct → null
    await runCrmSync('j', doc, m, {}, deps)
    expect(deps.setRows).toHaveBeenCalled()
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('productId')
  })

  it('unit not mapped → WARNING (not error), still creates with default measure', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'бухта', vatRate: null }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.warnings.some(w => /бухта/.test(w))).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('#272: встроенный код НЕ пишется, если такой меры нет в каталоге портала', async () => {
    // Свежий портал везёт всего несколько мер. Раньше сюда уходил бы 736 («Рулон»), которого в
    // каталоге нет, — в карточке молча оказалась бы неверная единица.
    const measureCatalog = vi.fn(async () => ({ hasCode: (c: number) => c === 796, byName: () => null }))
    const deps = baseDeps({ measureCatalog })
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'рулон', vatRate: null }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: 796 })
    expect(r.warnings.some(w => /рулон/.test(w) && /не распознана/.test(w))).toBe(true)
  })

  it('#272: встроенный код пишется, когда мера в каталоге портала есть, и без предупреждения', async () => {
    const measureCatalog = vi.fn(async () => ({ hasCode: () => true, byName: () => null }))
    const deps = baseDeps({ measureCatalog })
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'кг', vatRate: null }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: 166 })
    expect(r.warnings.some(w => /кг/.test(w))).toBe(false)
    expect(deps.createMeasure).toBeUndefined() // сопоставленная единица не идёт в авто-создание
  })

  it('#272: собственная мера портала выигрывает у встроенной', async () => {
    const measureCatalog = vi.fn(async () => ({ hasCode: () => true, byName: () => 1005 }))
    const deps = baseDeps({ measureCatalog })
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'рулон', vatRate: null }] }
    await runCrmSync('j', d, mapping(), {}, deps)
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: 1005 })
  })

  it('#272: каталог не прочитался → пишем встроенный код, это ближе к правде, чем «шт»', async () => {
    const measureCatalog = vi.fn(async () => null)
    const deps = baseDeps({ measureCatalog })
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'кг', vatRate: null }] }
    await runCrmSync('j', d, mapping(), {}, deps)
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: 166 })
  })

  it('#272: единица из словаря портала не проверяется по каталогу — это решение администратора', async () => {
    const measureCatalog = vi.fn(async () => ({ hasCode: () => false, byName: () => null }))
    const m = mapping()
    m.units.dictionary = { бухта: 2001 }
    const deps = baseDeps({ measureCatalog })
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'бухта', vatRate: null }] }
    await runCrmSync('j', d, m, {}, deps)
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: 2001 })
    expect(measureCatalog).not.toHaveBeenCalled()
  })

  it('autoCreate: unmatched unit created → code used on the row + "создана" warning', async () => {
    const m = mapping()
    m.units.autoCreate = true
    const createMeasure = vi.fn(async () => ({ code: 1001, created: true }))
    const deps = baseDeps({ createMeasure })
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'бухта', vatRate: null }] }
    const r = await runCrmSync('j', d, m, {}, deps)
    expect(createMeasure).toHaveBeenCalledWith('бухта')
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: 1001 })
    expect(r.warnings.some(w => /добавлена в каталог/.test(w))).toBe(true)
  })

  it('autoCreate: unit matched an EXISTING measure (created:false) → "сопоставлена с мерой" warning', async () => {
    const m = mapping()
    m.units.autoCreate = true
    const createMeasure = vi.fn(async () => ({ code: 796, created: false }))
    const deps = baseDeps({ createMeasure })
    // 'бухта' is NOT in the dictionary ({шт:796}) → reaches auto-create, which finds an existing measure.
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'бухта', vatRate: null }] }
    const r = await runCrmSync('j', d, m, {}, deps)
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: 796 })
    expect(r.warnings.some(w => /сопоставлена с единицей из вашего/.test(w))).toBe(true)
  })

  it('autoCreate: null → default code + "не сопоставлена"; warning deduped across repeated unit', async () => {
    const m = mapping()
    m.units.autoCreate = true
    const createMeasure = vi.fn(async () => null)
    const deps = baseDeps({ createMeasure })
    const d: ExtractedDocument = {
      ...doc,
      items: [
        { name: 'x', price: 10, quantity: 1, unit: '???', vatRate: null },
        { name: 'y', price: 20, quantity: 1, unit: '???', vatRate: null }
      ]
    }
    const r = await runCrmSync('j', d, m, {}, deps)
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ measureCode: m.units.defaultCode })
    // same unit on two rows → the "не сопоставлена" warning appears once
    expect(r.warnings.filter(w => /не распознана/.test(w))).toHaveLength(1)
  })

  it('autoCreate OFF: createMeasure dep NOT called even if present', async () => {
    const createMeasure = vi.fn(async () => ({ code: 1001, created: true }))
    const deps = baseDeps({ createMeasure })
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'бухта', vatRate: null }] }
    await runCrmSync('j', d, mapping(), {}, deps) // mapping() has autoCreate false by default
    expect(createMeasure).not.toHaveBeenCalled()
  })

  it('skip-warn: a SKIPPED row (product not found) does NOT auto-create a measure', async () => {
    const m = mapping()
    m.units.autoCreate = true
    m.product.onMissing = 'skip-warn'
    const createMeasure = vi.fn(async () => ({ code: 1001, created: true }))
    const deps = baseDeps({ createMeasure }) // findProduct default returns null → row skipped
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'бухта', vatRate: null }] }
    await runCrmSync('j', d, m, {}, deps)
    expect(createMeasure).not.toHaveBeenCalled()
  })

  it('empty items → creates, no setRows, NO opportunity field', async () => {
    const deps = baseDeps()
    const r = await runCrmSync('j', { ...doc, items: [] }, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(deps.setRows).not.toHaveBeenCalled()
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ opportunity: expect.anything() })
    )
  })

  it('smart-process target (entityTypeId ≥ 1000) → NO opportunity/isManualOpportunity', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 1032 }
    const deps = baseDeps()
    await runCrmSync('j', doc, m, {}, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypeId: 1032 }),
      expect.not.objectContaining({ isManualOpportunity: expect.anything() })
    )
  })

  it('negative price/qty → clamped to 0 + warning', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: -5, quantity: -2, unit: 'шт', vatRate: 22 }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    const row = (deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]!
    expect(row.price).toBe(0)
    expect(r.warnings.some(w => /отрицательные/.test(w))).toBe(true)
  })

  it('manual override routes to a different entity type; stageId passes through', async () => {
    const m = mapping()
    m.defaultTarget = { entityTypeId: 2, categoryId: 1, stageId: 'C1:NEW' }
    const deps = baseDeps()
    await runCrmSync('j', doc, m, { manualOverride: { entityTypeId: 31 } }, deps)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.objectContaining({ entityTypeId: 31 }), expect.any(Object))
    const deps2 = baseDeps()
    await runCrmSync('j', doc, m, {}, deps2)
    expect(deps2.createTarget).toHaveBeenCalledWith(expect.objectContaining({ stageId: 'C1:NEW' }), expect.any(Object))
  })
})
