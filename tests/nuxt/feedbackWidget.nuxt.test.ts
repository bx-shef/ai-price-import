// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import FeedbackWidget from '~/components/FeedbackWidget.vue'

// Controllable mock: `enabledValue`/`submit` are read at mount time so each test sets them first.
const h = vi.hoisted(() => ({ enabledValue: true, submit: vi.fn(async () => ({ ok: true })) }))
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
  h.submit = vi.fn(async () => ({ ok: true }))
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
    expect(h.submit).toHaveBeenCalledWith('up', 'всё верно', { jobId: 'job-7', fileName: 'счёт.xlsx' }, false)
    expect(w.text()).toContain('Спасибо')
  })

  it('положительная оценка с ответом «с файлом» прикладывает файл', async () => {
    // Файл берётся ИЗ ПАМЯТИ СТРАНИЦЫ (#349) — сервер копию не хранит, поэтому без него кнопка
    // «Отправить с файлом» недоступна (проверено отдельным тестом ниже).
    const w = await mountSuspended(FeedbackWidget, {
      props: { jobId: 'job-8' }
    })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await sendWith(w, true)
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
    await sendWith(w, false)
    await tick()
    // Текст не потерян при смене оценки.
    expect(h.submit).toHaveBeenCalledWith('down', 'передумал', expect.any(Object), false)
  })

  it('👎 opens the comment box; the «Отправить» button sends with the comment', async () => {
    const w = await mountSuspended(FeedbackWidget)
    await w.find('button[aria-label="Плохо"]').trigger('click') // opens, no send yet
    expect(h.submit).not.toHaveBeenCalled()
    await w.find('textarea').setValue('НДС не тот')
    await sendWith(w, false)
    await tick()
    // Файл уходит только по явному ответу — «без файла» значит именно без файла.
    expect(h.submit).toHaveBeenCalledWith('down', 'НДС не тот', expect.any(Object), false)
    expect(w.text()).toContain('Спасибо')
  })

  it('👎 с ответом «с файлом» шлёт attachFile=true (#192 п.3)', async () => {
    const w = await mountSuspended(FeedbackWidget, {
      props: { jobId: 'job-9' }
    })
    await w.find('button[aria-label="Плохо"]').trigger('click')
    await sendWith(w, true)
    await tick()
    expect(h.submit).toHaveBeenCalledWith('down', undefined, { jobId: 'job-9', fileName: undefined }, true)
    expect(w.text()).toContain('Спасибо')
  })

  it('outside a portal (submit → ok:false) shows an error, NOT «Спасибо»', async () => {
    h.submit = vi.fn(async () => ({ ok: false }))
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

  // #461: файл больше НЕ едет со страницы — сервер читает его из вложения дела таймлайна. Значит
  // вопрос про файл выглядит одинаково всегда: два равноправных ответа и ни выбора файла вручную,
  // ни предупреждения о размере (страница о документе после отправки не знает ничего и обещать за
  // сервер не может). Три прежних теста этой ветки (нет копии / есть копия / копия велика) сняты
  // вместе с самой памятью страницы.
  it('вопрос про файл не зависит от памяти страницы: оба ответа доступны всегда', async () => {
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-nofile' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await tick()
    await clickText(w, 'Отправить')
    await tick()
    expect(w.text()).toContain('берётся из дела')
    const withFile = w.findAll('button').find(b => b.text().includes('Отправить с файлом'))
    expect(withFile?.attributes('disabled'), 'обещать нечего — сервер найдёт документ сам').toBeUndefined()
    await clickText(w, 'Отправить с файлом')
    await tick()
    expect(h.submit).toHaveBeenCalledWith('up', undefined, expect.any(Object), true)
  })

  it('файл выброшен общим пределом приёмника → человеку говорят об этом (#354)', async () => {
    // Молчаливое «Спасибо за отзыв!» здесь читалось бы как «документ ушёл» — а он не ушёл.
    h.submit = vi.fn(async () => ({ ok: true, notice: 'Отзыв отправлен, но документ приложить не удалось.' }))
    const w = await mountSuspended(FeedbackWidget, { props: { jobId: 'job-9' } })
    await w.find('button[aria-label="Хорошо"]').trigger('click')
    await sendWith(w, false)
    await tick()
    expect(w.text()).toContain('Спасибо')
    expect(w.text()).toContain('документ приложить не удалось')
  })
})
