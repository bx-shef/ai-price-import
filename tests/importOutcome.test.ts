import { describe, expect, it } from 'vitest'
import { ON_MISSING_ITEMS, ON_MISSING_LABEL } from '../app/config/onMissing'
import { allLinesSkippedError, lineSkippedWarning, MAX_OUTCOME_TEXT, skippedLinesAdvice } from '../app/utils/importOutcome'
import { MAX_CHAT_REASON, buildSuccessMessage } from '../server/utils/chatNotify'
import { MAX_ACTIVITY_BLOCKS, buildActivityLines } from '../server/utils/configurableActivity'

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

  it('совет тоже доезжает целиком — он идёт тем же путём', () => {
    // Выжившая мутация из разбора: длина проверялась только у текста отказа, а совет уходит в тот
    // же чат через ту же обрезку. Регрессия #373 воспроизводима на нём один в один.
    expect(skippedLinesAdvice().length).toBeLessThanOrEqual(MAX_OUTCOME_TEXT)
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

describe('#388: совет — подсказка, а не проблема', () => {
  it('не попадает в список предупреждений и не считается в нём', () => {
    // Симптом: документ с тремя пропущенными строками показывал «Проблемы (4)» — совет лежал в том
    // же массиве и раздувал счётчик, а человеку подавался как четвёртая поломка документа.
    const warnings = [1, 2, 3].map(i => lineSkippedWarning(`Товар ${i}`))
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 5, created: true, rowCount: 3, warnings, advice: skippedLinesAdvice() })
    expect(msg).toContain('Предупреждения (3):')
    expect(msg).not.toContain('Предупреждения (4):')
    expect(msg).toContain(skippedLinesAdvice())
  })

  it('переживает обрезку списка — от неё он и переехал', () => {
    // Прежде совет стоял ПЕРВЫМ в списке именно потому, что потребители режут его с начала (чат по
    // десяти, дело по шести): в хвосте он терялся тем вернее, чем больше строк пропущено, то есть
    // ровно там, где нужнее. Отдельное поле снимает вопрос — проверяем на 12 строках.
    const warnings = Array.from({ length: 12 }, (_, i) => lineSkippedWarning(`Товар ${i + 1}`))
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 5, created: true, rowCount: 12, warnings, advice: skippedLinesAdvice() })
    expect(msg).toContain('Предупреждения (12):')
    expect(msg).toContain(skippedLinesAdvice())
    // И ровно один раз: дубль вернул бы простыню повторов, ради которой совет и убирали из строк.
    expect(msg.split(skippedLinesAdvice()).length - 1).toBe(1)
  })

  it('открывается словами «Что делать» — роль читается раньше цвета', () => {
    // В чате и в деле таймлайна цвета нет вообще: там совет стоит вплотную к списку проблем и без
    // лид-ина прочитается как его продолжение. На экране цвет есть, но это полоса в 3 px — при
    // цветовой слепоте и в чёрно-белом скриншоте подсказка снова неотличима от дефекта.
    expect(skippedLinesAdvice().startsWith('Что делать:')).toBe(true)
  })

  it('без пропущенных строк совета нет вовсе', () => {
    const msg = buildSuccessMessage({ entityTypeId: 2, entityId: 5, created: true, rowCount: 2, warnings: [] })
    expect(msg).not.toMatch(/настройк/i)
  })
})

describe('#388: бюджет строк в деле таймлайна', () => {
  const many = Array.from({ length: 20 }, (_, i) => lineSkippedWarning(`Товар ${i + 1}`))

  it('совет доезжает до дела и стоит ПОСЛЕ проблем', () => {
    // Мутация «убрать совет из строк дела» проходила при всех зелёных тестах: сборка жила в
    // проводке, куда тесты не доставали.
    const lines = buildActivityLines({ rowCount: 3, supplierName: 'ООО Ромашка', warnings: many, advice: skippedLinesAdvice() })
    expect(lines).toContain(skippedLinesAdvice())
    expect(lines.at(-1)).toBe(skippedLinesAdvice())
    expect(lines.length).toBeLessThanOrEqual(MAX_ACTIVITY_BLOCKS)
  })

  it('совет НЕ внутри обрезаемого списка проблем — это состояние до #388', () => {
    const lines = buildActivityLines({ rowCount: 3, warnings: many, advice: skippedLinesAdvice() })
    const problemsHeader = lines.findIndex(l => l.startsWith('Проблемы ('))
    expect(problemsHeader).toBeGreaterThanOrEqual(0)
    // Счётчик считает ТОЛЬКО настоящие проблемы — совет в него не входит.
    expect(lines[problemsHeader]).toBe(`Проблемы (${many.length}):`)
    // И ни одна строка списка не является советом.
    expect(lines.slice(problemsHeader + 1, -1).some(l => l.includes(skippedLinesAdvice()))).toBe(false)
  })

  it('без совета освободившееся место отдаётся предупреждениям', () => {
    const withAdvice = buildActivityLines({ rowCount: 3, warnings: many, advice: skippedLinesAdvice() })
    const without = buildActivityLines({ rowCount: 3, warnings: many })
    expect(without.length).toBe(MAX_ACTIVITY_BLOCKS)
    expect(without.length).toBe(withAdvice.length)
  })

  it('шапка + предупреждения + совет укладываются в предел блоков', () => {
    // Совет стоит ПОСЛЕДНИМ, а тело дела режется по MAX_ACTIVITY_BLOCKS. С прежним «первые шесть
    // предупреждений» сумма выходила ровно в предел, без запаса: одна новая строка шапки или кап
    // «семь вместо шести» молча выбрасывали бы совет — то есть возвращали дефект #388 в том
    // потребителе, ради которого его и заводили. Считаем худший случай числом.
    for (const supplier of [true, false]) {
      const header = 1 + (supplier ? 1 : 0)
      const budget = Math.max(0, MAX_ACTIVITY_BLOCKS - (2 + (supplier ? 1 : 0)) - 1)
      const total = header + 1 + budget + 1 // шапка + «Проблемы (N):» + предупреждения + совет
      expect(total, `поставщик: ${supplier}`).toBeLessThanOrEqual(MAX_ACTIVITY_BLOCKS)
      expect(budget, 'предупреждений не осталось вовсе').toBeGreaterThan(0)
    }
  })
})
