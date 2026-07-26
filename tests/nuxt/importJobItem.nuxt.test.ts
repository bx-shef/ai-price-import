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

// Controllable frame state: the «Открыть в CRM» entity button only renders IN a portal frame.
const framed = ref(false)
// Records every slider.openPath(getUrl(x)) so a test can assert WHICH path was opened (entity vs Disk).
const sliderCalls: string[] = []
const frameMock = {
  slider: {
    getUrl: (p: string) => `URL:${p}`,
    openPath: async (u: string) => { sliderCalls.push(u) }
  }
}
mockNuxtImport('useB24', () => () => ({
  init: async () => (framed.value ? frameMock : null),
  get: () => (framed.value ? frameMock : null),
  auth: () => null,
  inFrame: () => framed.value,
  placementPlace: () => undefined,
  openAppSlider: async () => false,
  closeSlider: async () => {}
}))

const job = (status: string, result = '', extra: Record<string, unknown> = {}) => ({ jobId: 'j1', status, fileName: 'накладная.pdf', result, ...extra }) as never

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

  it('done with a created entity, STANDALONE (no frame) → plain «Создано в CRM» text, no link', async () => {
    framed.value = false
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityTypeId":2,"entityId":5,"created":true,"warnings":[],"errors":[]}') } })
    expect(w.text()).toContain('Создано в CRM · сущность #5')
    expect(w.find('a').exists()).toBe(false)
    // no progress bar once terminal
    expect(w.find('[aria-label^="Стадия:"]').exists()).toBe(false)
  })

  it('done with a created entity, IN a frame → «Открыть в CRM» link (opens the entity)', async () => {
    framed.value = true
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityTypeId":2,"entityId":5,"created":true,"warnings":[],"errors":[]}') } })
    const link = w.find('a')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('Открыть в CRM · сущность #5')
    framed.value = false
  })

  it('done → «разбор» shows supplier + line count with Russian plural', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"created":true,"supplier":"ООО Ромашка","lines":3,"warnings":[],"errors":[]}') } })
    const text = w.text()
    expect(text).toContain('распознан поставщик: ООО Ромашка')
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

  it('archived-to-Disk file (diskUrl) IN a frame → the file name becomes a link (opens the Disk)', async () => {
    framed.value = true
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"warnings":[],"errors":[]}', { diskUrl: '/docs/file/9/' }) } })
    // The file name renders as a clickable <a> (its title names the source-file action). The absolute
    // href needs the portal domain (absent in this mock, like the entity-link test); the click opens
    // the Disk via the slider regardless.
    const fileLink = w.findAll('a').find(a => a.text().includes('накладная.pdf'))
    expect(fileLink).toBeTruthy()
    expect(fileLink!.attributes('title')).toContain('исходный файл')
    framed.value = false
  })

  it('clicking the Disk file-name link opens the DISK path via the slider (not the entity path)', async () => {
    framed.value = true
    sliderCalls.length = 0
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityTypeId":2,"entityId":5,"warnings":[],"errors":[]}', { diskUrl: '/docs/file/9/' }) } })
    const fileLink = w.findAll('a').find(a => a.text().includes('накладная.pdf'))!
    await fileLink.trigger('click')
    await new Promise(r => setTimeout(r))
    // Opened the Disk url, NOT the CRM entity detail path (guards against a copy-paste of entityPath).
    expect(sliderCalls).toContain('URL:/docs/file/9/')
    expect(sliderCalls.some(u => u.includes('/crm/'))).toBe(false)
    framed.value = false
  })

  it('no diskUrl → the file name is plain text, not a link', async () => {
    framed.value = true
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"warnings":[],"errors":[]}') } })
    const fileLink = w.findAll('a').find(a => a.text().includes('накладная.pdf'))
    expect(fileLink).toBeUndefined()
    framed.value = false
  })
})
