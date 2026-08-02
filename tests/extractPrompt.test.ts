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

  it('states VAT uniformity + 1-to-1 no-loss + Kazakh letter preservation + total extraction', () => {
    expect(p).toMatch(/priceIncludesVat/)
    expect(p).toMatch(/ОДНО значение priceIncludesVat/)
    expect(p).toMatch(/1-в-1/)
    expect(p).toContain('ә, ғ, қ, ң, ө, ұ, ү, һ, і')
    // Extracts the printed grand total (used to reconcile VAT-inclusion + anchor the entity amount).
    expect(p).toMatch(/Всего к оплате/)
    expect(p).toMatch(/total/)
  })

  // #336/#337 — both rules came out of a run over real invoices, not out of thin air. These pins
  // hold the MEANING, not the presence of a paragraph: a mutation pass showed «⇒ vatRate = 20» and
  // «НЕ обязано давать» surviving the earlier pins — i.e. the test literally named "forbids
  // substituting the country default rate" missed exactly the regression the rule exists to stop.
  //
  // Slice ONE rule by its NUMBER. Splitting positionally is wrong: the rules run 1,2,3,8,7,4,5,6
  // (that order came out of the measurement — see the prompts/extract.ts header), so number ≠ index.
  const rule = (n: number): string => {
    const parts = p.split(/^(\d+)\. /m)
    const i = parts.indexOf(String(n))
    expect(i, `в промпте нет правила ${n}`).toBeGreaterThan(0)
    return parts[i + 1] ?? ''
  }

  it('requires a PER-ROW arithmetic self-check and names the multi-column trap', () => {
    // An invoice with two price columns (per m³ and per pack): the model took the per-m³ price while
    // the quantity was in packs → the line grew several-fold. ⚠ That document is NOT fixed by this
    // rule yet (it mismatches on both prompt sides in the measurement) — the pin locks the wording
    // down, it does not claim a win.
    expect(p).toMatch(/quantity × price\s+должно\s+сойтись/)
    expect(p).toMatch(/НЕСКОЛЬКО\s+ценовых/)
    expect(p).toMatch(/в name\s+не вписывай/)
  })

  // A rounded unit price (a tariff, a per-metre/per-kg rate) is NORMAL: on a real utilities act
  // 48,3 × 0,25 prints as 12,08 on one line and 11,94 on the next. Demanding an exact match demands
  // the impossible, and «ищи другую пару» pushes the model to BACK-SOLVE the price from the sum and
  // write into the CRM a number the document never contained. The tolerance and the explicit
  // no-fitting ban are load-bearing parts of the rule, not padding.
  it('tolerates rounded unit prices and forbids back-solving a price from the sum', () => {
    expect(p).toMatch(/Разошлось\s+В\s+РАЗЫ/)
    expect(p).toMatch(/Разошлось\s+на\s+копейки[^⇒]*⇒\s+ЭТО\s+НОРМА/)
    expect(p).toMatch(/НИЧЕГО\s+НЕ\s+ПОДГОНЯЙ/)
    expect(p).toMatch(/не\s+вычисляй\s+цену\s+из\s+суммы/)
    // A row with no printed sum (price list, quotation) must not corner the model.
    expect(p).toMatch(/суммы\s+нет\s+вовсе[^⇒]*⇒\s+бери\s+цену\s+и\s+количество\s+как\s+напечатано/)
  })

  // Each disclaimer lives INSIDE ITS OWN rule: a mutant that deleted rule 8's disclaimer and pasted
  // its text into rule 1 survived an "exists somewhere in the prompt" check.
  // Honest about the effect: the measurement (`pnpm ab:prompt`) shows the disclaimer REDUCES the
  // model's lean toward «цены с НДС» but does NOT remove it — over 33 documents flag=true still went
  // 27 → 37. The pin keeps it in place so the next edit does not drop the last thing holding it back.
  it('keeps both new rules explicitly OUT of the priceIncludesVat decision', () => {
    expect(rule(1)).toMatch(/На priceIncludesVat \(правило 3\) она не влияет/)
    expect(rule(8)).toMatch(/на общий флаг priceIncludesVat \(правило 3\) она не влияет/)
  })

  it('forbids substituting the country default VAT rate for a printed 0%', () => {
    // An RU→BY export invoice with an explicit «НДС 0%» was getting vatRate 20 on every line.
    expect(rule(8)).toMatch(/СТРОГО как напечатано/)
    // The load-bearing token is the ZERO itself: «⇒ vatRate = 20» survived a pin on «НДС 0%» alone.
    expect(rule(8)).toMatch(/«НДС 0%»[^⇒]*⇒\s*vatRate\s*=\s*0\b/)
    expect(rule(8)).toMatch(/НЕ\s+подставляй\s+«обычную\s+ставку\s+страны\s+поставщика»/)
    // …and with no «except when the rate is not printed» loophole.
    expect(rule(8)).not.toMatch(/КРОМЕ|кроме случаев/)
  })

  it('embeds an example that parses to a valid ExtractedDocument (net-priced, with a total)', () => {
    // The example JSON in the prompt must survive our own validator (contract check). It shows the
    // common РБ/РФ net-priced invoice → priceIncludesVat:false (not the misleading true it once showed).
    const m = p.match(/\{"documentType".*\}/)
    expect(m).toBeTruthy()
    const doc = validateExtractedDocument(JSON.parse(m![0]))
    expect(doc?.supplier).toEqual({ name: 'ООО "Ромашка"', taxId: '190000000', taxIdKind: 'UNP' })
    expect(doc?.items[0]).toMatchObject({ name: 'Болт М6', article: 'BM6-01', price: 5, vatRate: 20 })
    expect(doc?.priceIncludesVat).toBe(false)
    expect(doc?.total).toBe(60)
  })
})
