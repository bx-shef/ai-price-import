// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ImportStaging from '~/components/ImportStaging.vue'

// TargetPicker pulls in the CRM cascade composables; stub it out — this suite tests the STAGING +
// one-by-one upload flow, not the per-file target picker (covered separately). With it stubbed the
// per-row target stays null, so upload's 2nd arg is null.
const stubs = { TargetPicker: true }

const file = (name: string) => new File(['x'], name, { type: 'application/pdf' })
const tick = () => new Promise(r => setTimeout(r))
// Stage files the way the native <input type=file> does: set .files then fire `change`.
async function pick(w: Awaited<ReturnType<typeof mountSuspended>>, files: File[]) {
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await tick()
}
const clickText = (w: Awaited<ReturnType<typeof mountSuspended>>, label: string) =>
  w.findAll('button').find((b: { text: () => string }) => b.text().includes(label))!.trigger('click')

describe('ImportStaging', () => {
  it('picking files STAGES them (no auto-upload) — rows appear «В очереди», upload not called', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('накладная.pdf'), file('счёт.xlsx')])
    const text = w.text()
    expect(text).toContain('накладная.pdf')
    expect(text).toContain('счёт.xlsx')
    expect(text).toContain('В очереди')
    // Staging must NOT auto-upload (owner ask: import on click only).
    expect(upload).not.toHaveBeenCalled()
  })

  it('«Импортировать» uploads ONE BY ONE, in order, forwarding a stable jobId key', async () => {
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
    // Each call carries (File, null target, a UUID idempotency key).
    expect(upload).toHaveBeenCalledWith(expect.any(File), null, expect.stringMatching(/^[0-9a-f-]{36}$/i))
    expect(w.text()).toContain('Отправили в CRM 2 из 2')
    expect(w.text()).toContain('Отправлен') // per-row done badge
  })

  it('a failed upload marks that row «Ошибка» and the notice counts only successes', async () => {
    const upload = vi.fn(async (f: File) => f.name !== 'bad.pdf')
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('good.pdf'), file('bad.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    const text = w.text()
    expect(text).toContain('Ошибка')
    expect(text).toContain('Отправили в CRM 1 из 2')
  })

  it('a failed (retryable) row re-imports on a second «Импортировать»; done rows are not re-sent', async () => {
    let failFirst = true
    const upload = vi.fn(async (f: File) => {
      if (f.name === 'flaky.pdf' && failFirst) {
        failFirst = false
        return false
      }
      return true
    })
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('ok.pdf'), file('flaky.pdf')])
    await clickText(w, 'Импортировать') // ok→done, flaky→error
    await tick()
    expect(upload).toHaveBeenCalledTimes(2)
    await clickText(w, 'Импортировать') // only flaky (error) retried; ok (done) NOT re-sent
    await tick()
    expect(upload).toHaveBeenCalledTimes(3)
    expect(upload).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'flaky.pdf' }), null, expect.any(String))
    expect(w.text()).toContain('Отправили в CRM 1 из 1')
  })

  it('dedups the same file staged twice (would import twice) with a notice', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    const f = file('dup.pdf')
    await pick(w, [f])
    await pick(w, [f]) // same File → same signature → skipped
    expect(w.findAll('li').length).toBe(1)
    expect(w.text()).toContain('уже в списке')
  })

  it('pre-validates on stage: a bad-extension file becomes an «Ошибка» row and is NOT uploaded', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('doc.pdf'), new File(['x'], 'virus.exe')])
    expect(w.text()).toContain('Ошибка') // the .exe row
    await clickText(w, 'Импортировать')
    await tick()
    // Only the valid .pdf is uploaded; the invalid .exe is never sent.
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ name: 'doc.pdf' }), null, expect.any(String))
  })

  it('caps the pending queue at 10 files, dropping the excess with a notice', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, Array.from({ length: 14 }, (_, i) => file(`f${i}.pdf`)))
    expect(w.text()).toContain('Добавлено 10 из 14')
    expect(w.findAll('li').length).toBe(10)
  })

  it('«Убрать отправленные» clears the done rows after import', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('one.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    expect(w.text()).toContain('one.pdf')
    await clickText(w, 'Убрать отправленные')
    await tick()
    expect(w.text()).not.toContain('one.pdf')
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
  // --- Регресс-гварды под утверждённый макет (PR #252) ---

  it('во время отправки дропзона блокируется и объясняет почему', async () => {
    let release: (v: boolean) => void = () => {}
    const upload = vi.fn(() => new Promise<boolean>((r) => {
      release = r
    }))
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('a.pdf')])
    expect(w.text()).toContain('PDF, фото, Excel, Word')
    const running = clickText(w, 'Импортировать')
    await tick()
    expect(w.text()).toContain('Заблокировано, пока идёт отправка')
    expect(w.find('input[type="file"]').attributes('disabled')).toBeDefined()
    release(true)
    await running
    await tick()
  })

  it('строка списка показывает размер файла', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    const big = new File(['x'.repeat(2048)], 'big.pdf', { type: 'application/pdf' })
    await pick(w, [big])
    expect(w.text()).toContain('2 КБ')
  })

  it('подсказка живёт ВНУТРИ карточки списка (role=status), а не отдельным алертом', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('one.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    const notice = w.find('p[role="status"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toMatch(/Отправили в CRM \d+ из \d+/)
  })

  it('очистка списка сбрасывает подсказку — не показываем «письмо из прошлого»', async () => {
    const upload = vi.fn(async () => true)
    const w = await mountSuspended(ImportStaging, { props: { upload }, global: { stubs } })
    await pick(w, [file('one.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    expect(w.text()).toContain('Отправили в CRM')
    await clickText(w, 'Убрать отправленные из списка')
    await tick()
    expect(w.text()).not.toContain('Отправили в CRM')
  })
})
