// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import ImportJobItem from '~/components/ImportJobItem.vue'

// Stub the feedback channel off so the embedded FeedbackWidget renders nothing / makes no network call.
mockNuxtImport('useFeedback', () => () => ({
  enabled: ref(false),
  ensureEnabled: async () => {},
  submit: async () => true
}))

const job = (status: string, result = '') => ({ jobId: 'j1', status, fileName: 'накладная.pdf', result }) as never

describe('ImportJobItem', () => {
  it('in-flight (extracting) → shows the stage stepper + current-stage progress, no result', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('extracting') } })
    const text = w.text()
    // all three pipeline steps are labelled
    expect(text).toContain('Извлечение текста')
    expect(text).toContain('Распознавание и запись')
    expect(text).toContain('Готово')
    // the progress bar carries the active stage in its aria-label
    expect(w.find('[aria-label="Стадия: Извлечение текста"]').exists()).toBe(true)
    // no «разбор» yet
    expect(text).not.toContain('Создано в CRM')
  })

  it('done with a created entity → shows the «разбор» line', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"created":true,"warnings":[],"errors":[]}') } })
    expect(w.text()).toContain('Создано в CRM · сущность #5')
    // no progress bar once terminal
    expect(w.find('[aria-label^="Стадия:"]').exists()).toBe(false)
  })

  it('done → «разбор» shows supplier + line count with Russian plural', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"created":true,"supplier":"ООО Ромашка","lines":3,"warnings":[],"errors":[]}') } })
    const text = w.text()
    expect(text).toContain('поставщик: ООО Ромашка')
    expect(text).toContain('3 позиции')
  })

  it('done with warnings → lists them', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"warnings":["НДС не найден"],"errors":[]}') } })
    expect(w.text()).toContain('НДС не найден')
  })

  it('error → shows the failure reason', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('error', '{"warnings":[],"errors":["не распознан формат"]}') } })
    expect(w.text()).toContain('не распознан формат')
  })
})
