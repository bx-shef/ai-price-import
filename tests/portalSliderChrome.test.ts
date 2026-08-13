import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Экраны, открываемые слайдером портала, носят нижнюю панель действий (#523).
 *
 * ЗАЧЕМ. `/settings` и `/metrics` человек видит как ОКНО поверх работы, а не как страницу. У
 * штатного `B24Slideover` действия живут в нижней панели; у нас они стояли в конце содержимого — на
 * настройках это около двух тысяч пикселей прокрутки, и правивший первое поле до «Сохранить» не
 * доходил. Гард держит две вещи: панель на месте и действия внутри неё, а не рядом.
 *
 * ⚠ Проверка структурная (по тексту SFC), и это осознанный размен: смонтировать эти экраны нельзя
 * без фрейм-токена и портала. Зато мутации, которые она ловит, — ровно те, что случаются: вынести
 * кнопку обратно в поток, забыть панель на одном из двух экранов, подменить токены поверхности
 * своими цветами.
 */

const ROOT = new URL('..', import.meta.url).pathname
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
const strip = (sfc: string) => sfc.slice(sfc.indexOf('<template>')).replace(/<!--[\s\S]*?-->/g, '')

/** Содержимое панели действий на экране — чтобы проверять, что кнопка ВНУТРИ неё. */
function actionsBlock(sfc: string): string {
  const t = strip(sfc)
  const open = t.indexOf('<SliderActions')
  const close = t.indexOf('</SliderActions>')
  expect(open, 'на экране нет панели действий <SliderActions>').toBeGreaterThan(-1)
  expect(close, 'панель действий не закрыта').toBeGreaterThan(open)
  return t.slice(open, close)
}

describe('#523: панель действий у экранов, открытых слайдером', () => {
  // ⚠ Берём РАЗМЕТКУ без комментариев: в шапке компонента объяснено, почему здесь неприменим
  // `absolute inset-x-0 bottom-0`, и гард, краснеющий на объяснении дефекта, подталкивает удалить
  // объяснение, а не дефект. Тот же приём — в гардах замка экрана и имени продукта.
  const shell = strip(read('app/components/SliderActions.vue'))

  it('панель повторяет поверхность штатного слайдера, а не красится своими цветами', () => {
    // Значения взяты из темы b24ui (`src/theme/slideover.ts`, слот `footer`). Подмена на свой цвет
    // или на подложку страницы — ровно то, что делает окно «не из портала».
    expect(shell).toMatch(/bg-\(--ui-color-bg-content-primary\)/)
    expect(shell).toMatch(/border-t border-\(--ui-color-divider-less\)/)
    expect(shell).toMatch(/shadow-top-md/)
  })

  it('панель прилипает к низу, а не просто идёт следом за содержимым', () => {
    // ⚠ `sticky`, а не `absolute`: наш экран — отдельный документ во фрейме, высоту которого портал
    // подбирает по содержимому, и `absolute bottom-0` прилип бы к низу СОДЕРЖИМОГО.
    expect(shell).toMatch(/sticky bottom-0/)
    expect(shell, 'absolute здесь неприменим — см. шапку компонента').not.toMatch(/absolute inset-x-0 bottom-0/)
  })

  for (const [screen, label] of [
    ['app/pages/settings.vue', 'Сохранить'],
    ['app/pages/metrics.vue', 'Обновить']
  ] as const) {
    it(`${screen}: «${label}» стоит в панели действий`, () => {
      expect(actionsBlock(read(screen))).toContain(label)
    })
  }

  it('«Сохранить» больше не живёт в потоке содержимого', () => {
    // Мутация «вернуть кнопку в конец формы» обязана краснеть: именно из-за этого её и не находили.
    const t = strip(read('app/pages/settings.vue'))
    const inside = actionsBlock(read('app/pages/settings.vue'))
    const total = t.split('Сохраняем…').length - 1
    const within = inside.split('Сохраняем…').length - 1
    expect(within, 'кнопка сохранения вне панели действий').toBe(total)
  })
})

describe('#523: акцентный цвет не тратится на шапки разделов', () => {
  // `variant="tinted"` у `B24PageCard` — АКЦЕНТНАЯ (синяя) плашка. Ею были покрашены шапки всех
  // разделов настроек и метрик: акцент, которым помечено всё, перестаёт что-либо выделять, а экран
  // читается как набор информационных врезок. Нейтральная `tinted-no-accent` оставляет синий тем
  // местам, где он действительно что-то значит.
  for (const screen of ['app/pages/settings.vue', 'app/pages/metrics.vue']) {
    it(`${screen}: шапки разделов нейтральные`, () => {
      expect(strip(read(screen)), 'акцентная плашка вернулась в шапку раздела').not.toMatch(/variant="tinted"/)
    })
  }
})
