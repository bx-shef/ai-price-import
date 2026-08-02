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

/** Раздел §7.1 — от заголовка «Ориентир для администратора» до конца абзаца-таблицы.
 *
 * Ищем именно в нём, а не по всему документу (замечание ревью): шаблон «жирное число + код
 * валюты» описывает ЛЮБУЮ сумму, и первая же строка вроде «**1000 RUB**» в другом разделе
 * (пример расчёта, ценовой сценарий) попала бы в сравнение и уронила гард на ровном месте.
 * Ложное срабатывание тут дороже обычного: следующий, кто его увидит, решит, что гард шумит,
 * и ослабит именно ту проверку, ради которой всё затевалось. */
const SECTION = (() => {
  const from = PROCESS.indexOf('**Ориентир для администратора**')
  if (from < 0) return ''
  const to = PROCESS.indexOf('\n- **Успешность**', from)
  return PROCESS.slice(from, to < 0 ? undefined : to)
})()

/** Строки вида «| Беларусь | **9,9 BYN** |» → { BYN: 9.9 }. */
function ratesFromDoc(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of SECTION.matchAll(/\|\s*\*\*([\d\s,.]+)\s*([A-Z]{3})\*\*\s*\|/g)) {
    const value = Number(m[1]!.replace(/\s/g, '').replace(',', '.'))
    if (Number.isFinite(value)) out[m[2]!] = value
  }
  return out
}

describe('ориентир ставки часа — код и документ не расходятся (#311/#313)', () => {
  it('таблица в PROCESS.md разобралась — иначе гард молча проходит ни на чём', () => {
    // ⚠ Пустое множество здесь ЛЕГАЛЬНО ровно в одном случае, и он документирован в #313: если
    // ориентиры решено больше не поддерживать, таблицу убирают целиком. Тогда карта в коде обязана
    // опустеть вместе с ней (подсказка исчезнет — это ровно поведение до #311), и оба множества
    // пусты. Запрещать этот исход тестом нельзя: он заставил бы тянуть устаревшие цифры формально.
    const doc = Object.keys(ratesFromDoc()).length
    if (doc === 0) {
      expect(Object.keys(HOURLY_RATE_HINTS), 'таблицу убрали из документа — уберите и из кода').toEqual([])
      return
    }
    expect(doc).toBeGreaterThan(0)
  })

  it('значения совпадают с документом', () => {
    expect(HOURLY_RATE_HINTS).toEqual(ratesFromDoc())
  })

  it('чужая сумма из другого раздела в сравнение не попадает', () => {
    // Регрессия на замечание ревью: раньше парсился весь документ, и «**1000 RUB**» где угодно
    // роняло гард. Здесь такой суммы в §7.1 нет — значит, границы раздела работают.
    expect(PROCESS).toContain('**Ориентир для администратора**')
    expect(SECTION.length).toBeGreaterThan(0)
    expect(SECTION.length).toBeLessThan(PROCESS.length)
  })

  it('дата ориентира взята из документа', () => {
    // Дата — не украшение: по ней администратор понимает, можно ли ещё этим пользоваться.
    expect(SECTION).toContain(`на ${HOURLY_RATE_AS_OF}`)
  })

  it('дата в разделе ровно одна — иначе обновят половину', () => {
    // Замечание ревью: дата теперь встречается в разделе дважды (подводка к таблице и абзац про
    // интерфейс). Проверка «документ содержит такую-то дату» на этом ломается по-тихому: обновят
    // одно упоминание, второе останется прошлогодним, а гард останется зелёным — ровно тот исход,
    // против которого #313 и заведена. Поэтому требуем, чтобы ВСЕ даты раздела были одной датой.
    const dates = new Set([...SECTION.matchAll(/\b\d{2}\.\d{2}\.\d{4}\b/g)].map(m => m[0]))
    // 01.02.2027 — дата СЛЕДУЮЩЕЙ сверки, она законно отличается и в сравнение не идёт.
    dates.delete('01.02.2027')
    expect([...dates], 'в §7.1 разъехались даты ориентира').toEqual([HOURLY_RATE_AS_OF])
  })
})

describe('проводка на странице настроек (#311)', () => {
  // Замечание ревью: nuxt-тест монтирует b24ui-компонент со СВОИМИ пропсами и о странице не знает
  // ничего. Опечатка прямо в `settings.vue` (`:format-optoins`) прошла бы и его, и typecheck —
  // Vue уносит неизвестный проп в fallthrough-атрибуты, и поле просто осталось бы без валюты.
  // Поэтому бьём по ИСХОДНИКУ страницы, как `tests/publisher.test.ts` бьёт по литералам.
  const PAGE = readFileSync(new URL('../app/pages/settings.vue', import.meta.url).pathname, 'utf8')

  it('поле ставки получает валютный формат, сотые и русскую локаль', () => {
    expect(PAGE).toContain(':format-options="rateFormatOptions"')
    expect(PAGE).toContain(':step="0.01"')
    expect(PAGE).toContain('locale="ru"')
  })

  it('подсказка выводится авто-экранированием, а не v-html', () => {
    expect(PAGE).toContain('{{ rateHint.text }}')
    expect(PAGE).not.toContain('v-html="rateHint')
  })

  it('ориентир подставляется в поле — но только в пустое и только у админа', () => {
    // Значение подставляется (решение владельца), однако три условия обязаны стоять рядом:
    // подставляем ТОЛЬКО когда ставки нет вовсе (иначе затрём введённую руками), ТОЛЬКО после
    // загрузки серверной копии (до неё «ставки нет» и «настройки не пришли» неразличимы) и
    // ТОЛЬКО админу (у остальных форма read-only, и подстановка была бы ложью на экране).
    expect(PAGE).toContain('savingsRate.value = hint.rate')
    expect(PAGE).toMatch(/if \(mapping\.value\.savings\?\.ratePerHour\) return/)
    expect(PAGE).toMatch(/if \(!isLoaded \|\| !isAdmin\.value\) return/)
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

  it('подсказка честно называет цифру справочной и предлагает свою', () => {
    // Решение владельца (правка от 2026-08-02): значение ПОДСТАВЛЯЕТСЯ в поле, а не только
    // подписывается. Тогда текст обязан сказать, откуда цифра и что её можно заменить.
    expect(hourlyRateHint('RUB')!.text).toContain('открытых источников')
    // Значение подставляется, поэтому текст обязан сказать это прямо и предложить своё —
    // иначе цифра читается как позиция приложения о стоимости чужого сотрудника.
    expect(hourlyRateHint('RUB')!.text).toContain('Подставлен ориентир')
    expect(hourlyRateHint('RUB')!.text).toContain('свою ставку')
  })
})
