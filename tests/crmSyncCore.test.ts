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
    getExisting: vi.fn(async () => null),
    findCompanyByTaxId: vi.fn(async () => 42),
    findProduct: vi.fn(async () => null),
    portalVatRates: vi.fn(async () => VAT),
    createTarget: vi.fn(async () => 555),
    setRows: vi.fn(async () => {}),
    recordResult: vi.fn(async () => {}),
    reportError: vi.fn(async () => {}),
    ...over
  }
}

const doc: ExtractedDocument = {
  currency: 'BYN',
  priceIncludesVat: true,
  supplier: { name: 'ООО Ромашка', taxId: '190000000' },
  items: [{ name: 'Гвоздь', price: 100, quantity: 2, unit: 'шт', vatRate: 22 }]
}

describe('runCrmSync', () => {
  it('happy path: creates target + rows, records result', async () => {
    const deps = baseDeps()
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.entityId).toBe(555)
    expect(deps.createTarget).toHaveBeenCalledWith(2, expect.objectContaining({ companyId: 42, categoryId: 1, currencyId: 'BYN' }))
    expect(deps.setRows).toHaveBeenCalledWith(2, 555, expect.arrayContaining([expect.objectContaining({ taxRate: 22, taxIncluded: 'Y', measureCode: 796 })]))
    expect(deps.recordResult).toHaveBeenCalledWith('job1', 2, 555)
  })

  it('idempotent: returns existing, no create', async () => {
    const deps = baseDeps({ getExisting: vi.fn(async () => ({ entityTypeId: 2, entityId: 999 })) })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r).toMatchObject({ created: false, entityId: 999 })
    expect(deps.createTarget).not.toHaveBeenCalled()
  })

  it('supplier not found → still creates, warning, no companyId', async () => {
    const deps = baseDeps({ findCompanyByTaxId: vi.fn(async () => null) })
    const r = await runCrmSync('job1', doc, mapping(), {}, deps)
    expect(r.created).toBe(true)
    expect(r.warnings.some(w => /Поставщик не найден/.test(w))).toBe(true)
    expect(deps.createTarget).toHaveBeenCalledWith(2, expect.not.objectContaining({ companyId: expect.anything() }))
  })

  it('VAT rate not in portal → error to chat, row skipped', async () => {
    const deps = baseDeps()
    const badVat: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'шт', vatRate: 25 }] }
    const r = await runCrmSync('job1', badVat, mapping(), {}, deps)
    expect(r.errors.some(e => /25%/.test(e))).toBe(true)
    expect(deps.reportError).toHaveBeenCalled()
    expect(deps.setRows).not.toHaveBeenCalled() // no valid rows
  })

  it('unit not mapped → error to chat but row still created (default measure)', async () => {
    const deps = baseDeps()
    const d: ExtractedDocument = { ...doc, items: [{ name: 'x', price: 10, quantity: 1, unit: 'рулон', vatRate: null }] }
    const r = await runCrmSync('job1', d, mapping(), {}, deps)
    expect(r.errors.some(e => /рулон/.test(e))).toBe(true)
    expect(deps.setRows).toHaveBeenCalled()
  })
})
