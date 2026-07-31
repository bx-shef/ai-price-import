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
  if (typeof window !== 'undefined') window.localStorage.clear() // client-side dedup lives here
})

describe('FeedbackWidget', () => {
  it('renders nothing when the channel is disabled', async () => {
    h.enabledValue = false
    const w = await mountSuspended(FeedbackWidget)
    expect(w.text()).toBe('')
    expect(w.find('button').exists()).toBe(false)
  })

  it('показывает обе оценки, когда канал включён', async () => {
    const w = await mountSuspended(FeedbackWidget)
    expect(w.find('button[aria-label="Хорошо"]').exists()).toBe(true)
    expect(w.find('button[aria-label="Плохо"]').exists()).toBe(true)
  })

  it('оценка «Хорошо» открывает ту же форму и НЕ отправляет сразу (#299)', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await tick()
    // Главное в #299: положительная оценка больше не уходит мгновенно и не прикладывает файл молча.
    expect(h.submit).not.toHaveBeenCalled()
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.text()).toContain('Приложить исходный файл')
  })

  it('положительная оценка уходит по «Отправить», файл — только по галочке', async () => {
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-7', fileName: 'счёт.xlsx' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await w.find('textarea').setValue('всё верно')
    await clickText(w, 'Отправить')
    await tick()
    expect(h.submit).toHaveBeenCalledWith('up', 'всё верно', { jobId: 'job-7', fileName: 'счёт.xlsx' }, false)
    expect(w.text()).toContain('Спасибо')
  })

  it('положительная оценка с галочкой прикладывает файл', async () => {
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-8' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await w.find('[role="checkbox"]').trigger('click')
    await clickText(w, 'Отправить')
    await tick()
    expect(h.submit).toHaveBeenCalledWith('up', undefined, { jobId: 'job-8', fileName: undefined }, true)
  })

  it('оценку можно передумать: 👍 → 👎 → «Отправить» уходит как отрицательная', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await w.find('textarea').setValue('передумал')
    await w.find('button[aria-label="Плохо"]').trigger('click')
    // Выбор виден не только цветом — иначе о нём не узнает скринридер.
    expect(w.find('button[aria-label="Плохо"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('button[aria-label="Хорошо"]').attributes('aria-pressed')).toBe('false')
    await clickText(w, 'Отправить')
    await tick()
    // Текст не потерян при смене оценки.
    expect(h.submit).toHaveBeenCalledWith('down', 'передумал', expect.any(Object), false)
  })

  it('👎 opens the comment box; the «Отправить» button sends with the comment', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Плохо"]').trigger('click') // opens, no send yet
    expect(h.submit).not.toHaveBeenCalled()
    await w.find('textarea').setValue('НДС не тот')
    await clickText(w, 'Отправить') // the real primary submit control
    await tick()
    // File-attach consent defaults OFF → attachFile false unless the employee ticks the box.
    expect(h.submit).toHaveBeenCalledWith('down', 'НДС не тот', expect.any(Object), false)
    expect(w.text()).toContain('Спасибо')
  })

  it('👎 with the file-consent checkbox ticked sends attachFile=true (#192 п.3)', async () => {
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-9' } })
    await w.find('button[aria-label="Плохо"]').trigger('click') // open the box (checkbox appears)
    await w.find('[role="checkbox"]').trigger('click') // B24Checkbox toggles v-model on click
    await clickText(w, 'Отправить')
    await tick()
    expect(h.submit).toHaveBeenCalledWith('down', undefined, { jobId: 'job-9', fileName: undefined }, true)
    expect(w.text()).toContain('Спасибо')
  })

  it('outside a portal (submit → false) shows an error, NOT «Спасибо»', async () => {
    h.submit = vi.fn(async () => false)
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await clickText(w, 'Отправить')
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
    await clickText(w, 'Отправить')
    await tick()
    expect(w.text()).not.toContain('Спасибо')
    expect(w.text()).toContain('Не удалось отправить')
  })

  it('already-rated job (localStorage) shows «Спасибо» on mount, does not re-offer (#D)', async () => {
    const w1 = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-42' } })
    await w1.find('button[aria-label="Хорошо"]').trigger('click')
    await clickText(w1, 'Отправить')
    await tick()
    expect(w1.text()).toContain('Спасибо') // sent + remembered in localStorage
    // A fresh mount for the SAME job (e.g. after a reload) must not show the buttons again.
    const w2 = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-42' } })
    await tick()
    expect(w2.text()).toContain('Спасибо')
    expect(w2.find('button[aria-label="Хорошо"]').exists()).toBe(false)
  })
})
