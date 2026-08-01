import { describe, expect, it } from 'vitest'
import { describeTotalMismatch, lineGross, computeGrossTotal, reconcilePricing } from '../app/utils/pricing'
// Осознанная связка app→server в тесте: бюджет длины предупреждения задаёт именно чат-лимит,
// и держать его копию тут значило бы разъехаться с ним при первой же правке.
import { MAX_CHAT_REASON } from '../server/utils/chatNotify'
import type { DocumentItem } from '../app/types/document'

const item = (over: Partial<DocumentItem> = {}): DocumentItem => ({ name: 'x', price: 1, quantity: 1, ...over })

describe('lineGross', () => {
  it('net line + VAT added on the LINE total (round once)', () => {
    // the reported invoice line: 0.86 × 10000 @20% → 8600 net → 10320 (NOT 10300 from per-unit rounding)
    expect(lineGross(0.86, 10000, 20, false)).toBe(10320)
  })
  it('inclusive price → line is price×qty as-is', () => {
    expect(lineGross(1.03, 10000, 20, true)).toBe(10300)
  })
  it('no VAT rate → net only; clamps non-finite qty to 1', () => {
    expect(lineGross(50, 3, null, false)).toBe(150)
    expect(lineGross(100, NaN, 20, true)).toBe(100)
  })
  it('DISCOUNT line (negative price) contributes negatively — NOT clamped to 0', () => {
    // A discount of −20 @20% must subtract 24 from the gross (else the deal amount inflates).
    expect(lineGross(-20, 1, 20, false)).toBe(-24)
    expect(lineGross(-20, 1, null, false)).toBe(-20)
  })
})

describe('computeGrossTotal', () => {
  it('sums per-line gross under the given inclusion flag', () => {
    const items = [item({ price: 0.86, quantity: 10000, vatRate: 20 }), item({ price: 100, quantity: 1, vatRate: 20 })]
    expect(computeGrossTotal(items, false)).toBe(10320 + 120)
    expect(computeGrossTotal(items, true)).toBe(8600 + 100)
  })
})

describe('reconcilePricing', () => {
  const items = [item({ price: 0.86, quantity: 10000, vatRate: 20 })] // net 8600 / gross 10320

  it('printed GROSS total («Всего к оплате») matches the net-priced gross → false + anchor (deal #37)', () => {
    const r = reconcilePricing(items, /* modelFlag */ true, /* statedTotal */ 10320)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(true) // model said true, the printed gross proves net
    expect(r.totalMismatch).toBe(false)
  })

  it('SAFETY: model says net + total looks like «Итого» (net subtotal) → STAY net, do NOT drop VAT', () => {
    // The dangerous mis-read: the LLM grabs «Итого» 8600 (net) into total instead of «Всего к оплате».
    // grossInclusive (Σ price×qty) == 8600, so it is indistinguishable from a net subtotal. We must NOT
    // flip to «inclusive» (that would set opportunity 8600, dropping the 1720 VAT).
    const r = reconcilePricing(items, /* modelFlag */ false, /* statedTotal */ 8600)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320) // real gross = net + VAT, NOT the printed net subtotal
    expect(r.usedStatedTotal).toBe(false)
    expect(r.corrected).toBe(false)
  })

  it('genuine inclusive doc: model says inclusive + total matches the inclusive figure → trust true', () => {
    const r = reconcilePricing(items, /* modelFlag */ true, /* statedTotal */ 8600)
    expect(r.priceIncludesVat).toBe(true)
    expect(r.grossTotal).toBe(8600)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(false)
  })

  it('no printed total → keep the model flag, compute the total', () => {
    expect(reconcilePricing(items, false, undefined)).toMatchObject({ priceIncludesVat: false, grossTotal: 10320, usedStatedTotal: false, corrected: false })
    expect(reconcilePricing(items, true, undefined)).toMatchObject({ priceIncludesVat: true, grossTotal: 8600, usedStatedTotal: false })
  })

  it('printed total matches neither → totalMismatch, do not trust it', () => {
    const r = reconcilePricing(items, false, 99999)
    expect(r.totalMismatch).toBe(true)
    expect(r.usedStatedTotal).toBe(false)
    expect(r.grossTotal).toBe(10320) // falls back to the model-flag computation
  })

  it('absorbs per-line rounding noise but NOT a materially wrong total (capped tolerance, #5)', () => {
    // within the rounding budget (~0.5/line) → trusted
    expect(reconcilePricing(items, false, 10320.02)).toMatchObject({ usedStatedTotal: true, priceIncludesVat: false, grossTotal: 10320.02 })
    // a big invoice off by 50 (would pass an uncapped 1% = large) → NOT trusted, mismatch flagged
    const big = [item({ price: 1000, quantity: 100, vatRate: 20 })] // net 100000 / gross 120000
    const r = reconcilePricing(big, false, 120050) // 50 over the true gross, > capped tol (0.5)
    expect(r.usedStatedTotal).toBe(false)
    expect(r.totalMismatch).toBe(true)
  })

  it('no-VAT document with a total → anchor, but NO spurious «corrected» warning (#3)', () => {
    const exempt = [item({ price: 100, quantity: 2, vatRate: 0 })] // net == gross == 200
    const r = reconcilePricing(exempt, /* modelFlag */ true, /* statedTotal */ 200)
    expect(r.grossTotal).toBe(200)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(false) // VAT-neutral → the flag is irrelevant, no correction noise
  })

  it('TRI-STATE: model flag UNDEFINED + total matches net gross → «net», corrected=true (resolved unknown)', () => {
    // Model didn't say whether prices include VAT; the printed gross resolves it → net, and we mark it
    // corrected so the operator sees «уточнён по итогу», and usedStatedTotal lets crm-sync skip the hard error.
    const r = reconcilePricing(items, undefined, 10320)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320)
    expect(r.usedStatedTotal).toBe(true)
    expect(r.corrected).toBe(true)
  })

  it('MIXED VAT rates across lines: computes each line at its own rate; anchors to the matching total', () => {
    const mixed = [
      item({ price: 100, quantity: 1, vatRate: 20 }), // net 100 / gross 120
      item({ price: 50, quantity: 2, vatRate: 10 }), // net 100 / gross 110
      item({ price: 30, quantity: 1, vatRate: 0 }) // net 30 / gross 30
    ]
    expect(computeGrossTotal(mixed, false)).toBe(120 + 110 + 30) // 260 exclusive
    expect(computeGrossTotal(mixed, true)).toBe(100 + 100 + 30) // 230 inclusive
    const r = reconcilePricing(mixed, false, 260) // printed gross matches the exclusive reading only
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(260)
    expect(r.usedStatedTotal).toBe(true)
  })

  it('tolerance SCALES with line count: 20-line rounding drift within N×0.5 is accepted (not the flat 0.5)', () => {
    // 20 lines, each net-priced; a printed total 8 over the true gross — inside 20×0.5=10 tol, but would
    // fail a flat 0.5 floor. Proves the per-line-drift term controls, not just the floor/1%-cap.
    const many = Array.from({ length: 20 }, () => item({ price: 100, quantity: 1, vatRate: 20 })) // gross 2400
    const r = reconcilePricing(many, false, 2408)
    expect(r.usedStatedTotal).toBe(true) // trusted within scaled tolerance
    expect(r.grossTotal).toBe(2408)
  })
})

