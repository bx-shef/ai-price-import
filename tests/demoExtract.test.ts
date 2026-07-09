import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractDemo, MAX_DEMO_ITEMS, parseNum } from '../app/utils/demoExtract'

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
})

describe('extractDemo — Russian samples', () => {
  it('КП: type, supplier, УНП, items, totals', () => {
    const r = extractDemo(demo('kp-ru.txt'))
    expect(r.docType).toBe('quote')
    expect(r.language).toBe('ru')
    expect(r.number).toBe('КП-2026-014')
    expect(r.supplier?.name).toContain('СтройМатериалы')
    expect(r.supplier?.taxIdKind).toBe('УНП')
    expect(r.supplier?.taxId).toBe('191234567')
    expect(r.items).toHaveLength(4)
    expect(r.items[0]).toMatchObject({ article: 'CEM500-50', quantity: 100, unit: 'шт', price: 18.5, sum: 1850 })
    expect(r.totals.total).toBe(9796.8)
    expect(r.totals.vat).toBe(1632.8)
    expect(r.warnings).toHaveLength(0)
  })
  it('счёт-фактура → invoice', () => {
    const r = extractDemo(demo('invoice-ru.txt'))
    expect(r.docType).toBe('invoice')
    expect(r.supplier?.taxId).toBe('100345678')
    expect(r.items).toHaveLength(4)
  })
  it('ТТН → waybill', () => {
    const r = extractDemo(demo('ttn-ru.txt'))
    expect(r.docType).toBe('waybill')
    expect(r.items).toHaveLength(3)
    expect(r.totals.vat).toBe(815.5)
  })
})

describe('extractDemo — Belarusian samples', () => {
  it('КП be: пастаўшчык + УНП + найменне table', () => {
    const r = extractDemo(demo('kp-be.txt'))
    expect(r.docType).toBe('quote')
    expect(r.language).toBe('be')
    expect(r.supplier?.name).toContain('БудМатэрыялы')
    expect(r.supplier?.taxId).toBe('192778899')
    expect(r.items).toHaveLength(3)
    expect(r.totals.total).toBe(6724.8)
  })
  it('рахунак-фактура be → invoice', () => {
    const r = extractDemo(demo('invoice-be.txt'))
    expect(r.docType).toBe('invoice')
    expect(r.items).toHaveLength(3)
  })
  it('таварна-транспартная be → waybill', () => {
    const r = extractDemo(demo('ttn-be.txt'))
    expect(r.docType).toBe('waybill')
    expect(r.items).toHaveLength(3)
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
})
