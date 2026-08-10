import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  APP_SLIDER_PLACE_SETTINGS,
  APP_SLIDER_PLACE_METRICS,
  APP_SLIDER_PLACE_MAIN,
  APP_SLIDER_ROUTES,
  sliderRouteForPlace
} from '../app/config/b24'

// ⚠ Список пишется РУКАМИ — в этом и смысл: гард «ключи карты равны списку констант» ловит дрейф
// только потому, что вторая сторона не выводится из первой. Два места стенда слайдеров (#477) стояли
// здесь наравне с рабочими и при удалении стенда честно уронили тест, показав, что уборка не
// закончена, — ровно то поведение, ради которого список не сгенерирован.
const ALL_PLACES = [
  APP_SLIDER_PLACE_SETTINGS,
  APP_SLIDER_PLACE_METRICS,
  APP_SLIDER_PLACE_MAIN
]

describe('APP_SLIDER_ROUTES / sliderRouteForPlace', () => {
  it('maps each PLACE constant to a non-empty absolute in-app route', () => {
    for (const place of ALL_PLACES) {
      const route = APP_SLIDER_ROUTES[place]
      expect(route).toBeTruthy()
      expect(route.startsWith('/')).toBe(true)
    }
  })
  it('the map keys ARE exactly the PLACE constants (no drift)', () => {
    expect(Object.keys(APP_SLIDER_ROUTES).sort()).toEqual([...ALL_PLACES].sort())
  })
  it('sliderRouteForPlace: known place → route; settings → /settings, metrics → /metrics', () => {
    expect(sliderRouteForPlace(APP_SLIDER_PLACE_SETTINGS)).toBe('/settings')
    expect(sliderRouteForPlace(APP_SLIDER_PLACE_METRICS)).toBe('/metrics')
    // Слайдер главной уводится на /app — там он опознаётся по place и второй слайдер не открывает.
    expect(sliderRouteForPlace(APP_SLIDER_PLACE_MAIN)).toBe('/app')
  })
  it('sliderRouteForPlace: unknown / empty / null / undefined → undefined (no redirect)', () => {
    expect(sliderRouteForPlace('nope')).toBeUndefined()
    expect(sliderRouteForPlace('')).toBeUndefined()
    expect(sliderRouteForPlace(null)).toBeUndefined()
    expect(sliderRouteForPlace(undefined)).toBeUndefined()
  })
})

// Композиция, которую чистая карта не покрывает: слайдер главной открывается на том же маршруте
// `/app`, поэтому единственное, что удерживает его от повторного редиректа (и от бесконечного
// открытия) — сравнение `to.path !== target` в middleware. Проверяем по исходнику: поведение
// глобального middleware иначе видно только в живом портале.
describe('middleware не редиректит на текущий маршрут (страховка от цикла #262)', () => {
  it('сравнение пути присутствует', () => {
    const src = readFileSync(new URL('../app/middleware/01.appSlider.global.ts', import.meta.url), 'utf8')
    expect(src).toContain('to.path !== target')
  })
})
