import { describe, expect, it } from 'vitest'
import { adoptDefaultTarget } from '../app/utils/settingsAdopt'
import type { TargetRef } from '~/types/mapping'

// #443. Событие «настройки изменились» широковещательное: админ поменял цель по умолчанию — оно
// прилетает ВСЕМ сотрудникам портала. У каждого на экране может быть свой выбор направления,
// запомненный на вкладку (#349), и вопрос «кто побеждает» решается правилом, а не порядком вызовов.

const deal = { entityTypeId: 2, categoryId: 7 } as TargetRef

describe('#443: цель вкладки при смене настроек портала', () => {
  it('новое значение из настроек ПОБЕЖДАЕТ прежний выбор вкладки', () => {
    // Решение владельца: память заводилась ради удобства («не выбирать направление на каждую
    // пачку»), а не ради того, чтобы пережить смену настройки портала.
    expect(adoptDefaultTarget({ importing: false, defaultTarget: deal }))
      .toEqual({ apply: true, target: deal })
  })

  it('«Авто (по правилам)» — тоже значение: память очищается', () => {
    // ⚠ Иначе настройку невозможно ОТКАТИТЬ: прежний выбор пережил бы любое изменение, и это
    // выглядело бы как «настройки не применяются».
    expect(adoptDefaultTarget({ importing: false, defaultTarget: null }))
      .toEqual({ apply: true, target: null })
    expect(adoptDefaultTarget({ importing: false, defaultTarget: undefined }))
      .toEqual({ apply: true, target: null })
  })

  it('идущая пачка НЕ затрагивается', () => {
    // ⚠ Обязательное, а не желательное: задания уже приняты сервером, и их поведение определяется
    // настройками НА МОМЕНТ ПОСТАНОВКИ. Подменить цель в интерфейсе посреди пачки значило бы
    // показать человеку не то, куда на самом деле уедут его документы.
    expect(adoptDefaultTarget({ importing: true, defaultTarget: deal }))
      .toEqual({ apply: false, reason: 'importing' })
    // И «Авто» посреди пачки тоже не применяется — ветка одна на любое новое значение.
    expect(adoptDefaultTarget({ importing: true, defaultTarget: null }))
      .toEqual({ apply: false, reason: 'importing' })
  })

  it('негодная цель читается как «Авто», а не оставляет прежний выбор', () => {
    // Признак «цель задана» — положительный тип сущности. Молча оставить прежний выбор при мусоре
    // значило бы залипнуть на нём навсегда.
    for (const bad of [{ entityTypeId: 0 }, { entityTypeId: -2 }, {} as TargetRef]) {
      expect(adoptDefaultTarget({ importing: false, defaultTarget: bad as TargetRef }), JSON.stringify(bad))
        .toEqual({ apply: true, target: null })
    }
  })
})
