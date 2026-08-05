import { ref } from 'vue'
import { useB24 } from './useB24'
import { buildFrameHeaders, fetchErrorMessage, frameAuthMessage } from '~/utils/frameHeaders'
import type { MoneyBlocker, Savings } from '~/utils/savings'

// In-portal metrics client: read the per-portal dashboard counters + time/money-saved
// estimate, and reset them. Frame-token authenticated (member-scoped on the server).
// Inert outside a portal (no frame auth). Mirrors useImport.

export interface MetricsView { counters: Record<string, number>, savings: Savings, moneyBlocker?: MoneyBlocker | null }

export function useMetrics() {
  const { init, ensureAuth, inFrame } = useB24()
  const counters = ref<Record<string, number>>({})
  const savings = ref<Savings | null>(null)
  // Why there is no money tile (server-decided) — so the dashboard can say it instead of
  // showing nothing and leaving the admin to guess.
  const moneyBlocker = ref<MoneyBlocker | null>(null)
  const loading = ref(false)
  /**
   * Первая попытка загрузки завершилась — успехом или отказом (#408).
   *
   * ⚠ Отдельный флаг, а не `!loading`: `loading` стартует со `false`, поэтому условие на нём
   * означало бы «уже загрузили» ещё до первого запроса — а именно тогда экран и рисовал нули,
   * которые человек читал как факт о своём портале.
   */
  const loaded = ref(false)
  const resetting = ref(false)
  const error = ref('')
  /**
   * Ошибка ИМЕННО первой загрузки (#408). Отдельная от общей: `error` пишет и `reset()`, поэтому
   * неудачный сброс счётчиков прятал бы уже загруженные метрики за «Не удалось загрузить данные» —
   * данные-то загружены.
   */
  const loadError = ref('')

  async function headers(): Promise<Record<string, string> | null> {
    await init()
    return buildFrameHeaders(await ensureAuth())
  }

  /**
   * Прочитать метрики.
   *
   * `silent` — фоновое обновление после импорта (#444): экран не переводится в «грузим» и не
   * показывает отказ. Обычное чтение (открытие страницы, кнопка «Обновить») этим флагом не
   * пользуется — там человек ждёт ответа и обязан узнать, если его не будет.
   */
  async function load({ silent = false }: { silent?: boolean } = {}): Promise<void> {
    const h = await headers()
    if (!h) {
      // ⚠ Попытка ЗАВЕРШИЛАСЬ, пусть и ничем — `loaded` обязан стать true.
      //
      // Прежде здесь стоял голый `return`, и это оставляло экран в скелетоне НАВСЕГДА в самом
      // неприятном случае: сотрудник ВНУТРИ портала, но фрейм-авторизация истекла и обновиться не
      // смогла (портал ушёл на логин, рукопожатие сорвалось). `inert` там false, `loaded` false —
      // заглушка без данных, без объяснения и без реакции на «Обновить», потому что повтор шёл тем
      // же путём. До этой задачи человек видел хотя бы нули и понимал, что экран живой.
      // ⚠ Молчаливое обновление (#444) и здесь ничего не пишет: нет авторизации — просто нечего
      // обновлять. Выставить отказ значило бы стереть верные числа сообщением о поломке ровно
      // после успешного импорта, причём про авторизацию, которой минуту назад хватало.
      if (silent) return
      loaded.value = true
      error.value = frameAuthMessage(inFrame(), 'Метрики доступны')
      loadError.value = error.value
      return
    }
    // ⚠ Индикатор загрузки при молчаливом обновлении не поднимаем: он переводит экран в состояние
    // «грузим» и прячет уже показанные числа — то есть ради свежих данных на секунду отнимает те,
    // что есть. Значения заменяются по приходу ответа, нулей на экране не появляется.
    if (!silent) loading.value = true
    try {
      const res = await $fetch<MetricsView>('/api/import/metrics', { headers: h })
      counters.value = res.counters
      savings.value = res.savings
      moneyBlocker.value = res.moneyBlocker ?? null
      error.value = ''
      loadError.value = ''
    } catch (e) {
      // ⚠ Молчаливое обновление (#444) отказ НЕ показывает: перечитывание после импорта — это
      // удобство, а не запрошенное человеком действие. Показать «Не удалось получить метрики»
      // поверх только что успешно прошедшего импорта значит сообщить о поломке там, где её нет:
      // прежние числа на экране остаются верными, они просто на один импорт устарели.
      if (silent) return
      error.value = fetchErrorMessage(e, 'Не удалось получить метрики')
      loadError.value = error.value
    } finally {
      if (!silent) {
        loading.value = false
        loaded.value = true
      }
    }
  }

  /** Reset the portal's counters (operator action), then reload. Returns success. */
  async function reset(): Promise<boolean> {
    const h = await headers()
    if (!h) return false
    resetting.value = true
    try {
      await $fetch('/api/import/metrics-reset', { method: 'POST', headers: h })
      await load()
      return true
    } catch (e) {
      error.value = fetchErrorMessage(e, 'Не удалось сбросить метрики')
      return false
    } finally {
      resetting.value = false
    }
  }

  return { counters, savings, moneyBlocker, loading, loaded, resetting, error, loadError, load, reset }
}
