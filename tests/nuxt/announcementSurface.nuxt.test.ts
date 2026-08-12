// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import AnnouncementDialog from '~/components/AnnouncementDialog.vue'
import type { Announcement } from '~/utils/announcement'

// #473. ГДЕ и ЧЕМ показывается объявление издателя — и почему проверяется поведением.
//
// Все три дефекта этого файла объединяет одно: снаружи они неотличимы от исправной работы.
// Носитель выбирался по ширине окна — и на широком телефоне открывалось окно вместо шторки, хотя
// консоль оператора обещает сотруднику шторку. Предпросмотр рисовал пересказ — и оператор проверял
// данные, будучи уверен, что проверяет вид. Ни одно из этого не падает и не пишет в журнал.

const NOW = Date.parse('2026-08-12T10:00:00Z')
const sample = (over: Partial<Announcement> = {}): Announcement => ({
  id: 'a1',
  title: 'Плановые работы',
  text: 'Пятнадцатого августа с 2:00 до 4:00 импорт будет недоступен.',
  publishedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 3 * 24 * 3600 * 1000).toISOString(),
  ...over
})

// Управляемый признак мобильного клиента Битрикс24 — тот самый, что должен решать вместо ширины.
const isBitrixMobile = ref(false)
mockNuxtImport('useDevice', () => () => ({ isBitrixMobile }))

// Композабл боевого режима: в предпросмотре его трогать НЕЛЬЗЯ, и это проверяется отдельно.
const check = vi.fn(async () => {})
const dismiss = vi.fn()
mockNuxtImport('useAnnouncement', () => () => ({
  announcement: ref(null),
  open: ref(false),
  check,
  dismiss
}))
const subscribeAnnouncement = vi.fn()
mockNuxtImport('useSettingsSync', () => () => ({ subscribeAnnouncement, notifyReload: vi.fn() }))

const tick = () => new Promise(r => setTimeout(r))

describe('#473 п.4: предпросмотр — это САМО объявление, а не его пересказ', () => {
  it('в предпросмотре видно то же, что увидит сотрудник', async () => {
    // ⚠ Несущее утверждение. Консоль рисовала свою карточку — заголовок, картинку и строку
    // «Кнопка «…» → https://…». Проверить по ней можно было ДАННЫЕ, но не ВИД: помещается ли
    // заголовок в шапку, где встанут кнопки, не разъезжается ли картинка. А проверяют именно вид.
    const w = await mountSuspended(AnnouncementDialog, {
      props: { preview: sample({ linkUrl: 'https://example.com', linkLabel: 'Посмотреть' }) }
    })
    await tick()
    expect(document.body.textContent).toContain('Плановые работы')
    expect(document.body.textContent).toContain('импорт будет недоступен')
    expect(document.body.textContent, 'подпись кнопки — часть вида, а не строка «Кнопка «…»»').toContain('Посмотреть')
    expect(document.body.textContent, 'адрес ссылки сотруднику не показывают').not.toContain('https://example.com')
    w.unmount()
  })

  it('предпросмотр ИНЕРТЕН: не спрашивает сервер, не подписывается, не ставит отметку', async () => {
    // Иначе оператор, посмотрев объявление, лишил бы себя же его показа как сотрудника: отметку
    // «видел» ставит любое закрытие, и она живёт в том же браузере.
    check.mockClear()
    subscribeAnnouncement.mockClear()
    dismiss.mockClear()
    const w = await mountSuspended(AnnouncementDialog, { props: { preview: sample() } })
    await tick()
    expect(check, 'предпросмотр сходил на сервер').not.toHaveBeenCalled()
    expect(subscribeAnnouncement, 'предпросмотр подписался на живой сигнал').not.toHaveBeenCalled()
    const close = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Закрыть'))
    close?.click()
    await tick()
    expect(dismiss, 'предпросмотр поставил отметку «видел»').not.toHaveBeenCalled()
    w.unmount()
  })

  it('в боевом режиме сервер спрашивается и подписка заводится', async () => {
    // Обратная половина: инертность предпросмотра не должна выключить сам механизм.
    check.mockClear()
    subscribeAnnouncement.mockClear()
    const w = await mountSuspended(AnnouncementDialog)
    await tick()
    expect(check).toHaveBeenCalled()
    expect(subscribeAnnouncement).toHaveBeenCalled()
    w.unmount()
  })
})

describe('#473 п.3: носитель выбирает УСТРОЙСТВО, а не ширина окна', () => {
  const media = (matches: boolean) => {
    // Широкое окно: медиазапрос «уже 640» не срабатывает.
    window.matchMedia = ((q: string) => ({
      matches,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
  }

  it('мобильное приложение Битрикс24 на ШИРОКОМ экране — всё равно шторка', async () => {
    // ⚠ Ровно тот случай, ради которого правка. Ширина — свойство ОКНА, а не устройства: планшет,
    // крупный телефон в альбомной, фрейм побольше — и прежняя проверка `max-width: 639px` объявляла
    // клиент десктопом. Сотрудник получал модальное окно, хотя и компонент, и консоль оператора
    // обещают ему шторку.
    media(false)
    isBitrixMobile.value = true
    const w = await mountSuspended(AnnouncementDialog, { props: { preview: sample() } })
    await tick()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(document.body.innerHTML, 'открылось окно вместо шторки').toContain('Плановые работы')
    // Носитель различается сторонним признаком: у шторки b24ui своя обёртка, у модалки своя.
    expect(sheetShown(), 'в мобильном клиенте обязана быть шторка').toBe(true)
    isBitrixMobile.value = false
    w.unmount()
  })

  it('обычный браузер на широком экране — окно', async () => {
    media(false)
    isBitrixMobile.value = false
    const w = await mountSuspended(AnnouncementDialog, { props: { preview: sample() } })
    await tick()
    expect(sheetShown(), 'на компьютере шторка не нужна').toBe(false)
    w.unmount()
  })

  it('узкий браузер вне портала — тоже шторка', async () => {
    // Медиазапрос остаётся вторым слагаемым: на телефоне вне портала признак b24ui ложен, а
    // модальное окно там так же неудобно.
    media(true)
    isBitrixMobile.value = false
    const w = await mountSuspended(AnnouncementDialog, { props: { preview: sample() } })
    await tick()
    expect(sheetShown()).toBe(true)
    w.unmount()
  })

  it('предпросмотр показывает ОБА вида по требованию, а не тот, что достался по ширине', async () => {
    // Оператор сидит за компьютером, а половина адресатов увидит шторку — проверить её иначе негде.
    media(false)
    isBitrixMobile.value = false
    const sheet = await mountSuspended(AnnouncementDialog, { props: { preview: sample(), previewAs: 'sheet' } })
    await tick()
    expect(sheetShown()).toBe(true)
    sheet.unmount()
    await tick()
    const modal = await mountSuspended(AnnouncementDialog, { props: { preview: sample(), previewAs: 'modal' } })
    await tick()
    expect(sheetShown()).toBe(false)
    modal.unmount()
  })
})

/** Шторка ли на экране. b24ui рисует её как панель, пришпиленную к низу окна. */
function sheetShown(): boolean {
  return !!document.querySelector('[data-slideover], [role="dialog"][data-side="bottom"], .fixed.bottom-0')
}
