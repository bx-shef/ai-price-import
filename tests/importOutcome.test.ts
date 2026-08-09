import { describe, expect, it } from 'vitest'
import { ON_MISSING_ITEMS, ON_MISSING_LABEL } from '../app/config/onMissing'
import { allLinesSkippedError, lineSkippedWarning, MAX_OUTCOME_TEXT, noLinesMatchedWarning, skippedLinesAdvice } from '../app/utils/importOutcome'
import { MAX_CHAT_REASON, buildSuccessMessage } from '../server/utils/chatNotify'
import { MAX_ACTIVITY_PROBLEMS, buildActivityBody } from '../server/utils/todoActivity'

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

  // ⚠ Утверждение ПЕРЕВЁРНУТО по замечанию владельца с живого портала. Прежде текст обещал, что
  // «запись в CRM не создана», и тест это закреплял. С #459 карточка создаётся ВСЕГДА, включая
  // неудачную загрузку (без неё у дела нет владельца, а без дела импорт не попадает в журнал), —
  // то есть сообщение отправляло человека искать в воронке отсутствие того, что там лежит.
  // Утверждение об отсутствии записи опаснее умолчания: по нему не идут проверять.
  it('НЕ утверждает, что записи нет, и называет её пустой', () => {
    const t = allLinesSkippedError(3)
    expect(t).not.toMatch(/не создан/i)
    expect(t).toMatch(/карточка создана пустой/i)
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

describe('#388/#328: совет в теле дела', () => {
  const many = Array.from({ length: 20 }, (_, i) => lineSkippedWarning(`Товар ${i + 1}`))
  const body = (warnings: string[], advice?: string) => buildActivityBody({
    supplierName: 'ООО Ромашка', rowCount: 3, warnings, advice, entityPath: '/crm/deal/details/5/'
  })

  it('совет доезжает до дела и стоит ПОСЛЕ проблем', () => {
    // Мутация «убрать совет» проходила при всех зелёных тестах: сборка жила в проводке, куда
    // тесты не доставали.
    const text = body(many, skippedLinesAdvice())
    expect(text).toContain(skippedLinesAdvice())
    expect(text.indexOf(skippedLinesAdvice())).toBeGreaterThan(text.indexOf('Проблемы ('))
  })

  it('совет — ПОДПИСАННЫЙ блок, а не голая строка в хвосте', () => {
    // Ровно этого не хватало на витрине: без подписи совет никто не замечал (#328).
    expect(body(many, skippedLinesAdvice())).toContain(`[B]Что сделать:[/B] ${skippedLinesAdvice()}`)
  })

  it('совета нет → блока «Что сделать» нет вовсе', () => {
    // Пустой блок обещал бы указание и не давал его.
    expect(body(many)).not.toContain('Что сделать')
  })

  it('совет НЕ внутри списка проблем и не считается проблемой', () => {
    const text = body(many, skippedLinesAdvice())
    expect(text).toContain(`[B]Проблемы (${many.length}):[/B]`)
    const list = text.slice(text.indexOf('[LIST]'), text.indexOf('[/LIST]'))
    expect(list.includes(skippedLinesAdvice())).toBe(false)
  })

  it('счётчик проблем — ПОЛНОЕ число, даже когда показаны не все', () => {
    // Печатать длину среза значило бы сообщить, что проблем меньше, чем есть.
    const text = body(many)
    expect(text).toContain(`[B]Проблемы (${many.length}):[/B]`)
    expect(text.split('[*]').length - 1).toBe(MAX_ACTIVITY_PROBLEMS)
    expect(text).toContain(`Показаны первые ${MAX_ACTIVITY_PROBLEMS}`)
  })
})

describe('noLinesMatchedWarning: самый тихий исход', () => {
  it('обе редакции влезают в предел чата', () => {
    // ⚠ Пин длины обязателен, как у соседей: чат режет строку, а запас у этого текста всего
    // несколько знаков — следующая правка формулировки обрезала бы его МОЛЧА, и человек прочитал
    // бы полфразы про то, что каталог не использовался.
    for (const configured of [true, false]) {
      expect(noLinesMatchedWarning(configured).length, `field=${configured}`).toBeLessThanOrEqual(MAX_OUTCOME_TEXT)
    }
  })

  it('причина названа УСЛОВНО и разная у двух состояний настройки', () => {
    // ⚠ Со стороны воркера две ситуации неразличимы: поле не выбрано либо выбрано верно, а
    // артикулов нет в самом документе. Утверждать первое означало бы гнать админа править
    // настройку, которая может быть в порядке.
    const noField = noLinesMatchedWarning(false)
    const withField = noLinesMatchedWarning(true)
    expect(noField).not.toBe(withField)
    expect(noField).toContain('не выбрано поле')
    expect(withField).toContain('нет колонки с артикулом')
    for (const t of [noField, withField]) expect(t).toContain('Скорее всего')
  })

  it('говорит, что строки ВНЕСЕНЫ, а не пропущены', () => {
    // ⚠ Отличие от `skippedLinesAdvice`: там строк в записи НЕТ и человек видит это по короткому
    // документу; здесь записаны все до единой, и заметить нечего — поэтому текст обязан сказать
    // именно про связь с каталогом, а не про пропуск.
    for (const t of [noLinesMatchedWarning(true), noLinesMatchedWarning(false)]) {
      expect(t).toContain('внесены как есть')
      expect(t).not.toContain('пропущен')
    }
  })
})
