// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { B24InputNumber } from '#components'
import { hourlyRateHint } from '~/utils/savings'

// #311. Риск здесь ровно один и он молчаливый: ошибись в имени свойства (`formatOptions` против
// выдуманного `format`), и компонент просто проигнорирует его — поле останется без валюты, тест на
// чистой функции подсказки при этом будет зелёным. Поэтому монтируем НАСТОЯЩИЙ b24ui-компонент с
// теми же свойствами, что стоят на странице настроек.
const OPTIONS = {
  style: 'currency' as const,
  currency: 'BYN',
  currencyDisplay: 'code' as const,
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
}

describe('поле ставки часа — валютный формат и сотые (#311)', () => {
  it('показывает код валюты портала прямо в поле', async () => {
    const w = await mountSuspended(B24InputNumber, {
      props: { modelValue: 9.9, step: 0.01, formatOptions: OPTIONS, locale: 'ru' }
    })
    const value = w.find('input').element.value
    expect(value).toContain('BYN')
    // Запятая, а не точка — локаль пришпилена, чтобы поле и подсказка под ним совпадали.
    // Проверяем ТОЧНО «9,9», а не «содержит»: замечание ревью — валютный формат по умолчанию
    // печатал «9,90» под подсказкой «9,9», и `toContain` этого не различал.
    expect(value).toMatch(/(^|\D)9,9(\D|$)/)
    expect(value).not.toContain('9,90')
    // И то же число, что показывает подсказка под полем — единственная проверка, которая
    // действительно ловит расхождение двух форматов.
    expect(value).toContain(hourlyRateHint('BYN')!.rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 }))
  })

  it('поле и подсказка разделяют разряды одинаково (KZT — тысячи)', async () => {
    // Ради этого и пришпилена локаль. На BYN расхождение не видно (нет разряда тысяч), а
    // казахстанская ставка 1440 печатается с неразрывным пробелом — если бы поле осталось на
    // локали браузера, под полем «1 440» стояло бы «1,440».
    const w = await mountSuspended(B24InputNumber, {
      props: {
        modelValue: 1440,
        step: 0.01,
        locale: 'ru',
        formatOptions: { ...OPTIONS, currency: 'KZT' }
      }
    })
    const shown = hourlyRateHint('KZT')!.rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
    expect(w.find('input').element.value).toContain(shown)
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
