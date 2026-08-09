// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import TargetPicker from '~/components/TargetPicker.vue'

// Portal data mocks. Smart-invoice (31) and the category-less SPA (1044) each have ONE category so the
// stage cascade can address stages; the SPA 1050 has categories → the direction picker shows.
const CATS: Record<number, Array<{ id: number, name: string }>> = {
  2: [{ id: 0, name: 'Общая' }, { id: 5, name: 'Опт' }],
  31: [{ id: 7, name: 'Общая воронка' }],
  1044: [{ id: 3, name: 'Основная' }],
  1050: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]
}
const STAGES: Array<{ id: string, name: string }> = [{ id: 'NEW', name: 'Новая' }, { id: 'WON', name: 'Успех' }]
// Управляемый флаг доступности смарт-счетов — по умолчанию доступны (как на обычном портале).
const smartInvoiceEnabled = ref(true)

mockNuxtImport('useCrmCategories', () => () => ({ load: async (etid: number) => CATS[etid] ?? [] }))
mockNuxtImport('useCrmStages', () => () => ({ load: async () => STAGES }))
mockNuxtImport('useCrmMode', () => () => ({ leadsEnabled: ref(true), load: async () => {} }))
mockNuxtImport('useCrmTypes', () => () => ({
  // 1044 = category-less SPA WITH stages («Договоры»); 1050 = SPA WITH categories.
  types: ref([
    { entityTypeId: 1044, title: 'Договоры', hasCategories: false, hasStages: true },
    { entityTypeId: 1050, title: 'Заявки', hasCategories: true, hasStages: true }
  ]),
  smartInvoiceEnabled,
  load: async () => {}
}))

const tick = () => new Promise(r => setTimeout(r))
const clickLabel = async (w: Awaited<ReturnType<typeof mountSuspended>>, label: string) => {
  await w.findAll('button').find((b: { text: () => string }) => b.text() === label)!.trigger('click')
  await tick()
  await tick()
}
const hasDirection = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.find('[aria-label="Направление (воронка)"]').exists()
const hasStage = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.find('[aria-label="Стадия"]').exists()
const lastTarget = (w: Awaited<ReturnType<typeof mountSuspended>>) => {
  const ev = w.emitted('update:target')
  return ev ? ev[ev.length - 1]![0] as Record<string, unknown> : undefined
}

describe('TargetPicker', () => {
  it('lists СПА by name (Договоры/Заявки), no raw «ID типа» input', async () => {
    const w = await mountSuspended(TargetPicker)
    await tick()
    const labels = w.findAll('button').map(b => b.text())
    expect(labels).toEqual(expect.arrayContaining(['Авто (по правилам)', 'Лид', 'Сделка', 'Смарт-счёт', 'Договоры', 'Заявки']))
    expect(w.find('input[type="number"]').exists()).toBe(false) // the B24InputNumber was removed
  })

  it('smart-invoice (31): direction HIDDEN, single category auto-used, stage shown; target has categoryId', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Смарт-счёт')
    expect(hasDirection(w)).toBe(false) // always one direction → hidden
    expect(hasStage(w)).toBe(true)
    expect(lastTarget(w)).toMatchObject({ entityTypeId: 31, categoryId: 7 }) // sole category auto-picked
  })

  it('category-less SPA with stages (Договоры): direction hidden, category auto-picked for stage addressing', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Договоры')
    expect(hasDirection(w)).toBe(false)
    expect(hasStage(w)).toBe(true)
    expect(lastTarget(w)).toMatchObject({ entityTypeId: 1044, categoryId: 3 })
  })

  it('SPA WITH categories (Заявки): direction SHOWN, NOT auto-picked', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Заявки')
    expect(hasDirection(w)).toBe(true)
    expect(lastTarget(w)).toMatchObject({ entityTypeId: 1050 })
    expect(lastTarget(w)!.categoryId).toBeUndefined() // user must choose the direction
  })

  it('deal (2): direction shown', async () => {
    const w = await mountSuspended(TargetPicker)
    await clickLabel(w, 'Сделка')
    expect(hasDirection(w)).toBe(true)
  })
})

