import { describe, expect, it, vi } from 'vitest'
import {
  classifyDemoDocType,
  extractedToDemoResult,
  runDemoAiExtract,
  type DemoAiDeps,
  type DemoAgentOutcome
} from '../server/utils/demoAi'
import type { ExtractedDocument } from '../app/types/document'

describe('classifyDemoDocType', () => {
  it('maps agent document types to the demo taxonomy', () => {
    expect(classifyDemoDocType('Товарная накладная').type).toBe('waybill')
    expect(classifyDemoDocType('Счёт-фактура').type).toBe('invoice')
    expect(classifyDemoDocType('Коммерческое предложение').type).toBe('quote')
    expect(classifyDemoDocType('Договор').type).toBe('unknown')
    expect(classifyDemoDocType(undefined)).toEqual({ type: 'unknown', label: 'Документ' })
  })
  it('keeps the agent label when present', () => {
    expect(classifyDemoDocType('Счёт №5').label).toBe('Счёт №5')
  })
})

const DOC: ExtractedDocument = {
  documentType: 'Счёт на оплату',
  currency: 'BYN',
  supplier: { name: 'ООО «Пример»', taxId: '191234567', taxIdKind: 'UNP' },
  items: [
    { name: 'Перчатки рабочие', article: 'ART-1', quantity: 300, unit: 'шт', price: 1.1 },
    { name: 'Каска защитная', quantity: 40, unit: 'шт', price: 9.8 }
  ]
}

describe('extractedToDemoResult', () => {
  it('maps document, supplier (UNP→УНП), items with computed sum, and totals', () => {
    const r = extractedToDemoResult(DOC)
    expect(r.docType).toBe('invoice')
    expect(r.supplier).toEqual({ name: 'ООО «Пример»', taxId: '191234567', taxIdKind: 'УНП' })
    expect(r.items).toHaveLength(2)
    expect(r.items[0]).toMatchObject({ name: 'Перчатки рабочие', article: 'ART-1', quantity: 300, unit: 'шт', price: 1.1, sum: 330 })
    expect(r.items[1]).toMatchObject({ name: 'Каска защитная', sum: 392 })
    expect(r.totals.sum).toBe(722)
    expect(r.currency).toBe('Br') // doc.currency 'BYN' → Br
  })
  it('uses the agent currency code when present', () => {
    const r = extractedToDemoResult({ currency: 'KZT', items: [{ name: 'X', quantity: 1, price: 2 }] })
    expect(r.currency).toBe('₸')
  })
  it('infers currency from the tax-id kind when the agent gives no currency', () => {
    const unp = extractedToDemoResult({ supplier: { taxId: '191234567', taxIdKind: 'UNP' }, items: [{ name: 'X', quantity: 1, price: 2 }] })
    expect(unp.currency).toBe('Br') // UNP → BYN → Br (fallback, no doc.currency)
    const inn = extractedToDemoResult({ supplier: { taxId: '7701234561', taxIdKind: 'INN' }, items: [{ name: 'X', quantity: 1, price: 2 }] })
    expect(inn.currency).toBe('₽') // INN → RUB → ₽
    const bin = extractedToDemoResult({ supplier: { taxId: '041050001234', taxIdKind: 'BIN' }, items: [{ name: 'X', quantity: 1, price: 2 }] })
    expect(bin.currency).toBe('₸') // BIN → KZT → ₸
  })
  it('omits the grand total for a price list (items but no per-line sums)', () => {
    const r = extractedToDemoResult({ items: [
      { name: 'Перчатки', price: 1.1 }, // прайс: name+price, no quantity → sum undefined
      { name: 'Каска', price: 9.8 }
    ] })
    expect(r.items[0]?.sum).toBeUndefined()
    expect(r.totals.sum).toBeUndefined()
  })
  it('placeholder name for a blank name; no supplier when empty', () => {
    const r = extractedToDemoResult({ items: [{ name: '  ', quantity: 1, price: 2 }] })
    expect(r.items[0]?.name).toBe('(без наименования)')
    expect(r.supplier).toBeUndefined()
    expect(r.docType).toBe('unknown')
  })
})

/** Build injectable deps with spies; override runAgent per case. */
function makeDeps(over: Partial<DemoAiDeps> = {}): DemoAiDeps & { cleanup: ReturnType<typeof vi.fn> } {
  return {
    writeTemp: vi.fn(async () => '/tmp/x.pdf'),
    extractText: vi.fn(async () => 'документ текст'),
    runAgent: vi.fn(async (): Promise<DemoAgentOutcome> => ({ ok: true, document: DOC })),
    cleanup: vi.fn(async () => {}),
    ...over
  }
}

describe('runDemoAiExtract', () => {
  it('extract → agent → DemoResult, temp file cleaned up', async () => {
    const deps = makeDeps()
    const out = await runDemoAiExtract(new Uint8Array([1]), 'invoice.pdf', deps)
    expect(out.result?.docType).toBe('invoice')
    expect(out.error).toBeUndefined()
    expect(deps.cleanup).toHaveBeenCalledWith('/tmp/x.pdf')
  })
  it('empty extracted text → honest error (still cleans up)', async () => {
    const deps = makeDeps({ extractText: vi.fn(async () => '   ') })
    const out = await runDemoAiExtract(new Uint8Array([1]), 'scan.png', deps)
    expect(out.result).toBeUndefined()
    expect(out.error).toMatch(/не удалось извлечь/i)
    expect(deps.cleanup).toHaveBeenCalled()
  })
  it('agent failure → its error surfaced', async () => {
    const deps = makeDeps({ runAgent: vi.fn(async () => ({ ok: false, document: null, error: 'API Error 529' })) })
    const out = await runDemoAiExtract(new Uint8Array([1]), 'a.pdf', deps)
    expect(out.error).toBe('API Error 529')
  })
  it('agent ok but no tabular part → clear error', async () => {
    const deps = makeDeps({ runAgent: vi.fn(async () => ({ ok: true, document: { items: [] } })) })
    const out = await runDemoAiExtract(new Uint8Array([1]), 'a.pdf', deps)
    expect(out.error).toMatch(/табличная часть/i)
  })
  it('a thrown runner is caught as a generic error, temp file still cleaned up', async () => {
    const deps = makeDeps({
      extractText: vi.fn(async () => {
        throw new Error('spawn pdftotext ENOENT')
      })
    })
    const out = await runDemoAiExtract(new Uint8Array([1]), 'a.pdf', deps)
    expect(out.error).toMatch(/ошибка обработки/i)
    expect(deps.cleanup).toHaveBeenCalledWith('/tmp/x.pdf')
  })
})
