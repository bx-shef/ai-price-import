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

  // #336/#337 — обе нормы родились из прогона реальных документов, не из головы. Пины держат
  // ЗНАЧЕНИЕ, а не наличие абзаца: мутационная проверка показала, что «⇒ vatRate = 20» и
  // «НЕ обязано давать» переживали прежние пины, то есть тест с названием «запрещает подставлять
  // ставку страны» не замечал ровно ту регрессию, ради которой правило и появилось.
  // Текст ОДНОГО правила по его НОМЕРУ. Разбивать позиционно нельзя: правила идут 1,2,3,8,7,4,5,6
  // (порядок пришёл из замера, см. шапку prompts/extract.ts), и номер ≠ позиция.
  const rule = (n: number): string => {
    const parts = p.split(/^(\d+)\. /m)
    const i = parts.indexOf(String(n))
    expect(i, `в промпте нет правила ${n}`).toBeGreaterThan(0)
    return parts[i + 1] ?? ''
  }

  it('requires a PER-ROW arithmetic self-check and names the multi-column trap', () => {
    // Счёт с двумя ценовыми колонками (за м³ и за упаковку): модель взяла цену за м³, а количество
    // было в упаковках → строка выросла в разы.
    expect(p).toMatch(/quantity × price\s+должно\s+сойтись/)
    expect(p).toMatch(/НЕСКОЛЬКО\s+ценовых/)
    expect(p).toMatch(/в name\s+не вписывай/)
  })

  // Округлённая цена за единицу (тариф, цена за метр/кг) — норма: на реальном акте 48,3 × 0,25
  // печатается и как 12,08, и как 11,94 в соседних строках. Требовать точного совпадения значит
  // требовать невозможного, а «ищи другую пару» толкает модель ВЫЧИСЛИТЬ цену из суммы и записать
  // в CRM число, которого в документе нет. Допуск и запрет подгонки — обязательная часть правила.
  it('tolerates rounded unit prices and forbids back-solving a price from the sum', () => {
    expect(p).toMatch(/Разошлось\s+В\s+РАЗЫ/)
    expect(p).toMatch(/Разошлось\s+на\s+копейки[^⇒]*⇒\s+ЭТО\s+НОРМА/)
    expect(p).toMatch(/НИЧЕГО\s+НЕ\s+ПОДГОНЯЙ/)
    expect(p).toMatch(/не\s+вычисляй\s+цену\s+из\s+суммы/)
    // Строка без суммы (прайс, КП) не должна загонять модель в тупик.
    expect(p).toMatch(/суммы\s+нет\s+вовсе[^⇒]*⇒\s+бери\s+цену\s+и\s+количество\s+как\s+напечатано/)
  })

  // Оговорки живут КАЖДАЯ в своём правиле: мутант, удаливший оговорку из правила 8 и вставивший её
  // текст в правило 1, переживал проверку «есть где-то в промпте».
  it('keeps both new rules explicitly OUT of the priceIncludesVat decision', () => {
    expect(rule(1)).toMatch(/На priceIncludesVat \(правило 3\) она не влияет/)
    expect(rule(8)).toMatch(/на общий флаг priceIncludesVat \(правило 3\) она не влияет/)
  })

  it('forbids substituting the country default VAT rate for a printed 0%', () => {
    // Экспортный счёт РФ→РБ с явным «НДС 0%» получал vatRate 20 на всех строках.
    expect(rule(8)).toMatch(/СТРОГО как напечатано/)
    // Несущий токен — именно НОЛЬ: «⇒ vatRate = 20» переживало пин на «НДС 0%».
    expect(rule(8)).toMatch(/«НДС 0%»[^⇒]*⇒\s*vatRate\s*=\s*0\b/)
    expect(rule(8)).toMatch(/НЕ\s+подставляй\s+«обычную\s+ставку\s+страны\s+поставщика»/)
    // …и без лазейки «кроме случаев, когда ставка не напечатана».
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