describe('печатный итог, совпавший с суммой строк, не считается подтверждением (#302)', () => {
  const items = [item({ price: 0.86, quantity: 10000, vatRate: 20 })] // 8600 без НДС / 10320 с НДС

  it('модель сказала «с НДС», итог = 8600 → берём её слово, но помечаем как неподтверждённое', () => {
    const r = reconcilePricing(items, true, 8600)
    expect(r.priceIncludesVat).toBe(true)
    expect(r.grossTotal).toBe(8600)
    // Главное: раньше это выглядело как «подтверждено печатным итогом» и уходило молча.
    expect(r.totalAmbiguous).toBe(true)
  })

  it('однозначный случай (итог = 10320) подтверждением остаётся и предупреждения не даёт', () => {
    const r = reconcilePricing(items, true, 10320)
    expect(r.priceIncludesVat).toBe(false)
    expect(r.grossTotal).toBe(10320)
    expect(r.totalAmbiguous).toBe(false)
  })

  it('без НДС двусмысленности нет — сумма одна и та же при любом флаге', () => {
    const noVat = [item({ price: 10, quantity: 5, vatRate: 0 })]
    expect(reconcilePricing(noVat, true, 50).totalAmbiguous).toBe(false)
  })
})

// #336: живой прогон 34 реальных документов показал, что сам факт «итог не сошёлся» бесполезен —
// на счёте в 44 или 61 строку искать нечего. Поисковый ключ — разница: неверно прочитанная ячейка
// (не та ценовая колонка, количество, съеденное названием) сдвигает ровно одну строку.
describe('describeTotalMismatch', () => {
  it('называет напечатанный итог, посчитанный по строкам и разницу — в русском формате', () => {
    // Реальный случай из прогона: одна строка из девяти взяла цену за м³ вместо цены за упаковку.
    const s = describeTotalMismatch(373198, 390344.56, 'RUB')
    expect(s).toContain('373 198,00 RUB')
    expect(s).toContain('390 344,56 RUB')
    expect(s).toContain('разница 17 146,56 RUB')
  })

  it('разница печатается модулем — направление видно по двум названным числам', () => {
    const less = describeTotalMismatch(1000, 900)
    const more = describeTotalMismatch(900, 1000)
    expect(less).toContain('разница 100,00')
    expect(more).toContain('разница 100,00')
    expect(less).toContain('1 000,00')
    expect(more).toContain('1 000,00')
    // Ни один из вариантов не печатает «−» перед разницей.
    expect(less).not.toContain('разница −')
    expect(more).not.toContain('разница −')
  })

  it('отрицательный итог (скидочный документ) сохраняет знак у самой суммы', () => {
    expect(describeTotalMismatch(100, -50)).toContain('−50,00')
  })

  it('валюта эхом идёт ТОЛЬКО кодом ISO — всё остальное от модели отбрасывается', () => {
    expect(describeTotalMismatch(100, 200, 'byn')).toContain('100,00 BYN')
    for (const bad of ['', ' ', 'BY', 'BYNN', 'B1N', 'руб.', '[url=x]y[/url]', 'BYN\nDisallow']) {
      const s = describeTotalMismatch(100, 200, bad)
      expect(s).toContain('100,00,') // сумма, сразу запятая предложения — валюты нет
      expect(s).not.toContain(bad.trim() || 'НИЧЕГО-НЕ-ИЩЕМ')
    }
  })

  it('без пригодного напечатанного итога — общая формулировка, без NaN', () => {
    for (const v of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = describeTotalMismatch(v, 120, 'BYN')
      expect(s).not.toMatch(/NaN|Infinity/)
      expect(s).toMatch(/не сошёлся с суммой по строкам/)
    }
  })

  it('всегда говорит, что делать дальше', () => {
    for (const s of [describeTotalMismatch(1, 2), describeTotalMismatch(undefined, 2)]) {
      expect(s).toMatch(/проверьте позиции/)
    }
  })

  // Сумма ≥1e21 уводит toFixed в экспоненту, и «1,2345678901234568e+21» читается как «1,23…» —
  // уверенно неверное число хуже отсутствия числа. Бесконечность приходила как «0,00», то есть
  // сообщение заявляло, что строки дают ноль. Оба случая теперь уходят в общую формулировку.
  it('непечатаемая сумма (экспонента, бесконечность, NaN) → общая формулировка, без чисел', () => {
    const bad: Array<[number | undefined, number]> = [
      [1e24, 24], [24, 1e24], [1e21, 1], // ровно граница экспоненты
      [100, Number.POSITIVE_INFINITY], [Number.POSITIVE_INFINITY, 100],
      [Number.NaN, 100], [undefined, 100]
    ]
    for (const [a, b] of bad) {
      const s = describeTotalMismatch(a, b, 'BYN')
      expect(s, `${a} / ${b}`).toMatch(/не сошёлся с суммой по строкам/)
      expect(s).not.toMatch(/e\+|undefined|NaN|Infinity/)
      // и никакой выдуманной точной суммы
      expect(s).not.toMatch(/\d,\d\d BYN/)
    }
    // сразу под границей — числа печатаются
    expect(describeTotalMismatch(1e21 - 1e6, 1, 'BYN')).toMatch(/разница/)
  })

  it('три числа согласованы между собой (округляем печатный итог ОДИН раз)', () => {
    // Раньше показывали round2(итога), а разницу считали от сырого — три числа не сходились.
    for (const [a, b] of [[100.005, 200], [0.005, 1], [12345.674, 12345.671]] as const) {
      const s = describeTotalMismatch(a, b)
      const nums = [...s.matchAll(/(−?[\d ]+),(\d\d)/g)].map(m => Number(m[1]!.replace(/ /g, '') + '.' + m[2]))
      expect(nums).toHaveLength(3)
      expect(Math.abs(Math.abs(nums[1]! - nums[0]!) - nums[2]!)).toBeLessThan(0.005)
    }
  })

  // Чат режет каждое предупреждение ровно на MAX_CHAT_REASON БЕЗ многоточия (chatSafeText → slice),
  // поэтому длинная фраза молча теряет хвост. Первая редакция этого текста была 261 символ.
  it('реалистичный текст умещается в лимит строки предупреждения в чате', () => {
    const real: Array<[number, number, string | undefined]> = [
      [373198, 390344.56, 'RUB'], [10320, 8600, 'BYN'], [232176.45, 220400.04, 'RUB'],
      [99999, 120, 'BYN'], [1519.2, 1519.21, undefined], [4092.82, 4092.83, 'BYN']
    ]
    for (const c of real) expect(describeTotalMismatch(...c).length, JSON.stringify(c)).toBeLessThanOrEqual(MAX_CHAT_REASON)
    expect(describeTotalMismatch(undefined, 1).length).toBeLessThanOrEqual(MAX_CHAT_REASON)
    // Числа идут ПЕРВЫМИ: даже если экзотическая сумма выйдет за лимит, режется только совет.
    const huge = describeTotalMismatch(-999999999999.99, 999999999999.99, 'KZT')
    expect(huge.indexOf('разница')).toBeLessThan(MAX_CHAT_REASON)
  })
})
