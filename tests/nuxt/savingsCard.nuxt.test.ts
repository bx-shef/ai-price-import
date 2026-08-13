// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, ref } from 'vue'
import SavingsCard from '~/components/SavingsCard.vue'

/**
 * В мобильном приложении карточки «Экономия» нет — значит нет и запроса за метриками (#507, #523).
 *
 * ⚠ Проверять надо ПОВЕДЕНИЕМ, а не наличием `v-if="!mobile"` в шаблоне: условный рендер прячет
 * РАЗМЕТКУ, но сам компонент на телефоне смонтирован. Значит `ref` со страницы на него указывает, и
 * `savingsCard.value?.reload()` после каждой пачки доходит до `useMetrics().load()` — запрос уходит
 * ради карточки, которой на экране нет. Ровно это и пропустили: первая редакция проверяла `mobile`
 * только у загрузки на монтировании, а комментарий рядом обещал, что запроса нет вовсе.
 */

const load = vi.fn()
mockNuxtImport('useMetrics', () => () => ({
  counters: ref({}),
  savings: ref(null),
  moneyBlocker: ref(null),
  resetting: ref(false),
  error: ref(''),
  load,
  reset: vi.fn()
}))

beforeEach(() => {
  load.mockClear()
})

/**
 * Хост, повторяющий проводку страницы: карточка + `ref` на неё.
 *
 * ⚠ Монтируем именно ТАК, а не саму карточку: страница зовёт `reload()` через `ref`, и проверять
 * надо этот путь. Обратиться к выставленному методу у корня, поднятого `mountSuspended`, нельзя —
 * он оборачивает компонент своим, и метод оказывается не на той вершине.
 */
function host(mobile: boolean) {
  const card = ref<{ reload: (o?: { silent?: boolean }) => void } | null>(null)
  const Host = defineComponent({
    setup: () => () => h(SavingsCard, { ref: card, busy: false, isAdmin: true, mobile })
  })
  return { Host, card }
}

describe('#523: карточка «Экономия» и мобильное приложение', () => {
  it('на компьютере метрики грузятся сами при появлении карточки', async () => {
    const { Host } = host(false)
    await mountSuspended(Host)
    expect(load).toHaveBeenCalled()
  })

  it('в мобильном приложении запроса нет ни на монтировании, ни по reload() со страницы', async () => {
    const { Host, card } = host(true)
    await mountSuspended(Host)
    expect(load, 'запрос ушёл на монтировании, хотя карточки на экране нет').not.toHaveBeenCalled()
    // Страница зовёт это после каждой пачки (#444) — и на телефоне тоже, потому что компонент
    // смонтирован. Молчать обязан сам компонент: страница про мобильный режим карточки не знает.
    expect(card.value, 'карточка не смонтирована — проверять нечего').not.toBeNull()
    card.value!.reload({ silent: true })
    expect(load, 'reload() со страницы пробил запрет — запрос ушёл ради скрытой карточки').not.toHaveBeenCalled()
  })

  it('на компьютере reload() со страницы работает — иначе метрики после пачки не обновятся', async () => {
    const { Host, card } = host(false)
    await mountSuspended(Host)
    load.mockClear()
    card.value!.reload({ silent: true })
    expect(load).toHaveBeenCalledWith({ silent: true })
  })
})
