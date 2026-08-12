import { describe, expect, it } from 'vitest'
import { targetInvalidMessage, targetInvalidReason } from '../app/utils/targetValidity'

// #488. Выбор «Куда» принадлежит сотруднику: правила маршрутизации админа применяются ТОЛЬКО к тем,
// у кого стоит «Авто». Значит единственная законная причина сменить выбранную цель — она перестала
// существовать, и тогда смена объявляется человеку.

describe('#488: годность выбранного маршрута', () => {
  it('«Авто» проверять нечего', () => {
    expect(targetInvalidReason({ entityTypeId: null }, { entityIds: [2], categoryIds: [], stageIds: [] })).toBeNull()
  })

  it('годный маршрут негодным не объявляется', () => {
    expect(targetInvalidReason(
      { entityTypeId: 2, categoryId: 7, stageId: 'C7:NEW' },
      { entityIds: [1, 2, 31], categoryIds: [0, 7], stageIds: ['C7:NEW', 'C7:WON'] }
    )).toBeNull()
  })

  it('исчезнувшие сущность / направление / стадия распознаются по отдельности', () => {
    expect(targetInvalidReason({ entityTypeId: 31 }, { entityIds: [1, 2], categoryIds: undefined, stageIds: undefined })).toBe('entity')
    expect(targetInvalidReason({ entityTypeId: 2, categoryId: 9 }, { entityIds: undefined, categoryIds: [0, 7], stageIds: undefined })).toBe('category')
    expect(targetInvalidReason({ entityTypeId: 2, stageId: 'C9:NEW' }, { entityIds: undefined, categoryIds: undefined, stageIds: ['C7:NEW'] })).toBe('stage')
  })

  it('НЕЗАГРУЖЕННОЕ не читается как «не существует»', () => {
    // ⚠ Самая дорогая ошибка этой функции, и она несимметрична: ложная тревога уводит человека в
    // «Авто» на ровном месте при исправном маршруте, а задержка проверки не стоит ничего. На
    // медленной сети иначе каждое открытие экрана сбрасывало бы выбор.
    expect(targetInvalidReason(
      { entityTypeId: 31, categoryId: 7, stageId: 'C7:NEW' },
      { entityIds: undefined, categoryIds: undefined, stageIds: undefined }
    )).toBeNull()
  })

  it('пустой список направлений — законное состояние, а не поломка', () => {
    // У лида направлений нет вовсе. Негодным делает ОТСУТСТВИЕ выбранного значения в загруженном
    // списке, а не пустота списка: маршрут без направления пустым списком не опровергается.
    expect(targetInvalidReason({ entityTypeId: 1 }, { entityIds: [1, 2], categoryIds: [], stageIds: undefined })).toBeNull()
    // А вот выбранное направление при пустом списке — уже противоречие.
    expect(targetInvalidReason({ entityTypeId: 1, categoryId: 3 }, { entityIds: [1, 2], categoryIds: [], stageIds: undefined })).toBe('category')
  })

  it('у каждой причины свой текст, и он говорит, что теперь будет', () => {
    const texts = (['entity', 'category', 'stage'] as const).map(r => targetInvalidMessage(r))
    expect(new Set(texts).size, 'причины пересказаны одним текстом — человек не поймёт, что именно пропало').toBe(3)
    for (const t of texts) expect(t).toContain('Авто')
  })

  it('в настройках текст НЕ обещает переключения на «Авто» — там цель сохраняется (#500)', () => {
    // ⚠ Прежде текст был один на оба экрана и в настройках врал: цель по #492 сохраняется, а
    // сообщение уверяло, что импорт переключён на «Авто». Соврать человеку о том, что записано в
    // правиле, хуже, чем промолчать: он не пойдёт чинить то, что считает уже почининым.
    for (const r of ['entity', 'category', 'stage'] as const) {
      const t = targetInvalidMessage(r, false)
      expect(t, `«${r}»: в настройках «Авто» не обещаем`).not.toContain('Авто')
      expect(t, 'следующий шаг обязан быть назван').toContain('сохраните настройки')
    }
  })
})
