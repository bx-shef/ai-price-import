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
    expect(w.text()).toContain('Создано в CRM: сделку №5')
    expect(w.find('a').exists()).toBe(false)
    // no progress bar once terminal
    expect(w.find('[aria-label^="Стадия:"]').exists()).toBe(false)
  })

  it('done with a created entity, IN a frame → «Открыть в CRM» link (opens the entity)', async () => {
    framed.value = true
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityTypeId":2,"entityId":5,"created":true,"warnings":[],"errors":[]}') } })
    const link = w.find('a')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('открыть сделку №5 в CRM')
    framed.value = false
  })

  it('done → «разбор» shows supplier + line count with Russian plural', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"created":true,"supplier":"ООО Ромашка","lines":3,"warnings":[],"errors":[]}') } })
    const text = w.text()
    expect(text).toContain('поставщик из документа: ООО Ромашка')
    expect(text).toContain('3 позиции')
  })

  it('done with warnings → lists them', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"warnings":["НДС не найден"],"errors":[]}') } })
    expect(w.text()).toContain('НДС не найден')
  })

  it('совет показан отдельно от списка проблем и открывается словами «Что делать» (#388)', async () => {
    // Мутация «убрать блок совета из разметки» не роняла НИЧЕГО: поле доезжало до клиента, но
    // никто не проверял, что оно нарисовано. А выехало оно из `warnings` именно потому, что там
    // раздувало счётчик и читалось как ещё одна поломка документа.
    const raw = '{"entityId":5,"warnings":["Товар «Гвоздь» не найден в каталоге — строка пропущена."],"advice":"Что делать: заведите товары в каталоге."}'
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', raw) } })
    expect(w.text()).toContain('Что делать: заведите товары в каталоге.')
    expect(w.text()).toContain('Гвоздь')
  })

  it('без совета лишнего блока нет', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"warnings":[],"errors":[]}') } })
    expect(w.text()).not.toContain('Что делать')
  })

  it('error → shows the failure reason', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('error', '{"warnings":[],"errors":["не распознан формат"]}') } })
    expect(w.text()).toContain('не распознан формат')
  })

  it('no diskUrl → the file name is plain text, not a link', async () => {
    framed.value = true
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done', '{"entityId":5,"warnings":[],"errors":[]}') } })
    const fileLink = w.findAll('a').find(a => a.text().includes('накладная.pdf'))
    expect(fileLink).toBeUndefined()
    framed.value = false
  })

  it('кнопки «убрать из списка» НЕТ — историю смотрят в журнале', async () => {
    // ⚠ Решение владельца 10.08.2026: отдельная кнопка «спрятать одну строку» не нужна — лента
    // текущей сессии живёт в памяти открытой страницы и умирает вместе с ней, а история импортов
    // целиком в делах портала. Этим же закрыт #479: ключ ожидания мог зависнуть навсегда только
    // если строку убрали из списка, а убрать её больше нечем.
    const w = await mountSuspended(ImportJobItem, { props: { job: job('done') } })
    expect(w.html()).not.toContain('Убрать из списка')
    expect(w.emitted('remove')).toBeUndefined()
  })

  it('in-flight job → no «убрать из списка» button (can\'t drop an active row)', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('extracting') } })
    const btn = w.findAll('button').find(b => (b.attributes('aria-label') || '').startsWith('Убрать из списка'))
    expect(btn).toBeUndefined()
  })
  // Регресс-гвард под макет (PR #252): полосу прогресса убрали, стёпер — единственный индикатор.
  // Проверка по атрибуту aria-label прошла бы и со старой вёрсткой, поэтому целимся в сам элемент.
  it('in-flight → полосы прогресса нет, стадию несёт только стёпер', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('extracting') } })
    expect(w.find('[role="progressbar"]').exists()).toBe(false)
    const status = w.find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('aria-label')).toContain('Стадия')
    expect(status.text()).toContain('Извлечение текста')
  })

  it('на второй стадии первый шаг помечен галочкой', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('processing') } })
    expect(w.find('[role="status"]').text()).toContain('✓')
  })
})

describe('ImportJobItem: истёкший статус (#268)', () => {
  const EXPIRED = 'Статус этой загрузки больше не хранится на сервере — прошло больше 48 часов. Документ в CRM это не затрагивает.'

  it('строка терминальна: объяснение видно, степпера нет, «Документ обработан» не подставляется', async () => {
    const w = await mountSuspended(ImportJobItem, { props: { job: job('expired', EXPIRED) } })
    const text = w.text()
    expect(text).toContain('Статус не сохранился') // бейдж
    expect(text).toContain('больше не хранится на сервере')
    expect(text).not.toContain('Документ обработан')
    expect(text).not.toContain('Извлечение текста') // степпер только у незавершённых
  })

  it('кнопки «Убрать из списка» нет и у истёкшей строки', async () => {
    // ⚠ Прежде тут была обратная проверка: у потерянного статуса кнопка была ЕДИНСТВЕННЫМ способом
    // убрать строку. Теперь убирать нечего — лента умирает вместе с вкладкой, а история в делах.
    const w = await mountSuspended(ImportJobItem, { props: { job: job('expired', EXPIRED) } })
    expect(w.find('button[aria-label^="Убрать из списка"]').exists()).toBe(false)
  })
})
