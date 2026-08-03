import { describe, expect, it } from 'vitest'
import { ON_MISSING_ITEMS, ON_MISSING_LABEL } from '../app/config/onMissing'
import { allLinesSkippedError, lineSkippedWarning, MAX_OUTCOME_TEXT, skippedLinesAdvice } from '../app/utils/importOutcome'
import { MAX_CHAT_REASON } from '../server/utils/chatNotify'

describe('#373: текст исхода «ни одна позиция не перенесена»', () => {
  it('доезжает до чата целиком — это контракт, а не стиль', () => {
    // Замечание ревью: первая версия была 380 знаков, а чат режет строку на MAX_CHAT_REASON. В
    // сообщение попадало «…Запись в CRM не создана, потому что в н» — обрыв на полуслове ровно
    // перед обеими полезными частями. Проверяем на «широком» числе позиций: длина текста от него
    // зависит, и правка, укладывающаяся при 5 позициях, может не уложиться при 1000.
    for (const n of [1, 2, 5, 99, 1000]) {
      expect(allLinesSkippedError(n).length, `${n} позиций`).toBeLessThanOrEqual(MAX_OUTCOME_TEXT)
    }
  })

  it('предел совпадает с настоящим пределом чата', () => {
    // Число продублировано (app/ не зависит от server/) — значит расхождение возможно, и его надо
    // ловить здесь, а не в чате у клиента.
    expect(MAX_OUTCOME_TEXT).toBe(MAX_CHAT_REASON)
  })

  it('открывается тем же «Импорт остановлен:», что и остальные жёсткие отказы', () => {
    // Это маркер, по которому в чате видно разницу между отказом и предупреждением.
    expect(allLinesSkippedError(3).startsWith('Импорт остановлен:')).toBe(true)
  })

  it('говорит, что записи в CRM нет — иначе её пойдут искать в воронке', () => {
    expect(allLinesSkippedError(3)).toMatch(/запись в CRM не создана/i)
  })

  it('первым советует проверить поле поиска, а не заводить товары', () => {
    // Исход случается на НЕнастроенном портале, где свойство артикула пустое: товары в каталоге
    // вполне могут лежать, просто искали не по тому полю. «Заведите товары» первым — лишняя работа.
    const t = allLinesSkippedError(4)
    expect(t).toMatch(/поле поиска товара/i)
    expect(t.indexOf('поле поиска')).toBeLessThan(t.length)
  })

  it('цитирует пункт настроек ровно так, как он назван в интерфейсе', () => {
    // Прежний текст звал его «Внести как произвольную позицию» — пункта с таким названием нет, и
    // бухгалтер искал в списке несуществующую строку.
    expect(allLinesSkippedError(4)).toContain(ON_MISSING_LABEL.freeform)
    expect(skippedLinesAdvice()).toContain(ON_MISSING_LABEL.freeform)
    expect(allLinesSkippedError(4)).not.toMatch(/произвольную позицию/i)
  })

  it('построчная строка НЕ повторяет совет — иначе карточка превращается в простыню', () => {
    // Живой прогон 2026-08-02: документ из трёх позиций дал красную строку отказа с советом и три
    // одинаковых абзаца с тем же советом — четыре повтора одной фразы в 45 знаков подряд. Названия
    // товаров, ради которых блок и существует, в этих повторах тонули.
    const w = lineSkippedWarning('Гвоздь')
    expect(w).not.toContain(ON_MISSING_LABEL.freeform)
    expect(w).not.toMatch(/настройк/i)
    expect(w).toContain('Гвоздь')
  })

  it('число позиций печатается по-русски', () => {
    // «ни одна из 1 позиции» — сорная фраза, у документа с одной строкой она же и единственная.
    expect(allLinesSkippedError(1)).toContain('единственная позиция не найдена')
    expect(allLinesSkippedError(2)).toContain('ни одна из 2 позиций')
    expect(allLinesSkippedError(5)).toContain('ни одна из 5 позиций')
  })

  it('мусорное число не печатается как есть', () => {
    // Число приходит из длины массива, но текст уходит человеку в чат — дробь или минус в нём
    // читались бы как поломка приложения.
    expect(allLinesSkippedError(-4)).toContain('ни одна из 0 позиций')
    expect(allLinesSkippedError(2.7)).toContain('ни одна из 2 позиций')
  })

  it('построчное предупреждение называет сам товар', () => {
    expect(lineSkippedWarning('Гвоздь 3×70')).toContain('Гвоздь 3×70')
    expect(lineSkippedWarning('Гвоздь')).toMatch(/строка пропущена/i)
  })
})

describe('#373: список вариантов настройки', () => {
  it('дефолт стоит первым — первый пункт читается как дефолт', () => {
    expect(ON_MISSING_ITEMS[0]!.value).toBe('freeform')
  })

  it('подписи и значения не разъезжаются', () => {
    expect(ON_MISSING_ITEMS.map(i => i.value).sort()).toEqual(['freeform', 'skip-warn'])
    for (const item of ON_MISSING_ITEMS) {
      expect(item.label).toBe(ON_MISSING_LABEL[item.value])
    }
  })
})
