// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ImportStaging from '~/components/ImportStaging.vue'
import { UPLOAD_GENERIC_ERROR, type UploadOutcome } from '~/utils/importUpload'
import type { JobStatus } from '~/utils/jobStatus'

const OK: UploadOutcome = { ok: true, stop: false }
const FAIL: UploadOutcome = { ok: false, stop: false }

// TargetPicker pulls in the CRM cascade composables; stub it out — this suite tests the batch flow,
// not the picker (covered separately). With it stubbed the shared target stays null.
const stubs = { TargetPicker: true }

const file = (name: string) => new File(['x'], name, { type: 'application/pdf' })
const tick = () => new Promise(r => setTimeout(r))
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
// Stage files the way the native <input type=file> does: set .files then fire `change`.
async function pick(w: Awaited<ReturnType<typeof mountSuspended>>, files: File[]) {
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await tick()
}
const clickText = (w: Awaited<ReturnType<typeof mountSuspended>>, label: string) =>
  w.findAll('button').find((b: { text: () => string }) => b.text().includes(label))!.trigger('click')

/** Default transport: every upload succeeds and its job is instantly done — the run completes on the
 *  first wait pass, keeping tests fast. Individual tests override either side. */
const instantDone = () => ({
  upload: vi.fn(async () => OK),
  jobDone: vi.fn((): JobStatus | null => 'done'),
  refreshNow: vi.fn(async () => {}),
  listError: ''
})
const mount = (props: { upload: unknown, jobDone: unknown, refreshNow?: unknown, listError?: string }) =>
  mountSuspended(ImportStaging, { props: { refreshNow: async () => {}, listError: '', ...props } as never, global: { stubs } })

