import { describe, expect, it, vi } from 'vitest'
import { runCrmSync } from '../server/queue/crmSyncCore'
import { defaultMapping } from '../app/utils/portalSettings'
import type { ExtractedDocument } from '../app/types/document'
import type { PortalMapping } from '../app/types/mapping'

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
    expect(r.errors.some(e => /не поддерживается импортом/.test(e))).toBe(true)
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
    expect(r.warnings).toContain('Уведомление в чат не отправлено')
  })

  it('writeActivity records a configurable дело on the created entity', async () => {
    const writeActivity = vi.fn(async () => {})
    await runCrmSync('job1', doc, mapping(), {}, baseDeps({ writeActivity }))
    expect(writeActivity).toHaveBeenCalledWith({ entityTypeId: 2, entityId: 555, supplierName: 'ООО Ромашка', rowCount: 1 })
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
    expect(r.warnings).toContain('Дело в таймлайне не создано')
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

  it('supplier not found → still creates, warning, no companyId', async () => {
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.warnings.some(w => /Поставщик не найден/.test(w))).toBe(true)
    expect(deps.createTarget).toHaveBeenCalledWith(expect.any(Object), expect.not.objectContaining({ companyId: expect.anything() }))
  })

  it('no supplier.taxId → no lookup; priceIncludesVat false → taxIncluded N', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, priceIncludesVat: false, supplier: { name: 'X' } }
    await runCrmSync('j', d, mapping(), {}, deps)
    expect(deps.findCompanyByTaxId).not.toHaveBeenCalled()
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]!.taxIncluded).toBe('N')
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

  it('vatRate 0 not in portal → hard error (not «Без НДС»)', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 1, quantity: 1, unit: 'шт', vatRate: 0 }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(r.errors.some(e => /0%/.test(e))).toBe(true)
  })

  it('VAT present but priceIncludesVat undefined → hard error (total would flip)', async () => {
    const deps = baseDeps()
    const { priceIncludesVat, ...rest } = doc // omit the inclusion flag
    void priceIncludesVat
    const r = await runCrmSync('j', rest as ExtractedDocument, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(r.errors.some(e => /включён ли НДС/.test(e))).toBe(true)
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

  it('mixed items with one bad-VAT → whole doc aborts (no line loss)', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = {
      ...doc,
      items: [
        { name: 'a', price: 1, quantity: 1, unit: 'шт', vatRate: 22 },
        { name: 'b', price: 2, quantity: 1, unit: 'шт', vatRate: 25 }
      ]
    }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(false)
    expect(deps.createTarget).not.toHaveBeenCalled()
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

  it('create: uses createProduct dep when present', async () => {
    const m = mapping()
    m.product.onMissing = 'create'
    const createProduct = vi.fn(async () => 888)
    const deps = baseDeps({ createProduct })
    await runCrmSync('j', doc, m, {}, deps)
    expect(createProduct).toHaveBeenCalled()
    expect((deps.setRows.mock.calls[0]![2] as Array<Record<string, unknown>>)[0]).toMatchObject({ productId: 888 })
  })

  it('unit not mapped → WARNING (not error), still creates with default measure', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'рулон', vatRate: null }] }
    const r = await runCrmSync('j', d, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.warnings.some(w => /рулон/.test(w))).toBe(true)
    expect(r.errors).toHaveLength(0)
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
    expect(r.warnings.some(w => /Отрицательн/.test(w))).toBe(true)
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
