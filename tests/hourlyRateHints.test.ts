import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOURLY_RATE_AS_OF, HOURLY_RATE_HINTS } from '../app/config/hourlyRateHints'
import { hourlyRateHint } from '../app/utils/savings'

// #311. Ставка-ориентир теперь живёт В ДВУХ местах: таблица в `docs/PROCESS.md` §7.1 (для человека)
// и карта в коде (для подсказки под полем). Ровно этого расхождения опасалась задача-напоминание
// #313 — обновят одну сторону, вторая молча останется с прошлогодней цифрой, и подсказка будет
// выглядеть свежей, потому что рядом с ней стоит дата.
//
// Поэтому тест разбирает САМ ДОКУМЕНТ, а не повторяет числа третьей копией.
const PROCESS = readFileSync(new URL('../docs/PROCESS.md', import.meta.url).pathname, 'utf8')

/** Строки вида «| Беларусь | **9,9 BYN** |» → { BYN: 9.9 }. */
function ratesFromDoc(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of PROCESS.matchAll(/\|\s*\*\*([\d\s,.]+)\s*([A-Z]{3})\*\*\s*\|/g)) {
    const value = Number(m[1]!.replace(/\s/g, '').replace(',', '.'))
    if (Number.isFinite(value)) out[m[2]!] = value
  }
  return out
}

describe('ориентир ставки часа — код и документ не расходятся (#311/#313)', () => {
  it('таблица в PROCESS.md разобралась — иначе гард молча проходит ни на чём', () => {
    expect(Object.keys(ratesFromDoc()).length).toBeGreaterThan(0)
  })

  it('значения совпадают с документом', () => {
    expect(HOURLY_RATE_HINTS).toEqual(ratesFromDoc())
  })

  it('дата ориентира взята из документа', () => {
    // Дата — не украшение: по ней администратор понимает, можно ли ещё этим пользоваться.
    expect(PROCESS).toContain(`на ${HOURLY_RATE_AS_OF}`)
  })
})

describe('подсказка под полем ставки (#311)', () => {
  it('для известной валюты несёт число и дату', () => {
    const hint = hourlyRateHint('BYN')
    expect(hint?.rate).toBe(9.9)
    // Запятая, а не точка: администратор так и вводит, а «9.9» над полем с запятой читалось бы
    // как «я ввёл неправильно».
    expect(hint?.text).toContain('9,9')
    expect(hint?.text).toContain(HOURLY_RATE_AS_OF)
    expect(hint?.text).toContain('BYN')
  })

  it('регистр кода не важен', () => {
    expect(hourlyRateHint('byn')?.rate).toBe(9.9)
  })

  it('незнакомая валюта — подсказки нет, а не чужая цифра', () => {
    expect(hourlyRateHint('EUR')).toBeNull()
    expect(hourlyRateHint('USD')).toBeNull()
  })

  it('валюты нет вовсе — подсказки нет', () => {
    expect(hourlyRateHint(null)).toBeNull()
    expect(hourlyRateHint(undefined)).toBeNull()
    expect(hourlyRateHint('')).toBeNull()
  })

  it('подсказка НЕ выдаёт себя за рекомендацию', () => {
    // Решение владельца: ориентир показываем, значение по умолчанию не подставляем. Текст обязан
    // говорить это прямо — иначе цифра из открытых источников читается как позиция приложения.
    expect(hourlyRateHint('RUB')!.text).toContain('справочная')
  })
})
