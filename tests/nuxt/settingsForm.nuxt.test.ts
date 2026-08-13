// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import SettingsForm from '~/components/SettingsForm.vue'
import { defaultMapping } from '~/utils/portalSettings'
import type { PortalMapping } from '~/types/mapping'

/**
 * Построчные редакторы формы настроек пересеваются при КАЖДОЙ новой копии настроек (#523).
 *
 * ЗАЧЕМ ПОВЕДЕНИЕМ, А НЕ ТЕКСТОМ. Словарь единиц и правила маршрутизации редактируются строками, и
 * строки засеиваются ИЗ настроек, а дальше сами являются источником правды (связь односторонняя,
 * иначе петля). У пересева поэтому должен быть повод, и повод — «пришли другие настройки».
 *
 * Разбирая экран на оболочку и форму, этот механизм было очень легко сломать МОЛЧА: пересев звала
 * страница после `load()`, а форма живёт под `ScreenState` и до прихода настроек вообще не
 * смонтирована — вызов уходил бы в `null`, и редактор словаря оставался пустым при непустом
 * словаре в портале. Ни один структурный гард такого не видит: разметка корректна, типы сходятся.
 *
 * ⚠ Механизм опирается на факт ИЗ ДРУГОГО ФАЙЛА: `useSettings.load()`/`save()` ЗАМЕНЯЮТ объект
 * настроек (`mapping.value = res.mapping`), а не правят его на месте. Начни они мутировать — пересев
 * тихо перестанет происходить. Второй тест ниже фиксирует ровно это: замена объекта пересевает,
 * правка того же объекта — нет.
 */

mockNuxtImport('useCatalogProperties', () => () => ({ fetcher: async () => [] }))
mockNuxtImport('useChatSearch', () => () => ({ fetcher: async () => [] }))
mockNuxtImport('useCatalogMeasures', () => () => ({ measures: ref([]), load: async () => {} }))

function withUnits(unit: string, code: number): PortalMapping {
  const m = defaultMapping()
  m.units.dictionary = { [unit]: code }
  return m
}

const PROPS = {
  loaded: true,
  isAdmin: true,
  baseCurrency: null,
  currencyUnknown: false,
  inPortal: true,
  error: '',
  portalDomain: ''
}

/** Значения полей «единица из документа» — по ним видно, что засеяно в редакторе. */
function unitInputs(w: { findAll: (s: string) => Array<{ element: HTMLInputElement }> }): string[] {
  return w.findAll('input')
    .map(i => i.element)
    .filter(el => (el.getAttribute('aria-label') || '').startsWith('Единица'))
    .map(el => el.value)
}

describe('#523: форма настроек сеет строки сама', () => {
  it('редактор словаря показывает сохранённые единицы сразу после монтирования', async () => {
    // Прежде посев звала страница; форма монтируется ПОЗЖЕ прихода настроек, и такой вызов
    // уходил бы в никуда — при непустом словаре в портале редактор оставался бы пустым.
    const w = await mountSuspended(SettingsForm, { props: { ...PROPS, modelValue: withUnits('коробка', 796) } })
    expect(unitInputs(w)).toEqual(['коробка'])
  })

  it('пришла НОВАЯ копия настроек — строки пересеяны (это и делает «Отмену» отменой)', async () => {
    const w = await mountSuspended(SettingsForm, { props: { ...PROPS, modelValue: withUnits('коробка', 796) } })
    expect(unitInputs(w)).toEqual(['коробка'])
    // `load()` на «Отмене» заменяет объект настроек — форма обязана показать серверную копию, а не
    // правки, от которых человек только что отказался.
    await w.setProps({ modelValue: withUnits('ящик', 796) })
    expect(unitInputs(w)).toEqual(['ящик'])
  })

  it('правка ТОГО ЖЕ объекта строки не пересевает — иначе редактор дрался бы сам с собой', async () => {
    // Связь односторонняя: строки пишут в настройки. Если бы пересев ловил и это, каждая буква,
    // набранная в поле, возвращалась бы обратно в поле — с потерей фокуса и позиции курсора.
    const mapping = withUnits('коробка', 796)
    const w = await mountSuspended(SettingsForm, { props: { ...PROPS, modelValue: mapping } })
    mapping.units.dictionary = { ящик: 796 }
    await w.vm.$nextTick()
    expect(unitInputs(w)).toEqual(['коробка'])
  })
})
