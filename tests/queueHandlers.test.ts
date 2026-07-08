import { describe, expect, it, vi } from 'vitest'
import { handleCrmSyncJob } from '../server/queue/handlers'
import { defaultMapping } from '../app/utils/portalSettings'
import type { ExtractedDocument } from '../app/types/document'

const doc: ExtractedDocument = {
  currency: 'BYN',
  priceIncludesVat: true,
  supplier: { name: 'X', taxId: '190000000' },
  items: [{ name: 'a', price: 10, quantity: 1, unit: 'шт', vatRate: null }]
}

function crmDeps() {
  return {
    getExisting: vi.fn(async () => null),
    findCompanyByTaxId: vi.fn(async () => 42),
    findProduct: vi.fn(async () => null),
    portalVatRates: vi.fn(async () => [{ id: '1', name: 'Без НДС', rate: null }]),
    createTarget: vi.fn(async () => 555),
    setRows: vi.fn(async () => {}),
    recordResult: vi.fn(async () => {}),
    reportErrors: vi.fn(async () => {})
  }
}

function deps(over = {}) {
  const m = defaultMapping()
  m.units.dictionary = { шт: 796 }
  m.product.onMissing = 'freeform'
  return {
    getMapping: vi.fn(async () => m),
    getDocument: vi.fn(async () => ({ doc, signals: {} })),
    crmSyncDeps: vi.fn(() => crmDeps()),
    setJobStatus: vi.fn(async () => {}),
    ...over
  }
}

describe('handleCrmSyncJob', () => {
  it('runs orchestration → done', async () => {
    const d = deps()
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.created).toBe(true)
    expect(d.setJobStatus).toHaveBeenCalledWith('m', 'j', 'done', expect.stringContaining('"entityId":555'))
  })
  it('missing document → error status, no run', async () => {
    const d = deps({ getDocument: vi.fn(async () => null) })
    expect(await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)).toBeNull()
    expect(d.setJobStatus).toHaveBeenCalledWith('m', 'j', 'error', expect.stringContaining('не найден'))
  })

  it('hard error (VAT not in portal) → error status', async () => {
    const badDoc: ExtractedDocument = { ...doc, items: [{ name: 'a', price: 10, quantity: 1, unit: 'шт', vatRate: 20 }] }
    const d = deps({ getDocument: vi.fn(async () => ({ doc: badDoc, signals: {} })) })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.created).toBe(false)
    expect(d.setJobStatus).toHaveBeenCalledWith('m', 'j', 'error', expect.stringContaining('errors'))
  })

  it('idempotent re-run (existing, no errors) → done', async () => {
    const cd = { ...crmDeps(), getExisting: vi.fn(async () => ({ entityTypeId: 2, entityId: 99 })) }
    const d = deps({ crmSyncDeps: vi.fn(() => cd) })
    const r = await handleCrmSyncJob({ memberId: 'm', jobId: 'j' }, d)
    expect(r?.created).toBe(false)
    expect(d.setJobStatus).toHaveBeenCalledWith('m', 'j', 'done', expect.any(String))
  })
})
