import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { activityOutcome, parseActivityBody } from '../app/utils/activityBody'
import { buildActivityBody } from '../server/utils/todoActivity'
import { JOURNAL_PAGE_SIZE as CLIENT_PAGE } from '../app/config/journal'
import { JOURNAL_PAGE_SIZE as SERVER_PAGE } from '../server/utils/importJournal'

// #495. Результат импорта в журнале берётся ИЗ ДЕЛА: это единственный способ показать те же числа,
// что человек видит в карточке портала. Раньше «результат» жил в статусе задания — другом
// хранилище с другим сроком жизни, — и совпасть с делом не мог по построению.

describe('#495: разбор тела дела', () => {
  // ⚠ Разбор прогоняется по РЕАЛЬНОМУ выводу билдера, а не по выдуманной строке. Иначе правка
  // билдера тихо ломала бы журнал: обе стороны наш код, и связь между ними держится этим тестом.
  const body = (over: Partial<Parameters<typeof buildActivityBody>[0]> = {}) => buildActivityBody({
    supplierName: 'ООО «Ромашка»',
    companyId: 42,
    rowCount: 14,
    matchedCount: 9,
    amountLabel: '1 200,00 BYN',
    warnings: [],
    entityPath: '/crm/deal/details/341/',
    entityLinkLabel: 'Открыть сделку',
    advice: '',
    ...over
  })

  it('поставщик, позиции, сопоставленные и сумма читаются обратно', () => {
    expect(parseActivityBody(body())).toMatchObject({
      supplier: 'ООО «Ромашка»', rows: 14, matched: 9, amount: '1 200,00 BYN'
    })
  })

  it('ссылка ведёт на КАРТОЧКУ, а не на компанию поставщика', () => {
    // ⚠ Первой в теле идёт ссылка на компанию. Взяв «первую попавшуюся», журнал вёл бы «Открыть
    // карточку» на контрагента — ссылка выглядит рабочей и открывает не то.
    expect(parseActivityBody(body()).entityPath).toBe('/crm/deal/details/341/')
  })

  it('число проблем — ПОЛНОЕ, даже когда показаны не все', () => {
    const many = Array.from({ length: 12 }, (_, i) => `замечание ${i + 1}`)
    expect(parseActivityBody(body({ warnings: many })).problems).toBe(12)
  })

  it('чужой абсолютный адрес в ссылке отбрасывается', () => {
    // Дело мог править человек в портале; открывать наружу под нашей подписью нельзя.
    const evil = '[B]Сделка:[/B] [URL=https://evil.example/]Открыть[/URL]'
    expect(parseActivityBody(evil).entityPath).toBeUndefined()
  })

  it('пустое и не-строка не роняют разбор и ничего не выдумывают', () => {
    for (const bad of ['', null, undefined, 42, {}]) expect(parseActivityBody(bad)).toEqual({})
    // Заглушка билдера «не указан» не должна доезжать до экрана как имя поставщика.
    expect(parseActivityBody(body({ supplierName: '', companyId: 0 })).supplier).toBeUndefined()
  })
})

describe('#495: исход по цвету САМОГО дела', () => {
  it('зелёный / розовый / всё остальное — три разных исхода', () => {
    expect(activityOutcome('4')).toBe('clean')
    expect(activityOutcome('7')).toBe('issues')
    // ⚠ Неизвестный цвет НЕ «успех»: жёлтый у портала вообще не имеет цифрового кода, а дело могли
    // перекрасить руками. Выдавать это за успех значило бы утверждать непроверенное о чужом
    // документе — ровно та ошибка, которую чинит вся задача.
    for (const c of ['', '1', 'жёлтый', null, undefined, 4]) expect(activityOutcome(c), String(c)).toBe('unknown')
  })

  it('цвета совпадают с теми, что приложение ставит делу', () => {
    // Иначе журнал и карточка разошлись бы при первой же правке словаря цветов.
    const src = readFileSync(resolve(import.meta.dirname, '..', 'server/utils/todoActivity.ts'), 'utf8')
    expect(src).toMatch(/TODO_COLOR_CLEAN\s*=\s*'4'/)
    expect(src).toMatch(/TODO_COLOR_ISSUES\s*=\s*'7'/)
  })
})

describe('#495: размер страницы журнала — одно число', () => {
  it('клиент и сервер считают страницу одинаково', () => {
    // ⚠ Разъехавшись, они дали бы перескок записей: клиент считает смещение по своему размеру,
    // сервер отдаёт по своему. Ошибка тем заметнее, чем длиннее журнал, и невидима на первой
    // странице — то есть проявилась бы у клиента, а не у нас.
    expect(CLIENT_PAGE).toBe(SERVER_PAGE)
  })
})
