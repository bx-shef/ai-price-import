// @vitest-environment nuxt
import { describe, expect, it, vi } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { JournalRow } from '~/utils/journalView'

// #458/#462. Строка журнала перестроена под вид дела в таймлайне Битрикс24, и ВСЁ, ради чего это
// делалось, живёт в разметке: плитка даты, её сокрытие от программ чтения, текстовая подпись с
// годом и действие «Открыть карточку». Чистые тесты `journalView` сюда не достают — мутация
// «убрать `aria-hidden`», «убрать `v-if="tile"`» или «убрать `@click`» проходила бы при зелёном
// CI, а последняя ещё и роняет страницу на первой же нераспознанной дате.

function mountWith(rows: JournalRow[]) {
  const state = {
    rows: ref(rows),
    loading: ref(false),
    hasMore: ref(false),
    loadError: ref(''),
    loaded: ref(true),
    canLoadMore: computed(() => false),
    load: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    reload: vi.fn(async () => {})
  }
  vi.doMock('~/composables/useImportJournal', () => ({ useImportJournal: () => state }))
  return { state }
}

const row = (over: Partial<JournalRow> = {}): JournalRow => ({
  activityId: 1,
  jobId: 'job-1',
  title: 'Накладная №5.pdf',
  clean: true,
  createdAt: '2024-08-07T20:28:00+03:00',
  ownerTypeId: 4,
  ownerId: 55,
  description: '[B]Поставщик:[/B] ООО Ромашка\n[B]Позиций:[/B] 14\n[B]Сумма:[/B] 1 200,00 BYN',
  fileUrl: 'https://portal.bitrix24.by/bitrix/tools/crm_show_file.php?fileId=1',
  colorId: '4',
  ...over
})

async function render(rows: JournalRow[], props: Record<string, unknown> = {}, loaded = true) {
  vi.resetModules()
  const { state } = mountWith(rows)
  state.loaded.value = loaded
  const ImportJournal = (await import('~/components/ImportJournal.vue')).default
  return mountSuspended(ImportJournal, { props })
}

/** Живая строка идущего импорта — то, что раньше жило в отдельном списке «Последние операции». */
const live = (over: Record<string, unknown> = {}) => ({
  jobId: 'job-1',
  status: 'extracting',
  fileName: 'Накладная №5.pdf',
  result: '',
  ...over
})

describe('#462: строка журнала как дело Битрикс24', () => {
  it('дата живёт ТОЛЬКО в плитке, и она объявлена программе чтения — с годом', async () => {
    // ⚠ Строка «7 августа 2024, 20:28» под заголовком убрана (решение владельца 10.08.2026): дата
    // уже видна в плитке, а повтор словами занимал строку в каждой записи. Но плитка — три обрывка
    // («7», «авг», «20:28»), и вслух они читаются как три бессвязных числа; прежний `aria-hidden`
    // теперь означал бы, что даты для незрячих нет вовсе. Поэтому подпись переехала в `aria-label`.
    // ⚠ Год обязан быть: журнал строится из дел портала, которые ничем не чистятся, и через год
    // «7 августа» не отвечает на вопрос, когда это было.
    const w = await render([row()])
    const tile = w.find('[role="img"]')
    expect(tile.exists()).toBe(true)
    expect(tile.attributes('aria-label')).toContain('7 августа 2024, 20:28')
    // Видимого дубля больше нет — иначе правка не сделала бы ничего.
    expect(w.text()).not.toContain('7 августа 2024, 20:28')
  })

  it('нераспознанная дата → плитки НЕТ и страница не падает', async () => {
    // ⚠ Мутация `v-if="tile"` → `v-if="true"` обращается к `tile.day` на `null` и роняет весь
    // список на первой же такой строке. Тут это ловится, а в чистых тестах — нет.
    const w = await render([row({ createdAt: 'позавчера' })])
    expect(w.text()).toContain('дата неизвестна')
    expect(w.text()).toContain('Накладная №5.pdf')
  })

  it('исход подписан СЛОВАМИ, а не только цветом', async () => {
    const clean = await render([row()])
    expect(clean.text()).toContain('Без замечаний')
    const dirty = await render([row({ colorId: '7' })])
    expect(dirty.text()).toContain('С замечаниями')
  })

  it('у дела с владельцем есть действие, у дела без владельца — НЕТ кнопки в никуда', async () => {
    const withOwner = await render([row()])
    expect(withOwner.text()).toContain('Открыть карточку')
    const noOwner = await render([row({ ownerId: 0 })])
    expect(noOwner.text()).not.toContain('Открыть карточку')
  })

  it('у действия есть видимый фокус — до него можно добраться с клавиатуры', async () => {
    // ⚠ Голый `<button>` рамки фокуса не имеет: замена `B24Button` на текстовую ссылку молча
    // забрала её, и человек без мыши переставал видеть, где он находится (WCAG 2.4.7).
    const w = await render([row()])
    const btn = w.findAll('button').find(b => b.text().includes('Открыть карточку'))
    expect(btn?.classes().some(c => c.startsWith('focus-visible:'))).toBe(true)
  })
})

// #494. Двух списков об одном и том же больше нет: идущий импорт показывается В ЖУРНАЛЕ той же
// строкой, только с индикатором вместо даты, а по завершении уступает место записи о деле.
describe('#494: одна лента вместо двух списков', () => {
  it('идущий импорт виден в журнале', async () => {
    const w = await render([], { live: [live()] })
    expect(w.text()).toContain('Накладная №5.pdf')
    expect(w.text()).toContain('идёт')
  })

  it('запись журнала ВЫТЕСНЯЕТ живую строку того же задания — дубля нет', async () => {
    // ⚠ Несущее утверждение слияния. Как только импорт завершился, журнал перечитывается и та же
    // загрузка появляется в нём делом. Без отсева по идентификатору задания один документ висел бы
    // в ленте дважды — сверху «готово», ниже дело о нём же, — и это читалось бы как два импорта.
    const w = await render([row({ jobId: 'job-1', title: 'Дело по накладной' })], {
      live: [live({ jobId: 'job-1', status: 'done', result: 'ok' })]
    })
    expect(w.text()).toContain('Дело по накладной')
    expect(w.text()).not.toContain('в журнал') // подпись плитки живой строки
  })

  it('живая строка НЕ прячется под заглушкой ещё не загруженного журнала', async () => {
    // ⚠ Иначе человек нажал «Импортировать» и вместо своих строк видит серые прямоугольники, пока
    // портал отвечает на запрос журнала: загрузка истории не вправе прятать происходящее сейчас.
    const w = await render([], { live: [live()] }, false)
    expect(w.text()).toContain('Накладная №5.pdf')
  })

  it('пустое состояние молчит, пока идёт загрузка файла', async () => {
    // «Вы ещё ничего не импортировали» поверх собственной загрузки — прямая ложь о состоянии.
    const w = await render([], { uploading: true })
    expect(w.text()).not.toContain('Вы ещё ничего не импортировали')
    expect(w.text()).toContain('Отправляем файл…')
  })
})
