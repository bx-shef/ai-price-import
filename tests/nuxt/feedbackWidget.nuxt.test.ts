// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import FeedbackWidget from '~/components/FeedbackWidget.vue'

// Controllable mock: `enabledValue`/`submit` are read at mount time so each test sets them first.
const h = vi.hoisted(() => ({ enabledValue: true, submit: vi.fn(async () => true) }))
mockNuxtImport('useFeedback', () => () => ({
  enabled: ref(h.enabledValue),
  ensureEnabled: async () => {},
  submit: h.submit
}))

const tick = () => new Promise(r => setTimeout(r))
const clickText = (w: Awaited<ReturnType<typeof mountSuspended>>, label: string) =>
  w.findAll('button').find((b: { text: () => string }) => b.text().includes(label))!.trigger('click')

beforeEach(() => {
  h.enabledValue = true
  h.submit = vi.fn(async () => true)
})

describe('FeedbackWidget', () => {
  it('renders nothing when the channel is disabled', async () => {
    h.enabledValue = false
    const w = await mountSuspended(FeedbackWidget)
    expect(w.text()).toBe('')
    expect(w.find('button').exists()).toBe(false)
  })

  it('renders 👍/👎 when enabled', async () => {
    const w = await mountSuspended(FeedbackWidget)
    expect(w.find('button[aria-label="Хорошо"]').exists()).toBe(true)
    expect(w.find('button[aria-label="Плохо"]').exists()).toBe(true)
  })

  it('👍 submits immediately → «Спасибо»', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await tick()
    expect(h.submit).toHaveBeenCalledWith('up', undefined, expect.any(Object))
    expect(w.text()).toContain('Спасибо')
  })

  it('passes jobId/fileName context to submit', async () => {
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-7', fileName: 'счёт.xlsx' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await tick()
    expect(h.submit).toHaveBeenCalledWith('up', undefined, { jobId: 'job-7', fileName: 'счёт.xlsx' })
  })

  it('👎 opens the comment box; the «Отправить» button sends with the comment', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Плохо"]').trigger('click') // opens, no send yet
    expect(h.submit).not.toHaveBeenCalled()
    await w.find('textarea').setValue('НДС не тот')
    await clickText(w, 'Отправить') // the real primary submit control
    await tick()
    expect(h.submit).toHaveBeenCalledWith('down', 'НДС не тот', expect.any(Object))
    expect(w.text()).toContain('Спасибо')
  })

  it('outside a portal (submit → false) shows an error, NOT «Спасибо»', async () => {
    h.submit = vi.fn(async () => false)
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await tick()
    expect(w.text()).not.toContain('Спасибо')
    expect(w.text()).toContain('внутри портала')
  })

  it('a failed send shows the error and does not confirm success', async () => {
    h.submit = vi.fn(async () => {
      throw new Error('boom')
    })
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await tick()
    expect(w.text()).not.toContain('Спасибо')
    expect(w.text()).toContain('Не удалось отправить')
  })
})
