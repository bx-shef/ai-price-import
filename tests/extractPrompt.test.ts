import { describe, expect, it } from 'vitest'
import { buildExtractionPrompt } from '../prompts/extract'
import { validateExtractedDocument } from '../app/utils/extractedDocument'

describe('buildExtractionPrompt', () => {
  const p = buildExtractionPrompt()

  it('demands a single JSON object, no prose/markdown', () => {
    expect(p).toMatch(/РОВНО ОДИН JSON/)
    expect(p).toMatch(/без markdown/)
  })

  it('carries the tax-id labels for all three countries/languages', () => {
    for (const label of ['ИНН', 'УНП', 'БИН', 'БСН', 'ИИН', 'ЖСН']) expect(p).toContain(label)
    for (const kind of ['INN', 'UNP', 'BIN', 'IIN']) expect(p).toContain(kind)
  })

  it('states VAT uniformity + 1-to-1 no-loss + Kazakh letter preservation', () => {
    expect(p).toMatch(/priceIncludesVat/)
    expect(p).toMatch(/единый по всему документу/)
    expect(p).toMatch(/1-в-1/)
    expect(p).toContain('ә, ғ, қ, ң, ө, ұ, ү, һ, і')
  })

  it('embeds an example that parses to a valid ExtractedDocument', () => {
    // The example JSON in the prompt must survive our own validator (contract check).
    const m = p.match(/\{"documentType".*\}/)
    expect(m).toBeTruthy()
    const doc = validateExtractedDocument(JSON.parse(m![0]))
    expect(doc?.supplier).toEqual({ name: 'ООО "Ромашка"', taxId: '190000000', taxIdKind: 'UNP' })
    expect(doc?.items[0]).toMatchObject({ name: 'Болт М6', article: 'BM6-01', price: 0.45, vatRate: 20 })
  })
})