describe('ImportStaging (пачка + ожидание результатов)', () => {
  it('выбор файлов только СТАВИТ их в список — без автозагрузки', async () => {
    const t = instantDone()
    const w = await mount(t)
    await pick(w, [file('накладная.pdf'), file('счёт.xlsx')])
    const text = w.text()
    expect(text).toContain('накладная.pdf')
    expect(text).toContain('счёт.xlsx')
    expect(text).toContain('В очереди')
    expect(t.upload).not.toHaveBeenCalled()
  })

  it('«Импортировать» шлёт всю пачку с ОДНОЙ целью и ЖДЁТ результаты до конца', async () => {
    const order: string[] = []
    const upload = vi.fn(async (f: File) => {
      order.push(f.name)
      return OK
    })
    const w = await mount({ upload, jobDone: () => 'done' })
    await pick(w, [file('a.pdf'), file('b.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    expect(upload).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['a.pdf', 'b.pdf'])
    // Each call carries (File, the SHARED batch target — null with the picker stubbed, a UUID key).
    expect(upload).toHaveBeenCalledWith(expect.any(File), null, expect.stringMatching(/^[0-9a-f-]{36}$/i))
    expect(w.text()).toContain('Готово: все 2 файла обработаны')
    // Завершённые строки ушли вниз, в «Последние операции».
    expect(w.text()).not.toContain('a.pdf')
    expect(w.text()).not.toContain('b.pdf')
  })

  it('страница ЗАБЛОКИРОВАНА, пока задания не разобраны; баннер честно просит не закрывать', async () => {
    // jobDone отвечает null, пока мы не «доразберём» задание — ровно как сервер.
    let finished = false
    const t = { upload: vi.fn(async () => OK), jobDone: vi.fn(() => (finished ? 'done' as const : null)) }
    const w = await mount(t)
    await pick(w, [file('slow.pdf')])
    const run = clickText(w, 'Импортировать')
    await wait(50)
    // Загрузка прошла, разбор ещё идёт: блок держится, баннер видим.
    const busy = w.emitted('update:busy') as Array<[boolean]>
    expect(busy.at(-1)?.[0]).toBe(true)
    // Полный заголовок БАННЕРА: короткий хвост фразы раньше дублировался в notice, и удаление
    // самого баннера тесты не замечали (мутационная дыра). Теперь фраза живёт только тут.
    expect(w.text()).toContain('Идёт импорт — не закрывайте страницу')
    // ПЕРЕДАЧА (#349): отправленная строка уходит из этого списка сразу, а не по завершении разбора —
    // иначе один документ висел бы в двух списках в двух разных состояниях. Ход разбора виден в
    // сводке, а состояние каждого файла — уже в «Последних операциях» ниже.
    expect(w.text()).not.toContain('slow.pdf')
    expect(w.text()).toContain('Обрабатываем: осталось 1 из 1')
    finished = true
    await wait(400) // один тик ожидания (250 мс) с запасом
    await run
    await tick()
    expect((w.emitted('update:busy') as Array<[boolean]>).at(-1)?.[0]).toBe(false)
    expect(w.text()).toContain('Готово')
  })

  it('«Отменить» останавливает прогон: неотправленное остаётся, ожидание снимается, текст честный', async () => {
    // Первый файл уходит и «висит» в разборе вечно; отмена должна отпустить страницу, не наврав,
    // что сервер бросил уже принятое задание.
    const t = { upload: vi.fn(async () => OK), jobDone: vi.fn(() => null) }
    const w = await mount(t)
    await pick(w, [file('first.pdf')])
    const run = clickText(w, 'Импортировать')
    await wait(50)
    await clickText(w, 'Отменить')
    await wait(400)
    await run
    await tick()
    expect((w.emitted('update:busy') as Array<[boolean]>).at(-1)?.[0]).toBe(false)
    expect(w.text()).toContain('Импорт отменён')
    expect(w.text()).toContain('сервер дообработает')
  })

  it('задание, закончившееся ошибкой на сервере, попадает в итог как ошибка, но прогон доводится', async () => {
    const statuses: Record<string, JobStatus> = {}
    const upload = vi.fn(async (_f: File, _t: unknown, jobId?: string) => {
      statuses[jobId!] = Object.keys(statuses).length === 0 ? 'error' : 'done'
      return OK
    })
    const w = await mount({ upload, jobDone: (id: string) => statuses[id] ?? null })
    await pick(w, [file('bad-server.pdf'), file('good.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    expect(w.text()).toContain('Готово: успешно 1, с ошибкой 1')
  })

  it('если upload БРОСИЛ — страница не залипает (#258)', async () => {
    const upload = vi.fn(async () => {
      throw new Error('boom')
    })
    const w = await mount({ upload, jobDone: () => 'done' })
    await pick(w, [file('good.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    const busy = w.emitted('update:busy') as Array<[boolean]> | undefined
    expect(busy?.at(-1)?.[0]).toBe(false)
    expect(w.text()).toContain('прервал')
  })

  it('упавшая ЗАГРУЗКА помечает строку и пачка идёт дальше (не останавливается)', async () => {
    const upload = vi.fn(async (f: File) => (f.name === 'bad.pdf' ? FAIL : OK))
    const w = await mount({ upload, jobDone: () => 'done' })
    await pick(w, [file('bad.pdf'), file('good.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    expect(upload).toHaveBeenCalledTimes(2) // good.pdf не пострадал
    expect(w.text()).toContain('bad.pdf') // осталась с ошибкой
    expect(w.text()).toContain('с ошибкой 1')
  })

  it('упавшую строку можно перевыслать вторым «Импортировать»; ушедшие не шлются заново', async () => {
    let failFirst = true
    const upload = vi.fn(async (f: File) => {
      if (f.name === 'flaky.pdf' && failFirst) {
        failFirst = false
        return FAIL
      }
      return OK
    })
    const w = await mount({ upload, jobDone: () => 'done' })
    await pick(w, [file('ok.pdf'), file('flaky.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    expect(upload).toHaveBeenCalledTimes(2)
    await clickText(w, 'Импортировать') // повторяется только flaky
    await tick()
    await tick()
    expect(upload).toHaveBeenCalledTimes(3)
    expect(upload).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'flaky.pdf' }), null, expect.any(String))
  })

  it('отказ по частоте останавливает пачку и показывает текст сервера', async () => {
    // Единственное исключение из «идём дальше»: отказ по частоте — про человека, а не про файл,
    // каждая следующая строка упёрлась бы в ту же стену.
    const upload = vi.fn(async () => ({ ok: false, stop: true, message: 'Слишком много загрузок подряд. Попробуйте снова через 7 мин.' }))
    const w = await mount({ upload, jobDone: () => 'done' })
    await pick(w, [file('a.pdf'), file('b.pdf'), file('c.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    expect(upload).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('через 7 мин')
    expect(w.text()).not.toContain(UPLOAD_GENERIC_ERROR)
  })

  it('дедуп того же файла в списке', async () => {
    const t = instantDone()
    const w = await mount(t)
    const f = file('dup.pdf')
    await pick(w, [f])
    await pick(w, [f])
    expect(w.findAll('li').length).toBe(1)
    expect(w.text()).toContain('уже в списке')
  })

  it('пре-валидация: файл с кривым расширением — строка «Ошибка», не загружается', async () => {
    const t = instantDone()
    const w = await mount(t)
    await pick(w, [file('doc.pdf'), new File(['x'], 'virus.exe')])
    expect(w.text()).toContain('Ошибка')
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    expect(t.upload).toHaveBeenCalledTimes(1)
    expect(t.upload).toHaveBeenCalledWith(expect.objectContaining({ name: 'doc.pdf' }), null, expect.any(String))
  })

  it('кап списка — 10 файлов, лишние отброшены с пояснением', async () => {
    const t = instantDone()
    const w = await mount(t)
    await pick(w, Array.from({ length: 14 }, (_, i) => file(`f${i}.pdf`)))
    expect(w.text()).toContain('Добавлено 10 из 14')
    expect(w.findAll('li').length).toBe(10)
  })

  it('ТОТ ЖЕ файл можно залить повторно после завершения прогона (#261)', async () => {
    const t = instantDone()
    const w = await mount(t)
    const again = file('one.pdf')
    await pick(w, [again])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    await pick(w, [again])
    expect(w.text()).toContain('one.pdf')
    expect(w.text()).not.toContain('уже в списке')
  })

  it('кнопка «убрать» удаляет строку до импорта', async () => {
    const t = instantDone()
    const w = await mount(t)
    await pick(w, [file('drop-me.pdf')])
    await w.find('button[aria-label="Убрать drop-me.pdf"]').trigger('click')
    await tick()
    expect(w.text()).not.toContain('drop-me.pdf')
  })

  it('во время импорта дропзона заблокирована и объясняет почему', async () => {
    let release: (v: UploadOutcome) => void = () => {}
    const upload = vi.fn(() => new Promise<UploadOutcome>((r) => {
      release = r
    }))
    const w = await mount({ upload, jobDone: () => 'done' })
    await pick(w, [file('a.pdf')])
    const running = clickText(w, 'Импортировать')
    await tick()
    expect(w.text()).toContain('Заблокировано, пока идёт импорт')
    expect(w.find('input[type="file"]').attributes('disabled')).toBeDefined()
    release(OK)
    await running
    await wait(50)
  })

  it('цель у пачки ОДНА и передаётся каждому файлу одинаковой', async () => {
    // Пикер один на пачку (owner ask). Со stubbed-пикером цель null — важно, что ОБА вызова получили
    // одно и то же значение, а не разные пер-строчные.
    const t = instantDone()
    const w = await mount(t)
    await pick(w, [file('a.pdf'), file('b.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    await tick()
    const targets = t.upload.mock.calls.map(c => (c as unknown[])[1])
    expect(new Set(targets).size).toBe(1)
  })

  it('«Отменить» будит опрос статусов — иначе результаты уже отправленных не появятся', async () => {
    const refreshNow = vi.fn(async () => {})
    const t = { upload: vi.fn(async () => OK), jobDone: vi.fn(() => null), refreshNow, listError: '' }
    const w = await mount(t)
    await pick(w, [file('first.pdf')])
    const run = clickText(w, 'Импортировать')
    await wait(50)
    await clickText(w, 'Отменить')
    await wait(400)
    await run
    expect(refreshNow).toHaveBeenCalled()
  })

  it('мёртвый опрос во время ожидания виден человеку, а не маскируется под «обрабатываем»', async () => {
    const t = { upload: vi.fn(async () => OK), jobDone: vi.fn(() => null), refreshNow: vi.fn(async () => {}), listError: 'Не удалось получить статус импорта' }
    const w = await mount(t)
    await pick(w, [file('first.pdf')])
    const run = clickText(w, 'Импортировать')
    await wait(400)
    expect(w.text()).toContain('Связь с порталом потеряна')
    await clickText(w, 'Отменить')
    await wait(400)
    await run
  })

  it('строка списка показывает размер файла', async () => {
    const t = instantDone()
    const w = await mount(t)
    await pick(w, [new File(['x'.repeat(2048)], 'big.pdf', { type: 'application/pdf' })])
    expect(w.text()).toContain('2 КБ')
  })
})

// #443. Событие «настройки изменились» широковещательное: админ поменял цель по умолчанию — оно
// прилетает всем сотрудникам портала, и их экраны должны подхватить новое значение.
//
// ⚠ Здесь тест ПОВЕДЕНЧЕСКИЙ намеренно. Проводка проверяется отдельно грепом по исходнику, и разбор
// прямо назвал цену того приёма: он видит текст, а не выполнение. Утверждения ниже — про то, что
// метод, отданный наружу через `defineExpose`, реально работает и реально пишет память вкладки:
// греп подтвердил бы наличие строки и при опечатке в имени параметра.
describe('#443: приём новой цели по умолчанию', () => {
  const DEAL = { entityTypeId: 2, categoryId: 7 }
  const key = 'ai-price-import.target.unknown'

  it('вне прогона цель применяется и уходит в память вкладки', async () => {
    window.sessionStorage.removeItem(key)
    const w = await mount(instantDone())
    ;(w.vm as unknown as { adoptSettingsTarget: (t: unknown) => void }).adoptSettingsTarget(DEAL)
    await tick()
    expect(JSON.parse(window.sessionStorage.getItem(key) ?? 'null')).toMatchObject(DEAL)
  })

  it('«Авто» очищает память — иначе настройку нельзя откатить', async () => {
    const w = await mount(instantDone())
    const vm = w.vm as unknown as { adoptSettingsTarget: (t: unknown) => void }
    vm.adoptSettingsTarget(DEAL)
    await tick()
    vm.adoptSettingsTarget(null)
    await tick()
    expect(window.sessionStorage.getItem(key)).toBeNull()
  })

  it('во время пачки цель НЕ подменяется — документы уедут туда, куда человек их отправил', async () => {
    // ⚠ Несущая проверка задачи: цель одна на пачку и заморожена. Подмена посреди прогона увела бы
    // оставшиеся файлы в другое место — молча и вопреки тому, что человек видел, когда запускал.
    window.sessionStorage.removeItem(key)
    const t = instantDone()
    // Загрузка «зависает», поэтому прогон не успевает кончиться до нашего вызова.
    t.upload = vi.fn(() => new Promise(() => {}) as never)
    const w = await mount(t)
    await pick(w, [file('накладная.pdf')])
    await clickText(w, 'Импортировать')
    await tick()
    ;(w.vm as unknown as { adoptSettingsTarget: (t: unknown) => void }).adoptSettingsTarget(DEAL)
    await tick()
    expect(window.sessionStorage.getItem(key), 'цель подменили посреди пачки').toBeNull()
  })
})
