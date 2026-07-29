import { describe, expect, it } from 'vitest'
import {
  autoPickSingleCategory,
  buildEntityChoices,
  directionApplies,
  smartProcessByEtid,
  stageApplies,
  type SmartProcessOption
} from '../app/utils/targetOptions'

const SP = (over: Partial<SmartProcessOption> = {}): SmartProcessOption => ({
  entityTypeId: 1044, title: 'Договоры', hasCategories: false, hasStages: true, ...over
})

describe('buildEntityChoices', () => {
  it('#269: на портале без смарт-счетов вариант не предлагается — иначе выбор упадёт при импорте', () => {
    expect(buildEntityChoices([], { smartInvoiceEnabled: false }).some(c => c.id === 31)).toBe(false)
    // По умолчанию (метаданные ещё не загружены) вариант виден — прятать рабочую цель хуже.
    expect(buildEntityChoices([]).some(c => c.id === 31)).toBe(true)
  })

  it('Авто → Лид → Сделка → Смарт-счёт → smart processes BY NAME', () => {
    const choices = buildEntityChoices([SP({ entityTypeId: 1044, title: 'Договоры' }), SP({ entityTypeId: 1050, title: 'Заявки' })])
    expect(choices).toEqual([
      { id: null, label: 'Авто (по правилам)' },
      { id: 1, label: 'Лид' },
      { id: 2, label: 'Сделка' },
      { id: 31, label: 'Смарт-счёт' },
      { id: 1044, label: 'Договоры' },
      { id: 1050, label: 'Заявки' }
    ])
  })
  it('hides «Лид» when leads are disabled (no-leads CRM)', () => {
    expect(buildEntityChoices([], { leadsEnabled: false }).some(c => c.id === 1)).toBe(false)
  })
  it('omits «Авто» when includeAuto is false (settings targets are always concrete)', () => {
    expect(buildEntityChoices([], { includeAuto: false })[0]).toEqual({ id: 1, label: 'Лид' })
  })
})

describe('directionApplies (воронка picker)', () => {
  const byEtid = smartProcessByEtid([SP({ entityTypeId: 1044, hasCategories: false }), SP({ entityTypeId: 1050, hasCategories: true })])
  it('lead → no, deal → yes, smart-invoice → NO (always one direction, hidden)', () => {
    expect(directionApplies(1)).toBe(false)
    expect(directionApplies(2)).toBe(true)
    expect(directionApplies(31)).toBe(false)
  })
  it('smart process → only when it uses categories', () => {
    expect(directionApplies(1044, byEtid.get(1044))).toBe(false)
    expect(directionApplies(1050, byEtid.get(1050))).toBe(true)
    expect(directionApplies(1099, undefined)).toBe(false) // unknown SP → no
  })
  it('null/unknown → no', () => {
    expect(directionApplies(null)).toBe(false)
    expect(directionApplies(7)).toBe(false)
  })
})

describe('stageApplies (стадия picker)', () => {
  const byEtid = smartProcessByEtid([SP({ entityTypeId: 1044, hasStages: true }), SP({ entityTypeId: 1050, hasStages: false })])
  it('lead/deal/smart-invoice → yes', () => {
    expect(stageApplies(1)).toBe(true)
    expect(stageApplies(2)).toBe(true)
    expect(stageApplies(31)).toBe(true)
  })
  it('smart process → only when it uses stages', () => {
    expect(stageApplies(1044, byEtid.get(1044))).toBe(true)
    expect(stageApplies(1050, byEtid.get(1050))).toBe(false)
  })
  it('null → no', () => {
    expect(stageApplies(null)).toBe(false)
  })
})

describe('autoPickSingleCategory (silent category for stage addressing)', () => {
  it('smart-invoice: direction hidden but stages need a category → true', () => {
    expect(autoPickSingleCategory(31)).toBe(true)
  })
  it('category-less SPA that has stages → true (its stage entity id still needs a category)', () => {
    expect(autoPickSingleCategory(1044, { entityTypeId: 1044, title: 'Договоры', hasCategories: false, hasStages: true })).toBe(true)
  })
  it('lead → false (stages address by STATUS, no category)', () => {
    expect(autoPickSingleCategory(1)).toBe(false)
  })
  it('deal → false (direction is shown, user picks it)', () => {
    expect(autoPickSingleCategory(2)).toBe(false)
  })
  it('SPA with categories → false (direction shown)', () => {
    expect(autoPickSingleCategory(1050, { entityTypeId: 1050, title: 'X', hasCategories: true, hasStages: true })).toBe(false)
  })
})
