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
/** «Отправить» больше не отправляет — оно задаёт вопрос про файл. Полный путь = кнопка + ответ. */
const sendWith = async (w: Awaited<ReturnType<typeof mountSuspended>>, file: boolean) => {
  await clickText(w, 'Отправить')
  await clickText(w, file ? 'Отправить с файлом' : 'Отправить без файла')
}

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
  })

  it('«Отправить» сначала СПРАШИВАЕТ про файл и ничего не отправляет', async () => {
    // Суть правки: отдать документ наружу — отдельное решение, и принимается оно явно, а не
    // галочкой, поставленной мимоходом рядом с комментарием.
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-ask' } })
    await w.find('button[aria-label="Плохо"]').trigger('click')
    await clickText(w, 'Отправить')
    await tick()
    expect(h.submit).not.toHaveBeenCalled()
    expect(w.text()).toContain('Приложить исходный файл?')
    // Оба ответа предложены явно — «без файла» не спрятан.
    const labels = w.findAll('button').map((b: { text: () => string }) => b.text())
    expect(labels.some(t => t.includes('Отправить с файлом'))).toBe(true)
    expect(labels.some(t => t.includes('Отправить без файла'))).toBe(true)
  })

  it('галочки согласия больше нет — вопрос задаётся один раз, при отправке', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Плохо"]').trigger('click')
    await tick()
    expect(w.find('[role="checkbox"]').exists()).toBe(false)
  })

  it('положительная оценка уходит без файла, если так ответили', async () => {
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-7', fileName: 'счёт.xlsx' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await w.find('textarea').setValue('всё верно')
    await sendWith(w, false)
    await tick()
    expect(h.submit).toHaveBeenCalledWith('up', 'всё верно', { jobId: 'job-7', fileName: 'счёт.xlsx' }, false, null)
    expect(w.text()).toContain('Спасибо')
  })

  it('положительная оценка с ответом «с файлом» прикладывает файл', async () => {
    // Файл берётся ИЗ ПАМЯТИ СТРАНИЦЫ (#349) — сервер копию не хранит, поэтому без него кнопка
    // «Отправить с файлом» недоступна (проверено отдельным тестом ниже).
    const w = await mountSuspended(FeedbackWidget, {
      props: { jobId: 'job-8', file: new File([new Uint8Array([1, 2, 3])], 'счёт.pdf') }
    })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await sendWith(w, true)
    await tick()
    expect(h.submit).toHaveBeenCalledWith('up', undefined, { jobId: 'job-8', fileName: undefined }, true, { name: 'счёт.pdf', base64: 'AQID' })
  })

  it('оценку можно передумать: 👍 → 👎 → «Отправить» уходит как отрицательная', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await w.find('textarea').setValue('передумал')
    await w.find('button[aria-label="Плохо"]').trigger('click')
    // Выбор виден не только цветом — иначе о нём не узнает скринридер.
    expect(w.find('button[aria-label="Плохо"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('button[aria-label="Хорошо"]').attributes('aria-pressed')).toBe('false')
    await sendWith(w, false)
    await tick()
    // Текст не потерян при смене оценки.
    expect(h.submit).toHaveBeenCalledWith('down', 'передумал', expect.any(Object), false, null)
  })

  it('👎 opens the comment box; the «Отправить» button sends with the comment', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Плохо"]').trigger('click') // opens, no send yet
    expect(h.submit).not.toHaveBeenCalled()
    await w.find('textarea').setValue('НДС не тот')
    await sendWith(w, false)
    await tick()
    // Файл уходит только по явному ответу — «без файла» значит именно без файла.
    expect(h.submit).toHaveBeenCalledWith('down', 'НДС не тот', expect.any(Object), false, null)
    expect(w.text()).toContain('Спасибо')
  })

  it('👎 с ответом «с файлом» шлёт attachFile=true (#192 п.3)', async () => {
    const w = await mountSuspended(FeedbackWidget, {
      props: { jobId: 'job-9', file: new File([new Uint8Array([4, 5])], 'накладная.pdf') }
    })
    await w.find('button[aria-label="Плохо"]').trigger('click')
    await sendWith(w, true)
    await tick()
    expect(h.submit).toHaveBeenCalledWith('down', undefined, { jobId: 'job-9', fileName: undefined }, true, { name: 'накладная.pdf', base64: 'BAU=' })
    expect(w.text()).toContain('Спасибо')
  })

  it('outside a portal (submit → false) shows an error, NOT «Спасибо»', async () => {
    h.submit = vi.fn(async () => false)
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await sendWith(w, false)
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
    await sendWith(w, false)
    await tick()
    expect(w.text()).not.toContain('Спасибо')
    expect(w.text()).toContain('Не удалось отправить')
  })

  it('после отправки виджет показывает «Спасибо» и не предлагает оценить снова (в пределах страницы)', async () => {
    // Персистентного дедупа больше нет (localStorage убран — переработка владельца): список заданий
    // живёт только на открытой странице, поэтому и «уже оценил» достаточно помнить в компоненте.
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-42' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await sendWith(w, false)
    await tick()
    expect(w.text()).toContain('Спасибо')
    expect(w.find('button[aria-label="Хорошо"]').exists()).toBe(false)
  })

  // #349: сервер больше НЕ хранит загруженный файл (владелец не готов держать документы клиента
  // сутки). Единственная копия — в памяти страницы. Значит, кнопка «Отправить с файлом» не имеет
  // права быть активной, когда копии нет: она бы молча отправила отзыв без того, ради чего его и
  // отправляют. Вместо этого предлагается выбрать файл вручную.
  it('без файла в памяти страницы «Отправить с файлом» недоступна и предлагается выбрать вручную', async () => {
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-nofile' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await tick()
    await clickText(w, 'Отправить')
    await tick()
    expect(w.text()).toContain('выберите его вручную')
    const withFile = w.findAll('button').find(b => b.text().includes('Отправить с файлом'))
    expect(withFile?.attributes('disabled')).toBeDefined()
    expect(h.submit).not.toHaveBeenCalled()
  })

  it('когда копия есть — говорим, что уйдёт именно она, и что на сервере файл не хранится', async () => {
    const w = await mountSuspended(FeedbackWidget, {
      props: { jobId: 'job-has', file: new File([new Uint8Array([9])], 'счёт-7.pdf') }
    })
    await w.find('button[aria-label="Плохо"]').trigger('click')
    await tick()
    await clickText(w, 'Отправить')
    await tick()
    expect(w.text()).toContain('счёт-7.pdf')
    expect(w.text()).toContain('на сервере он не хранится')
  })

  // Ветка «файл есть, но слишком большой» — её отметил тестировщик как непокрытую, хотя соседние
  // (файла нет / файл есть) закрыты. Импорт принимает 20 МБ, вложение к отзыву — 5 МБ, поэтому
  // случай реальный: без гарда виджет обещал бы отправить скан, сервер молча выбросил бы вложение,
  // а на 19+ МБ запрос не прошёл бы кап тела и терялась бы ВСЯ оценка.
  it('файл больше капа: честный текст, вложение не уходит, но отзыв отправить можно', async () => {
    const w = await mountSuspended(FeedbackWidget, {
      props: { jobId: 'job-big', file: new File([new Uint8Array(6 * 1024 * 1024)], 'скан.pdf') }
    })
    await w.find('button[aria-label="Плохо"]').trigger('click')
    await tick()
    await clickText(w, 'Отправить')
    await tick()
    expect(w.text()).toContain('слишком большой')
    expect(w.text()).toContain('скан.pdf')
    // «С файлом» недоступна — обещать отправку того, что не уйдёт, нельзя.
    const withFile = w.findAll('button').find(b => b.text().includes('Отправить с файлом'))
    expect(withFile?.attributes('disabled')).toBeDefined()
    // …а сам отзыв отправить можно — потеря вложения не должна лишать нас оценки.
    await clickText(w, 'Отправить без файла')
    await tick()
    expect(h.submit).toHaveBeenCalledWith('down', undefined, expect.any(Object), false, null)
  })
})
