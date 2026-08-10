import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { noticeColor, runNoticeKind } from '../app/utils/importNotice'

/**
 * Цвет полосы с итогом пачки и запрет обрезки строк (#507).
 *
 * Оба дефекта пришли с ЖИВОГО снимка из мобильного приложения, а не из разбора кода, и оба этим
 * характерны: тесты были зелёными, потому что проверяли то, что написано, а не то, что человек
 * видит. Полоса говорила «успешно 0, с ошибкой 1» на ЗЕЛЁНОМ фоне; строки журнала обрезались
 * многоточием ровно на числах, ради которых в журнал и заходят.
 */

const ROOT = new URL('..', import.meta.url).pathname
const template = (p: string) => {
  const src = readFileSync(resolve(ROOT, p), 'utf8')
  const from = src.indexOf('<template>')
  return src.slice(from === -1 ? 0 : from).replace(/<!--[\s\S]*?-->/g, '')
}

describe('#507: цвет итога читает ИСХОД, а не факт завершения', () => {
  it('ни одного успеха — красный, а не зелёный', () => {
    // Несущее утверждение. Ровно этот случай был на снимке владельца: зелёная полоса под словами
    // «успешно 0, с ошибкой 1». Зелёный читается как «всё получилось», и человек уходит с экрана,
    // не заметив, что в CRM не попало НИЧЕГО.
    expect(runNoticeKind({ ok: 0, failed: 1 })).toBe('failed')
    expect(noticeColor('failed')).toBe('air-primary-alert')
  })

  it('часть прошла — жёлтый: записали, но не всё', () => {
    expect(runNoticeKind({ ok: 3, failed: 1 })).toBe('partial')
    expect(noticeColor('partial')).toBe('air-primary-warning')
  })

  it('без отказов — зелёный', () => {
    expect(runNoticeKind({ ok: 5, failed: 0 })).toBe('success')
    expect(noticeColor('success')).toBe('air-primary-success')
  })

  it('порядок проверок: «всё упало» решается ДО «есть отказы»', () => {
    // Обратный порядок даёт жёлтый там, где не прошло ничего, — та же ложь, только тише.
    expect(runNoticeKind({ ok: 0, failed: 7 })).not.toBe('partial')
  })

  it('мусор в числах не превращается в зелёный', () => {
    expect(runNoticeKind({ ok: Number.NaN, failed: 2 })).toBe('failed')
    expect(runNoticeKind({ ok: -3, failed: 2 })).toBe('failed')
  })

  it('отмена — нейтральный цвет, а не отказ', () => {
    // Человек прервал сам; красный читался бы как поломка сервиса.
    expect(noticeColor('cancelled')).toBe('air-secondary')
    expect(noticeColor('running')).toBe('air-primary')
  })

  it('цвет полосы берётся из правила, а не из признака «идёт импорт»', () => {
    // Структурная проверка проводки: чистая функция может быть верной, а вызываться не оттуда —
    // ровно так дефект и жил. В шаблоне не должно остаться условия по `importing`.
    const t = template('app/components/ImportStaging.vue')
    expect(t).toMatch(/:color="noticeColorRole"/)
    expect(t, 'цвет не должен зависеть от одного лишь признака «идёт импорт»').not.toMatch(/:color="importing \?/)
  })

  it('текст сообщения нельзя поставить без вида', () => {
    // `setNotice` — единственная точка записи. Прямое присваивание вернуло бы дефект: вид остался
    // бы прежним, а текст сменился, и полоса снова врала бы цветом.
    const src = readFileSync(resolve(ROOT, 'app/components/ImportStaging.vue'), 'utf8')
    const script = src.slice(0, src.indexOf('<template>'))
    const direct = script.match(/notice\.value\s*=/g) ?? []
    // Одно присваивание законно — внутри самого `setNotice`.
    expect(direct.length, 'текст сообщения ставится только через setNotice').toBeLessThanOrEqual(1)
  })
})

describe('#507: строки не обрезаются в никуда', () => {
  // Действующее правило проекта: «длинные имена файлов переносятся, а не обрезаются в никуда».
  // На телефоне обрезалось название поставщика и число позиций — то есть содержимое, а не
  // оформление, и развернуть строку было нечем.
  for (const page of ['app/components/ImportJournal.vue', 'app/components/ImportJobItem.vue']) {
    it(`${page}: без truncate`, () => {
      expect(template(page), 'обрезка возвращает многоточие вместо содержимого').not.toMatch(/\btruncate\b/)
    })

    it(`${page}: длинное слово без пробелов переносится`, () => {
      // Без `break-words` склеенное название или номер документа распирает строку и возвращает
      // горизонтальную прокрутку, которой в мобильном экране быть не должно.
      expect(template(page)).toMatch(/\bbreak-words\b/)
    })
  }
})

describe('#507: баннер издателя не загораживает работу', () => {
  it('врезка стоит ВНУТРИ ленты, а не над ней', () => {
    const t = template('app/pages/app.vue')
    expect(t, 'баннер отдаётся журналу слотом').toMatch(/<template #promo>[\s\S]{0,200}<SelfHostedPromo/)
    // Отдельного баннера над лентой быть не должно — иначе он снова окажется выше журнала.
    const promoCount = (t.match(/<SelfHostedPromo/g) ?? []).length
    expect(promoCount, 'баннер ровно один').toBe(1)
  })

  it('журнал вставляет врезку после записи, а не вместо неё', () => {
    const t = template('app/components/ImportJournal.vue')
    expect(t).toMatch(/\$slots\.promo/)
    expect(t).toMatch(/PROMO_AFTER_ROW/)
  })

  it('карточка экономии скрыта в мобильном приложении условным рендером', () => {
    // ⚠ Именно `v-if`, а не скрытие по ширине: спрятанное CSS-ом остаётся в дереве и читается
    // программой чтения — правило проекта.
    const t = template('app/pages/app.vue')
    const at = t.indexOf('Сэкономлено времени')
    expect(at).toBeGreaterThan(-1)
    expect(t.slice(Math.max(0, at - 900), at)).toMatch(/v-if="!isBitrixMobile"/)
  })
})
