import { describe, expect, it } from 'vitest'
import { appScreenState } from '../app/utils/appScreenState'

describe('appScreenState (#256)', () => {
  it('пока исход загрузки настроек неизвестен — только состояние загрузки', () => {
    // Главный инвариант: до резолва НИКОГДА не показываем ни работу, ни баннер. Именно нарушение
    // этого правила давало мелькание: рабочий экран рисовался, а через мгновение схлопывался.
    expect(appScreenState({ settingsResolved: false, needsSetup: false })).toBe('loading')
    expect(appScreenState({ settingsResolved: false, needsSetup: true })).toBe('loading')
  })

  it('настройки прочитаны и дефолтные → баннер «сначала настройте»', () => {
    expect(appScreenState({ settingsResolved: true, needsSetup: true })).toBe('setup')
  })

  it('настройки прочитаны и заданы → рабочий экран', () => {
    expect(appScreenState({ settingsResolved: true, needsSetup: false })).toBe('work')
  })

  it('состояния взаимоисключающие — двух блоков на экране одновременно не бывает', () => {
    const all = [false, true].flatMap(settingsResolved =>
      [false, true].map(needsSetup => appScreenState({ settingsResolved, needsSetup })))
    for (const s of all) expect(['loading', 'setup', 'work']).toContain(s)
  })
})
