// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ImportStaging from '~/components/ImportStaging.vue'

// TargetPicker pulls in the CRM cascade composables; stub it out — this suite tests the STAGING +
// one-by-one upload flow, not the per-file target picker (covered separately).
const stubs = { TargetPicker: true }

const file = (name: string) => new File(['x'], name, { type: 'application/pdf' })
const tick = () => new Promise(r => setTimeout(r))
// Emit picked files the way B24FileUpload would (v-model:update).
async function pick(w: Awaited<ReturnType<typeof mountSuspended>>, files: File[]) {
  w.findComponent({ name: 'B24FileUpload' }).vm.$emit('update:modelValue', files)
  await tick()
}
const clickText = (w: Awaited<ReturnType<typeof mountSuspended>>, label: string) =>
  w.findAll('button').find((b: { text: () => string }) => b.text().includes(label))!.trigger('click')

describe('ImportStaging', () => {
  it('picking files STAGES them (no auto-upload) — rows appear «в очереди», upload not called', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('накладная.pdf'), file('счёт.xlsx')])
    const text = w.text()
    expect(text).toContain('накладная.pdf')
    expect(text).toContain('счёт.xlsx')
    expect(text).toContain('в очереди')
    // Staging must NOT auto-upload (owner ask: import on click only).
    expect(upload).not.toHaveBeenCalled()
  })

  it('«Импортировать» uploads ONE BY ONE, in order, then shows the done notice', async () => {
    const order: string[] = []
    const upload = vi.fn(async (f: File) => {
      order.push(f.name)
      return true
    })
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('a.pdf'), file('b.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['a.pdf', 'b.pdf']) // sequential, source order
    expect(w.text()).toContain('Отправлено в CRM: 2 из 2')
    expect(w.text()).toContain('отправлен') // per-row done badge
  })

  it('a failed upload marks that row «ошибка» and the notice counts only successes', async () => {
    const upload = vi.fn(async (f: File) => f.name !== 'bad.pdf')
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('good.pdf'), file('bad.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    const text = w.text()
    expect(text).toContain('ошибка')
    expect(text).toContain('Отправлено в CRM: 1 из 2')
  })

  it('caps the pending queue at 10 files, dropping the excess with a notice', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, Array.from({ length: 14 }, (_, i) => file(`f${i}.pdf`)))
    // 10 kept, 4 dropped → notice mentions the cap.
    expect(w.text()).toContain('Добавлено 10 из 14')
    expect(w.findAll('li').length).toBe(10)
  })

  it('remove button drops a staged file before import', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('drop-me.pdf')])
    expect(w.text()).toContain('drop-me.pdf')
    await w.find('button[aria-label="Убрать drop-me.pdf"]').trigger('click')
    await tick()
    expect(w.text()).not.toContain('drop-me.pdf')
  })
})
