import { ref, computed } from 'vue'
import type { JournalRow } from '~/utils/journalView'
import { JOURNAL_PAGE_SIZE } from '~/config/journal'
import { buildFrameHeaders, fetchErrorMessage, frameAuthMessage } from '~/utils/frameHeaders'

// Журнал импортов: загрузка страниц с сервера (#458). Реактивная обёртка над чистыми правилами
// из `journalView` — сами правила там, здесь только состояние и запрос.

export function useImportJournal() {
  const rows = ref<JournalRow[]>([])
  /** Номер показанной страницы, с нуля. Постранично, а не подкачкой (#495). */
  const page = ref(0)
  const loading = ref(false)
  const hasMore = ref(true)
  /** Отказ загрузки. ОТДЕЛЬНО от пустого списка: «импортов не было» и «не смогли посмотреть» —
   *  противоположные вещи, а выглядят одинаково (пустой экран). Тот же дефект чинили в #408. */
  const loadError = ref('')
  /** Первая загрузка ЗАВЕРШИЛАСЬ (успехом или отказом). Экран до этого момента не утверждает
   *  ничего — ни «пусто», ни «вот список». */
  const loaded = ref(false)

  /** Есть ли предыдущая/следующая страница — этим и живут кнопки навигации. */
  const canPrev = computed(() => page.value > 0 && !loading.value)
  const canNext = computed(() => hasMore.value && !loading.value && !loadError.value)

  async function load(): Promise<void> {
    // ⚠ Проверка ЗДЕСЬ, а не только у наблюдателя прокрутки: кнопку «Показать ещё» человек может
    // нажать дважды подряд, и без этого портал получил бы два одинаковых запроса.
    if (loading.value) return
    loading.value = true
    loadError.value = ''
    try {
      const { auth, inFrame } = useB24()
      const headers = buildFrameHeaders(auth())
      // ⚠ Вне портала фрейм-токена нет и не будет — попытка ЗАВЕРШАЕТСЯ честной причиной, а не
      // голым выходом: иначе экран остался бы в заглушке навсегда (#408), в том числе у
      // сотрудника ВНУТРИ портала, чья часовая авторизация истекла.
      if (!headers) {
        loadError.value = frameAuthMessage(inFrame(), 'Журнал импортов доступен')
        hasMore.value = false
        return
      }
      const res = await $fetch<{ rows: JournalRow[], hasMore: boolean }>('/api/import/journal', {
        // При перечитывании берём ПЕРВУЮ страницу, не продолжение: список замещается целиком.
        // Страница адресуется НОМЕРОМ, а не длиной показанного списка: при постраничной навигации
        // список каждый раз замещается, и «сколько уже показано» перестало отвечать на вопрос «где
        // мы находимся» — на второй странице оно снова равно нулю.
        query: { start: page.value * JOURNAL_PAGE_SIZE },
        headers,
        retry: 0
      })
      // Страница ЗАМЕЩАЕТ прежнюю — но ровно в момент, когда она уже пришла: обнуление до запроса
      // на мгновение опустошало множество известных заданий, по которому отсеиваются живые строки
      // (#494), и уже вытесненная строка вспыхивала обратно.
      rows.value = res.rows ?? []
      hasMore.value = !!res.hasMore
    } catch (e) {
      loadError.value = fetchErrorMessage(e, 'Не удалось загрузить журнал импортов.')
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  /** Повтор после отказа: снимает ошибку и пробует ту же страницу заново. */
  async function retry(): Promise<void> {
    loadError.value = ''
    await load()
  }

  /** Соседняя страница. Отрицательный номер невозможен — кнопка выключена, но правило здесь. */
  async function goto(next: number): Promise<void> {
    if (loading.value) return
    page.value = Math.max(0, next)
    await load()
  }

  /** Перечитать с начала — например, после нового импорта. */
  async function reload(): Promise<void> {
    // ⚠ Прежние строки НЕ стираются до прихода новых (разбор #493). Обнуление списка перед запросом
    // на мгновение опустошало множество известных заданий, а живые строки отсеиваются именно по
    // нему (#494) — уже вытесненная строка вспыхивала обратно, и человек видел свой документ
    // дважды ровно в тот момент, когда пачка завершилась и журнал перечитывался.
    // ⚠ Перечитываем ТОЛЬКО первую страницу. Человек, читающий третью (то есть старые импорты),
    // не должен телепортироваться в начало из-за того, что где-то доработалась пачка: новой записи
    // на его странице всё равно нет, а место чтения он теряет (разбор #495). На первой странице
    // перечитывание обязательно — иначе только что законченный импорт не появится вовсе.
    if (page.value !== 0) return
    hasMore.value = true
    loadError.value = ''
    await load()
  }

  return { rows, loading, hasMore, loadError, loaded, page, canPrev, canNext, load, goto, retry, reload }
}
