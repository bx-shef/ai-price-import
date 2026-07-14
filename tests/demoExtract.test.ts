import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { currencySymbol, detectCurrencyCode, extractDemo, MAX_DEMO_ITEMS, parseNum } from '../app/utils/demoExtract'

const demo = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../public/demo/${name}`, import.meta.url)), 'utf8')

describe('parseNum', () => {
  it('handles ru/be spaces + comma decimal and plain dot', () => {
    expect(parseNum('1 850,00')).toBe(1850)
    expect(parseNum('1850.00')).toBe(1850)
    expect(parseNum('1 850.00')).toBe(1850)
    expect(parseNum('0,65')).toBe(0.65)
    expect(parseNum('1.234.567,89')).toBeCloseTo(1234567.89)
  })
  it('empty / garbage → undefined', () => {
    expect(parseNum('')).toBeUndefined()
    expect(parseNum('—')).toBeUndefined()
  })
  it('accounting negatives: parentheses and trailing/leading minus', () => {
    expect(parseNum('(330,00)')).toBe(-330)
    expect(parseNum('1 234,56-')).toBeCloseTo(-1234.56)
    expect(parseNum('-42')).toBe(-42)
  })
})

describe('extractDemo — Russian samples', () => {
  it('КП: type, supplier, ИНН, items, totals', () => {
    const r = extractDemo(demo('kp-ru.txt'))
    expect(r.docType).toBe('quote')
    expect(r.language).toBe('ru')
    expect(r.number).toBe('КП-2026-014')
    expect(r.supplier?.name).toContain('СтройМатериалы')
    expect(r.supplier?.taxIdKind).toBe('ИНН')
    expect(r.supplier?.taxId).toBe('7715234562')
    expect(r.items).toHaveLength(4)
    expect(r.items[0]).toMatchObject({ article: 'CEM500-50', quantity: 100, unit: 'шт', price: 18.5, sum: 1850 })
    expect(r.totals.total).toBe(9960.08)
    expect(r.totals.vat).toBe(1796.08)
    expect(r.warnings).toHaveLength(0)
  })
  it('счёт-фактура → invoice', () => {
    const r = extractDemo(demo('invoice-ru.txt'))
    expect(r.docType).toBe('invoice')
    expect(r.supplier?.taxIdKind).toBe('ИНН')
    expect(r.supplier?.taxId).toBe('7701234561')
    expect(r.items).toHaveLength(4)
  })
  it('ТТН → waybill', () => {
    const r = extractDemo(demo('ttn-ru.txt'))
    expect(r.docType).toBe('waybill')
    expect(r.items).toHaveLength(3)
    expect(r.totals.vat).toBe(1794.1)
  })
})

describe('extractDemo — Belarus samples (Russian-language, per RB practice)', () => {
  it('КП РБ: поставщик + УНП + таблица', () => {
    const r = extractDemo(demo('kp-be.txt'))
    expect(r.docType).toBe('quote')
    expect(r.language).toBe('ru') // RB documents are written in Russian
    expect(r.supplier?.name).toContain('СтройМатериалы')
    expect(r.supplier?.taxId).toBe('192778899') // УНП preserved
    expect(r.items).toHaveLength(3)
    expect(r.totals.total).toBe(6724.8)
  })
  it('счёт РБ → invoice', () => {
    const r = extractDemo(demo('invoice-be.txt'))
    expect(r.docType).toBe('invoice')
    expect(r.language).toBe('ru')
    expect(r.supplier?.taxId).toBe('101223344')
    expect(r.items).toHaveLength(3)
  })
  it('товарно-транспортная накладная РБ → waybill', () => {
    const r = extractDemo(demo('ttn-be.txt'))
    expect(r.docType).toBe('waybill')
    expect(r.items).toHaveLength(3)
    expect(r.supplier?.taxIdKind).toBe('УНП')
    expect(r.totals.vat).toBe(1631) // RB standard rate 20%
  })
})

describe('extractDemo — Kazakh samples', () => {
  it('КП kk: жеткізуші + БСН + атауы table', () => {
    const r = extractDemo(demo('kp-kk.txt'))
    expect(r.docType).toBe('quote')
    expect(r.language).toBe('kk')
    expect(r.supplier?.name).toContain('ҚұрылысМатериалдары')
    expect(r.supplier?.taxIdKind).toBe('БСН')
    expect(r.supplier?.taxId).toBe('051140004321')
    expect(r.items).toHaveLength(3)
    expect(r.totals.total).toBe(6276.48)
  })
  it('шот-фактура kk → invoice', () => {
    const r = extractDemo(demo('invoice-kk.txt'))
    expect(r.docType).toBe('invoice')
    expect(r.items).toHaveLength(3)
    expect(r.totals.vat).toBe(119.04)
  })
  it('жүкқұжат kk → waybill', () => {
    const r = extractDemo(demo('ttn-kk.txt'))
    expect(r.docType).toBe('waybill')
    expect(r.items).toHaveLength(3)
  })
})

describe('extractDemo — robustness', () => {
  it('empty input → unknown, warnings, no throw', () => {
    const r = extractDemo('')
    expect(r.docType).toBe('unknown')
    expect(r.items).toHaveLength(0)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('null-ish input → no throw', () => {
    expect(() => extractDemo(undefined as unknown as string)).not.toThrow()
  })
  it('free text with no table → warns, no items', () => {
    const r = extractDemo('Здравствуйте! Пришлите, пожалуйста, счёт на оплату.')
    expect(r.items).toHaveLength(0)
    expect(r.warnings).toContain('Позиции не распознаны')
  })
  it('caps items at MAX_DEMO_ITEMS', () => {
    const header = 'Наименование | Кол-во | Цена | Сумма'
    const rows = Array.from({ length: MAX_DEMO_ITEMS + 50 }, (_, i) => `Товар ${i} | 1 | 1.00 | 1.00`)
    const r = extractDemo([header, ...rows].join('\n'))
    expect(r.items).toHaveLength(MAX_DEMO_ITEMS)
    expect(r.warnings.some(w => /демо-лимит/.test(w))).toBe(true)
  })
  it('accepts a tab-delimited table (user CSV/TSV path)', () => {
    const text = 'Поставщик: ООО Тест\nИНН: 7701234567\nНаименование\tКол-во\tЦена\tСумма\nБолт М6\t100\t0.50\t50.00'
    const r = extractDemo(text)
    expect(r.supplier?.taxIdKind).toBe('ИНН')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ name: 'Болт М6', quantity: 100, sum: 50 })
  })
  it('recognizes БИН / ИИН / ЖСН tax-id kinds', () => {
    expect(extractDemo('БИН: 123456789012').supplier?.taxIdKind).toBe('БИН')
    expect(extractDemo('ИИН 987654321098').supplier?.taxIdKind).toBe('ИИН')
    expect(extractDemo('ЖСН: 111122223333').supplier?.taxIdKind).toBe('ЖСН')
  })
  it('language unknown when no locale hint present', () => {
    expect(extractDemo('Just a plain english note.').language).toBe('unknown')
  })
  it('reads the seller from a waybill «Грузоотправитель» / «Жүк жөнелтуші» field', () => {
    // Real ТТН-1 / 1-Т / жүкқұжат name the seller as consignor, not «Поставщик».
    expect(extractDemo('Грузоотправитель: ЧУП «АгроПоставка»').supplier?.name).toBe('ЧУП «АгроПоставка»')
    expect(extractDemo('Жүк жөнелтуші: «АграЖеткізу» ЖК').supplier?.name).toBe('«АграЖеткізу» ЖК')
    // The consignee line must NOT be picked as the seller.
    const r = extractDemo('Грузоотправитель: Продавец ООО\nГрузополучатель: Покупатель ООО')
    expect(r.supplier?.name).toBe('Продавец ООО')
  })
  it('recognizes alternative name-column words (Продукция/Позиция/Услуга)', () => {
    for (const head of ['Продукция', 'Позиция', 'Услуга', 'Тауар']) {
      const r = extractDemo(`${head} | Кол-во | Цена | Сумма\nНечто | 2 | 5.00 | 10.00`)
      expect(r.items).toHaveLength(1)
      expect(r.items[0]?.name).toBe('Нечто')
    }
  })
  it('keeps a numeric row with a blank name under a placeholder + warns', () => {
    const text = 'Наименование | Кол-во | Цена | Сумма\n | 3 | 4.00 | 12.00'
    const r = extractDemo(text)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]?.name).toBe('(без наименования)')
    expect(r.warnings).toContain('Есть строки без наименования')
  })
  it('parses a semicolon-delimited table', () => {
    const text = 'Наименование;Кол-во;Цена;Сумма\nГайка;10;0.30;3.00'
    const r = extractDemo(text)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ name: 'Гайка', quantity: 10, sum: 3 })
  })
  it('parses a 2-column price list (Наименование | Цена) via pipe/tab/semicolon', () => {
    for (const d of ['|', '\t', ';']) {
      const text = `Наименование${d}Цена\nПерчатки рабочие${d}1.10\nКаска защитная${d}9.80`
      const r = extractDemo(text)
      expect(r.items).toHaveLength(2)
      expect(r.items[0]).toMatchObject({ name: 'Перчатки рабочие', price: 1.1 })
      expect(r.items[1]).toMatchObject({ name: 'Каска защитная', price: 9.8 })
    }
  })
  it('does NOT treat a 2-cell comma split as a table (decimal-comma safety)', () => {
    // «name, price» is 2 cells on the comma. Comma needs ≥3 cells (unlike pipe/tab/
    // semicolon) precisely because a decimal comma collides with a field comma — so a
    // 2-column comma list stays unrecognised rather than shredding «980» into cells.
    const text = 'Наименование, Цена\nПерчатки рабочие, 110\nКаска защитная, 980'
    const r = extractDemo(text)
    expect(r.warnings).toContain('Таблица товаров не распознана')
    expect(r.items).toHaveLength(0)
  })
  it('does NOT let a short totals row veto delimiter detection (regression)', () => {
    // «Итого|200» is 2 cells; must not discard the pipe delimiter.
    const text = 'Наименование|Кол-во|Цена|Сумма\nНасос|2|100|200\nИтого|200'
    const r = extractDemo(text)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ name: 'Насос', quantity: 2, sum: 200 })
    expect(r.totals.sum).toBe(200)
  })
  it('does NOT classify a product named «НДС-насос» as a VAT total', () => {
    const text = 'Наименование|Кол-во|Цена|Сумма\nНДС-насос|1|100|100\nНасос|1|50|50'
    const r = extractDemo(text)
    expect(r.items.map(i => i.name)).toContain('НДС-насос')
    expect(r.items).toHaveLength(2)
    expect(r.totals.vat).toBeUndefined()
  })
})

describe('extractDemo — invoice/waybill totals across languages', () => {
  it('invoice-ru totals', () => {
    const r = extractDemo(demo('invoice-ru.txt'))
    expect(r.totals).toMatchObject({ sum: 1172, vat: 257.84, total: 1429.84 })
  })
  it('РБ grand-total label «Всего к оплате»', () => {
    expect(extractDemo(demo('invoice-be.txt')).totals.total).toBe(1190.4)
  })
  it('kk grand-total label «барлығы төлеуге»', () => {
    expect(extractDemo(demo('invoice-kk.txt')).totals.total).toBe(1111.04)
  })
})

describe('currency', () => {
  it('currencySymbol maps ISO codes to symbols', () => {
    expect(currencySymbol('RUB')).toBe('₽')
    expect(currencySymbol('BYN')).toBe('Br')
    expect(currencySymbol('KZT')).toBe('₸')
    expect(currencySymbol(undefined)).toBeUndefined()
    expect(currencySymbol('XXX')).toBe('XXX') // unknown passes through
  })
  it('detectCurrencyCode infers from tax-id kind when no explicit token', () => {
    expect(detectCurrencyCode('счёт', 'ИНН')).toBe('RUB')
    expect(detectCurrencyCode('счёт', 'УНП')).toBe('BYN')
    expect(detectCurrencyCode('шот', 'БСН')).toBe('KZT')
    expect(detectCurrencyCode('в рублях РФ')).toBe('RUB') // explicit token wins
  })
  it('«бел. руб.» → BYN even though it contains «руб» (not RUB)', () => {
    expect(detectCurrencyCode('Цена, бел. руб.', 'УНП')).toBe('BYN')
    expect(detectCurrencyCode('белорусских рублей')).toBe('BYN')
  })
  it('«европоддон» does not false-positive as EUR (falls to tax-id inference)', () => {
    expect(detectCurrencyCode('Европоддон 1200×800', 'БСН')).toBe('KZT')
    expect(detectCurrencyCode('оплата в евро')).toBe('EUR') // real token still works
  })
  it('demo samples expose a currency symbol per market (РФ ₽ / РБ Br / КЗ ₸)', () => {
    expect(extractDemo(demo('invoice-ru.txt')).currency).toBe('₽')
    expect(extractDemo(demo('invoice-be.txt')).currency).toBe('Br')
    expect(extractDemo(demo('invoice-kk.txt')).currency).toBe('₸')
  })
})

// Quality fixes from the 42-file import analysis (GH #66).
describe('extractDemo — real-invoice quality (GH #66)', () => {
  it('detects a soft-wrapped «Коли- чество» header as the quantity column', () => {
    const text = [
      'Счёт № 7',
      'Наименование\tКоли- чество\tЦена\tСумма',
      'Доска террасная\t145.2\t68.5\t9946.2'
    ].join('\n')
    const r = extractDemo(text)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.quantity).toBe(145.2)
  })

  it('drops a footer/signature row («Ответственный») from the goods table', () => {
    const text = [
      'Счёт № 8',
      '№\tНаименование\tЦена',
      '1\tБолт М6\t5',
      '\tОтветственный\t'
    ].join('\n')
    const r = extractDemo(text)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.name).toBe('Болт М6')
  })

  it('extracts a supplier stated without a «Поставщик:» label (company at top)', () => {
    const text = [
      'ООО "Смартон", УНП 190635842',
      'Счёт № 9',
      'Наименование\tЦена',
      'Мешки для мусора\t3.56'
    ].join('\n')
    const r = extractDemo(text)
    expect(r.supplier?.name).toBe('ООО "Смартон"')
    expect(r.supplier?.taxId).toBe('190635842')
  })

  it('does not misread a legal-form word inside a product name as the supplier', () => {
    // No company-at-top and no label → supplier name stays undefined (only tax id may set).
    const text = 'Прайс\nНаименование\tЦена\nКронштейн ОАО-типа\t10'
    const r = extractDemo(text)
    expect(r.supplier?.name).toBeUndefined()
  })
})