describe('TargetPicker: недоступный тип на портале (#269)', () => {
  it('на портале без смарт-счетов вариант не показывается', async () => {
    smartInvoiceEnabled.value = false
    try {
      const w = await mountSuspended(TargetPicker)
      await tick()
      expect(w.findAll('button').some((b: { text: () => string }) => b.text() === 'Смарт-счёт')).toBe(false)
    } finally {
      smartInvoiceEnabled.value = true
    }
  })

  it('сохранённая, но исчезнувшая цель сбрасывается и объясняется — иначе импорт упал бы как раньше', async () => {
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 31 } } })
    await tick()
    smartInvoiceEnabled.value = false
    try {
      await tick()
      await tick()
      expect(w.text()).toContain('Прежняя цель больше недоступна')
      // Наружу больше не эмитится исчезнувший тип 31.
      expect(lastTarget(w)?.entityTypeId).not.toBe(31)
    } finally {
      smartInvoiceEnabled.value = true
    }
  })
})

describe('TargetPicker: блокировка на время пачки (#475)', () => {
  it('disabled — кнопки сущностей ДЕЙСТВИТЕЛЬНО выключены, а не только погашены мышью', async () => {
    // ⚠ Проверяем атрибут, а не класс обёртки. Прежний замок был `pointer-events-none` на
    // контейнере: он гасит указатель, но кнопки внутри остаются в обходе по Tab и срабатывают по
    // Enter — то есть цель пачки менялась с клавиатуры прямо во время прогона.
    const w = await mountSuspended(TargetPicker, { props: { disabled: true } })
    await tick()
    const buttons = w.findAll('button')
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every(b => b.attributes('disabled') !== undefined)).toBe(true)
  })

  it('без disabled кнопки доступны — блокировка не «всегда включена»', async () => {
    // Негативная половина: без неё тест прошёл бы и на компоненте, выключенном намертво.
    const w = await mountSuspended(TargetPicker)
    await tick()
    expect(w.findAll('button').some(b => b.attributes('disabled') !== undefined)).toBe(false)
  })

  it('disabled — выключены и списки направления со стадией', async () => {
    // Цель задаём моделью: кликнуть по сущности нельзя — кнопки уже выключены, а без выбранной
    // сущности каскад не рисует ни направления, ни стадии, и проверять было бы нечего.
    const w = await mountSuspended(TargetPicker, {
      props: { disabled: true, target: { entityTypeId: 2, categoryId: 5 } }
    })
    await tick()
    await tick()
    await tick()
    const selects = w.findAll('[aria-label="Направление (воронка)"], [aria-label="Стадия"]')
    // ⚠ Ровно два и ровно НАТИВНЫЙ `disabled`. Прежняя редакция принимала ещё `data-disabled` и
    // `aria-disabled`, а `data-disabled` reka-ui ставит ВСЕГДА — то есть тест пережил бы ровно ту
    // регрессию, ради которой написан: пропади нативный атрибут, списки снова стали бы доступны с
    // клавиатуры, а проверка осталась бы зелёной.
    expect(selects.length).toBe(2)
    for (const s of selects) expect((s.element as HTMLElement).hasAttribute('disabled')).toBe(true)
  })
})

describe('TargetPicker: цель сменили снаружи (#443)', () => {
  it('экран показывает НОВУЮ цель, а не ту, что была выбрана руками', async () => {
    // ⚠ Несущий тест, а не косметика. Локальные `etid`/`categoryId`/`stageId` сеются один раз в
    // setup, поэтому без вотчера на модель внешняя смена цели меняла бы то, КУДА УЕДЕТ ДОКУМЕНТ, не
    // трогая ни одной подсвеченной кнопки: человек видит «Сделка», документ идёт по правилам, и
    // узнаёт он об этом только из CRM.
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2 } } })
    await tick()
    await tick()
    const pressed = () => w.findAll('button').filter(b => b.attributes('aria-pressed') === 'true').map(b => b.text())
    expect(pressed()).toEqual(['Сделка'])

    // Админ сохранил настройки → сотрудник возвращается на «Авто (по правилам)».
    await w.setProps({ target: null })
    await tick()
    await tick()

    expect(pressed()).toEqual(['Авто (по правилам)'])
  })
})
