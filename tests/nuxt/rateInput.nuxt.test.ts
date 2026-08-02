// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { B24InputNumber } from '#components'

// #311. Риск здесь ровно один и он молчаливый: ошибись в имени свойства (`formatOptions` против
// выдуманного `format`), и компонент просто проигнорирует его — поле останется без валюты, тест на
// чистой функции подсказки при этом будет зелёным. Поэтому монтируем НАСТОЯЩИЙ b24ui-компонент с
// теми же свойствами, что стоят на странице настроек.
const OPTIONS = { style: 'currency' as const, currency: 'BYN', currencyDisplay: 'code' as const }

describe('поле ставки часа — валютный формат и сотые (#311)', () => {
  it('показывает код валюты портала прямо в поле', async () => {
    const w = await mountSuspended(B24InputNumber, {
      props: { modelValue: 9.9, step: 0.01, formatOptions: OPTIONS, locale: 'ru' }
    })
    const value = w.find('input').element.value
    expect(value).toContain('BYN')
    // Запятая, а не точка — локаль пришпилена, чтобы поле и подсказка под ним совпадали.
    expect(value).toContain('9,9')
  })

  it('без валюты форматирование не навязывается — число как есть', async () => {
    // Портал без базовой валюты: Intl-формат требует валидный код, выдуманный напечатал бы
    // чужие деньги. Страница в этом случае свойство не передаёт вовсе.
    const w = await mountSuspended(B24InputNumber, {
      props: { modelValue: 9.9, step: 0.01, locale: 'ru' }
    })
    expect(w.find('input').element.value).not.toContain('BYN')
  })
})
