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

  // #336 — обе правки родились из живого прогона 34 реальных документов, не из головы.
  it('requires a PER-ROW arithmetic self-check and names the multi-column trap', () => {
    // Счёт с двумя ценовыми колонками (за м³ и за упаковку): модель взяла цену за м³, а количество
    // было в упаковках → строка выросла в разы. Проверка «quantity × price = напечатанная сумма
    // строки» ловит это, а заодно и потерянное количество, съеденное названием.
    expect(p).toMatch(/quantity × price/)
    expect(p).toMatch(/напечатанную\s+В\s+ЭТОЙ\s+ЖЕ\s+СТРОКЕ\s+сумму/)
    expect(p).toMatch(/НЕСКОЛЬКО\s+ценовых/)
    expect(p).toMatch(/в name\s+не вписывай/)
  })

  // Обе новые правки НЕСУТ оговорку «на priceIncludesVat не влияет» — без неё замер показал сдвиг
  // модели в сторону `true`, а это опасное направление: Σ цена×кол неотличима от «Итого» документа
  // без НДС, и доверие ему роняет НДС из суммы (см. app/utils/pricing.ts). Оговорка — не стиль,
  // а то, что вернуло flag=true с 16 до 8 на 34 документах.
  it('keeps both new rules explicitly OUT of the priceIncludesVat decision', () => {
    expect(p).toMatch(/На priceIncludesVat \(правило 3\) она не влияет/)
    expect(p).toMatch(/на общий флаг priceIncludesVat \(правило 3\) она не влияет/)
  })

  it('forbids substituting the country default VAT rate for a printed 0%', () => {
    // Экспортный счёт РФ→РБ с явным «НДС 0%» получил vatRate 20 на всех строках.
    expect(p).toMatch(/СТРОГО как напечатано/)
    expect(p).toMatch(/НДС 0%/)
    // Пробелы гибкие: правила переносятся по строкам, и жёсткий пробел ломался бы на каждом
    // переформатировании абзаца, не поймав ни одной настоящей потери смысла.
    expect(p).toMatch(/НЕ\s+подставляй\s+«обычную\s+ставку\s+страны\s+поставщика»/)
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
