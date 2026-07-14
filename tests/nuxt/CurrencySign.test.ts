// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import CurrencySign from '~/components/CurrencySign.vue'

describe('CurrencySign', () => {
  it('renders the official BYN glyph as an SVG plus a selectable «BYN» text', async () => {
    const wrapper = await mountSuspended(CurrencySign, { props: { code: 'BYN' } })
    const svg = wrapper.find('svg.byn-sign')
    expect(svg.exists()).toBe(true)
    // aria-hidden on the SVG, real text on the sibling span for a11y / copy-paste.
    expect(svg.attributes('aria-hidden')).toBe('true')
    const hidden = wrapper.find('.byn-br')
    expect(hidden.exists()).toBe(true)
    expect(hidden.text()).toBe('BYN')
    // No Unicode fallback text leaks out for BYN.
    expect(wrapper.text()).toBe('BYN')
  })

  it('renders a Unicode sign as plain text for currencies that have one', async () => {
    const rub = await mountSuspended(CurrencySign, { props: { code: 'RUB' } })
    expect(rub.find('svg').exists()).toBe(false)
    expect(rub.text()).toBe('₽')

    const kzt = await mountSuspended(CurrencySign, { props: { code: 'KZT' } })
    expect(kzt.text()).toBe('₸')
  })

  it('passes an unknown code through unchanged', async () => {
    const wrapper = await mountSuspended(CurrencySign, { props: { code: 'XYZ' } })
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toBe('XYZ')
  })

  it('renders nothing when no code is given', async () => {
    const wrapper = await mountSuspended(CurrencySign, { props: {} })
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('renders nothing for an empty-string code (falsy, same as absent)', async () => {
    const wrapper = await mountSuspended(CurrencySign, { props: { code: '' } })
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })
})
