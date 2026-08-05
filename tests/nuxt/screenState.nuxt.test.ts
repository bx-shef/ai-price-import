// @vitest-environment nuxt
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ScreenState from '~/components/ScreenState.vue'

// #408. Компонент не был покрыт НИ ОДНИМ тестом, и мутационная проверка показала цену: снятие
// `aria-hidden` с заглушки и снятие роли с сообщения об отказе проходили при полностью зелёном
// наборе — при том что оба записаны в CLAUDE.md как инварианты со ссылкой на живой дефект.

const SKELETON = { skeleton: '<div class="stub-skeleton">заглушка</div>' }

describe('#408: обёртка состояния экрана', () => {
  it('грузим: заглушка есть и скрыта от программ чтения, объявление одно', async () => {
    // ⚠ `B24Skeleton` вешает `role="alert"` на КАЖДУЮ плашку — в заглушке метрик их шестнадцать.
    // Вложенные регионы перебивают внешний, и человек слышал серию английских «loading» вместо
    // «Загружаем данные». Поэтому заглушка обязана быть вне дерева доступности.
    const w = await mountSuspended(ScreenState, { props: { loaded: false }, slots: SKELETON })
    expect(w.find('.stub-skeleton').exists()).toBe(true)
    expect(w.find('[aria-hidden="true"] .stub-skeleton').exists()).toBe(true)
    expect(w.findAll('[role="status"]')).toHaveLength(1)
    expect(w.find('[role="status"]').text()).toContain('Загружаем данные')
  })

  it('отказ: сообщение объявляется голосом и заглушки больше нет', async () => {
    // ⚠ У `B24Alert` своей роли нет — без явной исход «не удалось загрузить» не сообщался вовсе.
    const w = await mountSuspended(ScreenState, { props: { loaded: true, error: 'нет связи' }, slots: SKELETON })
    expect(w.find('.stub-skeleton').exists()).toBe(false)
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.text()).toContain('нет связи')
  })

  it('готово: показываем содержимое, а не заглушку', async () => {
    const w = await mountSuspended(ScreenState, {
      props: { loaded: true },
      slots: { ...SKELETON, default: '<p class="stub-body">данные</p>' }
    })
    expect(w.find('.stub-body').exists()).toBe(true)
    expect(w.find('.stub-skeleton').exists()).toBe(false)
  })

  it('вне портала: содержимое сразу, даже если ошибка осталась от прошлого', async () => {
    // Там запроса не было, значит и отказа быть не могло: объяснять несуществующую поломку нечем.
    const w = await mountSuspended(ScreenState, {
      props: { loaded: false, error: 'x', inert: true },
      slots: { ...SKELETON, default: '<p class="stub-body">данные</p>' }
    })
    expect(w.find('.stub-body').exists()).toBe(true)
  })
})
