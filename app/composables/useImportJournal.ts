import { ref, computed } from 'vue'
import { appendPage, nextStart, shouldLoadMore, type JournalRow } from '~/utils/journalView'
import { buildFrameHeaders, fetchErrorMessage, frameAuthMessage } from '~/utils/frameHeaders'

// Журнал импортов: загрузка страниц с сервера (#458). Реактивная обёртка над чистыми правилами
// из `journalView` — сами правила там, здесь только состояние и запрос.

export function useImportJournal() {
  const rows = ref<JournalRow[]>([])
  const loading = ref(false)
  const hasMore = ref(true)
  /** Отказ загрузки. ОТДЕЛЬНО от пустого списка: «импортов не было» и «не смогли посмотреть» —
   *  противоположные вещи, а выглядят одинаково (пустой экран). Тот же дефект чинили в #408. */
  const loadError = ref('')
  /** Первая загрузка ЗАВЕРШИЛАСЬ (успехом или отказом). Экран до этого момента не утверждает
   *  ничего — ни «пусто», ни «вот список». */
  const loaded = ref(false)

  const canLoadMore = computed(() => shouldLoadMore({ hasMore: hasMore.value, loading: loading.value, failed: !!loadError.value }))

  async function load(opts: { replace?: boolean } = {}): Promise<void> {
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
        query: { start: opts.replace ? 0 : nextStart(rows.value) },
        headers,
        retry: 0
      })
      // `replace` — перечитывание с начала: новая первая страница ЗАМЕЩАЕТ прежний список, но
      // ровно в момент, когда она уже пришла.
      rows.value = opts.replace ? (res.rows ?? []) : appendPage(rows.value, res.rows ?? [])
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

  /** Перечитать с начала — например, после нового импорта. */
  async function reload(): Promise<void> {
    // ⚠ Прежние строки НЕ стираются до прихода новых (разбор #493). Обнуление списка перед запросом
    // на мгновение опустошало множество известных заданий, а живые строки отсеиваются именно по
    // нему (#494) — уже вытесненная строка вспыхивала обратно, и человек видел свой документ
    // дважды ровно в тот момент, когда пачка завершилась и журнал перечитывался.
    hasMore.value = true
    loadError.value = ''
    await load({ replace: true })
  }

  return { rows, loading, hasMore, loadError, loaded, canLoadMore, load, retry, reload }
}
