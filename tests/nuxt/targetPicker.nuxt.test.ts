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

// #488. Исчезнувшие направление и стадию раньше дочищали МОЛЧА: поле показывало другое значение без
// объяснения, а следующая пачка уходила не туда, куда человек рассчитывал. Теперь пикер уводит выбор
// в «Авто» и ОБЪЯВЛЯЕТ причину наверх — там её показывают сообщением.
//
// ⚠ Гарантия ПОВЕДЕНЧЕСКАЯ, и это выяснилось разбором: мутации «убрать вызов `failToAuto`» и
// «перенести проверку ПОСЛЕ тихой дочистки» проходили бесследно — про этот путь не было ни одного
// теста, вся гарантия жила в комментариях.
describe('TargetPicker: исчезнувший маршрут объявляется, а не дочищается молча (#488)', () => {
  it('удалённое НАПРАВЛЕНИЕ → «Авто» + событие с причиной', async () => {
    // У сделки на портале направления 0 и 5; сохранено 42 — его удалили.
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 42 } } })
    await tick()
    await tick()
    expect(w.emitted('invalid')?.[0]?.[0], 'причина не объявлена — человек не узнает, почему сменилась цель').toBe('category')
    expect(lastTarget(w), 'выбор обязан уехать в «Авто»').toBeNull()
  })

  it('удалённая СТАДИЯ → «Авто» + событие с причиной', async () => {
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 5, stageId: 'GONE' } } })
    await tick()
    await tick()
    expect(w.emitted('invalid')?.[0]?.[0]).toBe('stage')
    expect(lastTarget(w)).toBeNull()
  })

  it('годный маршрут молчит — ложная тревога хуже задержки', async () => {
    const w = await mountSuspended(TargetPicker, { props: { target: { entityTypeId: 2, categoryId: 5, stageId: 'NEW' } } })
    await tick()
    await tick()
    expect(w.emitted('invalid')).toBeUndefined()
  })
})
