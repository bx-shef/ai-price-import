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

mockNuxtImport('useCrmCategories', () => () => ({ load: async (etid: number) => CATS[etid] ?? [] }))
mockNuxtImport('useCrmStages', () => () => ({ load: async () => STAGES }))
mockNuxtImport('useCrmMode', () => () => ({ leadsEnabled: ref(true), load: async () => {} }))
mockNuxtImport('useCrmTypes', () => () => ({
  // 1044 = category-less SPA WITH stages («Договоры»); 1050 = SPA WITH categories.
  types: ref([
    { entityTypeId: 1044, title: 'Договоры', hasCategories: false, hasStages: true },
    { entityTypeId: 1050, title: 'Заявки', hasCategories: true, hasStages: true }
  ]),
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
